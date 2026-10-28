// The Cloudflare R2 store. Nothing here touches the network: URLs are signed offline with fake credentials, and the
// read/delete paths use a stubbed client.

import { readFileSync } from "node:fs";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { describe, expect, it, vi } from "vitest";
import { R2ObjectStore, createR2Client, createR2ObjectStore, r2Endpoint } from "../src/lib/r2-object-store.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const credentials = { accountId: ACCOUNT, accessKeyId: "AKIDEXAMPLE", secretAccessKey: "example-secret-for-tests-only", bucket: "example-bucket" };
const KEY = "org/org_test_a/vehicles/v1/photos/11111111-1111-1111-1111-111111111111-front.jpg";

describe("the endpoint is always the R2 hostname for the account id", () => {
  it("r2Endpoint derives https://<account id>.r2.cloudflarestorage.com", () => {
    expect(r2Endpoint(ACCOUNT)).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(r2Endpoint(ACCOUNT.toUpperCase())).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
  });

  it.each([
    "",
    "short",
    `${ACCOUNT}.evil.example`,
    `${ACCOUNT}/path`,
    `${ACCOUNT}@evil.example`,
    ` ${ACCOUNT}`,
    `${ACCOUNT}0`,
    "g123456789abcdef0123456789abcdef",
    "s3.amazonaws.com",
    "localhost",
  ])("refuses an account id that is not 32 hex characters (%j)", (id) => {
    expect(() => r2Endpoint(id)).toThrow("Invalid R2 account id.");
    expect(() => createR2Client({ ...credentials, accountId: id })).toThrow();
  });

  it("the real client resolves to the R2 host, region auto, and NEVER an AWS host", async () => {
    const client = createR2Client(credentials);
    const endpoint = await client.config.endpoint!();
    expect(endpoint.hostname).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(endpoint.protocol).toBe("https:");
    expect(await client.config.region()).toBe("auto");
    expect(endpoint.hostname).not.toMatch(/amazonaws/);
  });

  it("the source never names an AWS endpoint", () => {
    const source = readFileSync(path.join(import.meta.dirname, "..", "src", "lib", "r2-object-store.ts"), "utf8");
    const code = source.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(code).not.toMatch(/amazonaws/i);
    expect(code).toContain("r2.cloudflarestorage.com");
    expect(code).toContain('region: "auto"');
  });
});

