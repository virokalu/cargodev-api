// Cloudflare R2 behind the ObjectStore interface.
//
// R2 is reached through its S3-compatible API, so this uses the AWS SDK for JavaScript v3 (@aws-sdk/client-s3 and
// @aws-sdk/s3-request-presigner). Three settings matter and are covered by tests:
//   1. endpoint https://<account id>.r2.cloudflarestorage.com and region "auto": the client NEVER falls back to an AWS
//      endpoint (the account id is validated, so nothing else can end up in the hostname);
//   2. requestChecksumCalculation and responseChecksumValidation are "WHEN_REQUIRED": SDK versions since 3.729 add a
//      CRC32 checksum header to uploads by default, which R2 does not accept as a FULL_OBJECT checksum, and presigned
//      URLs would then demand headers a plain HTTP client does not send;
//   3. only content-type and content-length are signed for uploads, nothing else is required of the uploader.

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";
import type { ObjectStore, StoredObject } from "./object-storage.js";

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

/** The one hostname the store talks to. Throws for anything that is not a Cloudflare account id. */
export function r2Endpoint(accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error("Invalid R2 account id.");
  return `https://${accountId.toLowerCase()}.r2.cloudflarestorage.com`;
}

export function createR2Client(credentials: R2Credentials): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(credentials.accountId),
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
    // https://<account id>.r2.cloudflarestorage.com/<bucket>/<key>: the host stays exactly the account host.
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export class R2ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string
  ) {}

  async presignPut(args: { key: string; contentType: string; contentLength: number; expiresInSeconds: number }): Promise<string> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: args.key, ContentType: args.contentType, ContentLength: args.contentLength });
    return getSignedUrl(this.client, command, {
      expiresIn: args.expiresInSeconds,
      // Signed (so the upload must match them exactly) and nothing else.
      signableHeaders: new Set(["content-type", "content-length"]),
    });
  }

  async getObject(args: { key: string; ifNoneMatch?: string; range?: string }): Promise<StoredObject> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: args.key,
          ...(args.ifNoneMatch ? { IfNoneMatch: args.ifNoneMatch } : {}),
          ...(args.range ? { Range: args.range } : {}),
        })
      );
      if (!response.Body) return { kind: "missing" };
      return {
        kind: "found",
        body: response.Body as Readable,
        contentLength: typeof response.ContentLength === "number" ? response.ContentLength : null,
        etag: response.ETag ?? null,
        contentRange: response.ContentRange ?? null,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (error as { name?: string }).name;
      if (status === 304 || name === "NotModified") return { kind: "notModified", etag: args.ifNoneMatch ?? null };
      if (status === 404 || name === "NoSuchKey" || name === "NotFound") return { kind: "missing" };
      if (status === 416 || name === "InvalidRange") return { kind: "rangeNotSatisfiable" };
      throw error;
    }
  }

  async putObject(args: { key: string; body: Buffer; contentType: string }): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: args.key, Body: args.body, ContentType: args.contentType }));
  }

  async deleteKey(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createR2ObjectStore(credentials: R2Credentials): R2ObjectStore {
  return new R2ObjectStore(createR2Client(credentials), credentials.bucket);
}