describe("checksum compatibility: no extra checksum headers are required", () => {
  it("both checksum settings are WHEN_REQUIRED", async () => {
    const client = createR2Client(credentials);
    expect(await client.config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
    expect(await client.config.responseChecksumValidation()).toBe("WHEN_REQUIRED");
  });

  async function presignedPut(store: R2ObjectStore) {
    return new URL(await store.presignPut({ key: KEY, contentType: "image/jpeg", contentLength: 123_456, expiresInSeconds: 300 }));
  }

  it("a presigned upload URL signs only host, content-length and content-type: no checksum parameters, no x-amz-* headers", async () => {
    const url = await presignedPut(createR2ObjectStore(credentials));
    const signedHeaders = (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";").sort();
    expect(signedHeaders).toEqual(["content-length", "content-type", "host"]);
    const names = [...url.searchParams.keys()].map((n) => n.toLowerCase());
    expect(names.filter((n) => n.includes("checksum"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("x-amz-") && !["x-amz-algorithm", "x-amz-credential", "x-amz-date", "x-amz-expires", "x-amz-signedheaders", "x-amz-signature", "x-amz-content-sha256"].includes(n))).toEqual([]);
  });

  it("the URL is on the R2 host, path-style with the bucket and key, valid for 300 seconds", async () => {
    const url = await presignedPut(createR2ObjectStore(credentials));
    expect(url.host).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/example-bucket/${KEY}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  });

  it("CONTROL: the SDK default (without WHEN_REQUIRED) does add a checksum, so the assertions above can fail", async () => {
    const plain = new S3Client({
      region: "auto",
      endpoint: r2Endpoint(ACCOUNT),
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "example-secret-for-tests-only" },
    });
    const url = new URL(
      await getSignedUrl(plain, new PutObjectCommand({ Bucket: "example-bucket", Key: KEY, ContentType: "image/jpeg", ContentLength: 123_456 }), { expiresIn: 300 })
    );
    const asText = decodeURIComponent(url.search).toLowerCase();
    // Either a checksum query parameter or a signed checksum header shows up with the default settings.
    expect(asText.includes("checksum") || (url.searchParams.get("X-Amz-SignedHeaders") ?? "").includes("checksum")).toBe(true);
  });

  it("the content type and length are bound to the signature: changing either gives a different signature", async () => {
    const store = createR2ObjectStore(credentials);
    const a = await store.presignPut({ key: KEY, contentType: "image/jpeg", contentLength: 100, expiresInSeconds: 300 });
    const sameDay = (u: string) => new URL(u).searchParams.get("X-Amz-Signature");
    const b = await store.presignPut({ key: KEY, contentType: "image/png", contentLength: 100, expiresInSeconds: 300 });
    const c = await store.presignPut({ key: KEY, contentType: "image/jpeg", contentLength: 101, expiresInSeconds: 300 });
    expect(new Set([sameDay(a), sameDay(b), sameDay(c)]).size).toBe(3);
  });
});

describe("reading and deleting (stubbed client)", () => {
  const fakeClient = (send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>) =>
    ({ send }) as unknown as S3Client;

  it("getObject asks for exactly the bucket, key and If-None-Match it was given", async () => {
    const send = vi.fn(async () => ({ Body: "stream", ContentLength: 7, ETag: '"abc"' }));
    const store = new R2ObjectStore(fakeClient(send as never), "example-bucket");
    const result = await store.getObject({ key: KEY, ifNoneMatch: '"abc"' });
    expect(result).toMatchObject({ kind: "found", contentLength: 7, etag: '"abc"' });
    const command = (send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0];
    expect(command.input).toEqual({ Bucket: "example-bucket", Key: KEY, IfNoneMatch: '"abc"' });
  });

  it("maps 304 to notModified and 404 to missing; anything else is thrown", async () => {
    const make = (error: unknown) => new R2ObjectStore(fakeClient(async () => Promise.reject(error) as never), "example-bucket");
    expect(await make({ name: "NotModified", $metadata: { httpStatusCode: 304 } }).getObject({ key: KEY, ifNoneMatch: '"x"' })).toEqual({ kind: "notModified", etag: '"x"' });
    expect(await make({ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }).getObject({ key: KEY })).toEqual({ kind: "missing" });
    await expect(make({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }).getObject({ key: KEY })).rejects.toMatchObject({ name: "AccessDenied" });
  });

  it("an empty body is treated as missing", async () => {
    const store = new R2ObjectStore(fakeClient(async () => ({ ETag: '"a"' })), "example-bucket");
    expect(await store.getObject({ key: KEY })).toEqual({ kind: "missing" });
  });

  it("putObject writes exactly one key with its content type", async () => {
    const send = vi.fn(async () => ({}));
    await new R2ObjectStore(fakeClient(send as never), "example-bucket").putObject({ key: KEY, body: Buffer.from("x"), contentType: "image/jpeg" });
    const command = (send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0];
    expect(command.input).toMatchObject({ Bucket: "example-bucket", Key: KEY, ContentType: "image/jpeg" });
  });

  it("deleteKey deletes exactly one key in the configured bucket", async () => {
    const send = vi.fn(async () => ({}));
    await new R2ObjectStore(fakeClient(send as never), "example-bucket").deleteKey(KEY);
    const command = (send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0];
    expect(command.input).toEqual({ Bucket: "example-bucket", Key: KEY });
  });
});
