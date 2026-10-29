// Temporary file links on our own domain: issuing them, and checking one on every fetch.
//
// ISSUING (issueFileLink) happens only AFTER the endpoint's normal authorization (a staff route's role list and org scoping).
// A link is a signed ticket, not the authorization. OPENING (openFileLink) therefore re-checks everything in the DATABASE on every
// single fetch, in this order, and any failure is the same single result (null: the route answers one identical 404):
//   1. the link has exactly the expected shape, 2. the signature matches the current or the previous secret (constant-time),
//   3. it has not expired (30 s skew) and was not issued further ahead than the cap allows,
//   4. the person is still allowed: a staff user is still active in that org (getFreshStaffAuth); a customer account is still
//      active and the file is still released to them by the SAME rules as the customer file gateway,
//   5. the row exists in that org, the vehicle is not deleted, the stored address maps to a key inside the org's folder, and the type
//      is on the allowlist for the kind,
//   6. ONLY THEN is the object store touched.
// Revoking access (un-releasing a file, deactivating a user, deleting a vehicle) therefore applies to links already handed out.

import { Transform, type Readable } from "node:stream";
import { loadEnv } from "../config/env.js";
import { expiryRefused, parseLinkParts, signatureMatches, signParts, type FileLinkAudience, type FileLinkKind, type FileLinkParts, type FileLinkVariant } from "../lib/file-link.js";
import { findActiveCustomer } from "../lib/customer-access.js";
import { ServiceError } from "../lib/errors.js";
import { contentTypeForKey, isImageType, keyFromOwnedUrlForOrg, requireStore, thumbKeyFor, type AllowedContentType } from "../lib/object-storage.js";
import { getPrisma } from "../lib/prisma.js";
import { UPLOAD_LIMITS } from "../validation/upload.schema.js";
import { authorizeCustomerFile, contentDispositionFor, quoteEtag } from "./customer-file-access.service.js";
import { getFreshStaffAuth } from "./staff-auth-state.service.js";

export interface LinkContext {
  orgId: string;
  userId: string;
  audience: FileLinkAudience;
}

/** A link on our own domain is possible only when both the secret and the base address are configured. */
export function fileLinksEnabled(): boolean {
  const env = loadEnv();
  return Boolean(env.FILE_LINK_SECRET && env.FILE_LINK_BASE_URL);
}

export interface IssuedFileLink {
  url: string;
  expiresAt: string;
}

/**
 * A signed link for one file, for one person, for FILE_LINK_TTL_SECONDS. Call it only after the endpoint's own authorization.
 * Null when links are not configured. The link holds ids only: no object key, no bucket, no storage host, no account id.
 */
export function issueFileLink(context: LinkContext, kind: FileLinkKind, id: string, variant: FileLinkVariant, nowMs: number = Date.now()): IssuedFileLink | null {
  const env = loadEnv();
  if (!env.FILE_LINK_SECRET || !env.FILE_LINK_BASE_URL) return null;
  const ttl = Math.min(env.FILE_LINK_TTL_SECONDS, env.FILE_LINK_MAX_TTL_SECONDS);
  const exp = Math.floor(nowMs / 1000) + ttl;
  const parts: FileLinkParts = { kind, id, variant, orgId: context.orgId, userId: context.userId, audience: context.audience, exp };
  const sig = signParts(env.FILE_LINK_SECRET, parts);
  const base = env.FILE_LINK_BASE_URL.replace(/\/+$/, "");
  return {
    url: `${base}/f/v1/${kind}/${id}/${variant}?o=${context.orgId}&u=${context.userId}&a=${context.audience}&exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------

export type OpenedFileLink =
  | { status: 304; etag: string | null; maxAgeSeconds: number }
  | {
      status: 200 | 206;
      body: Readable;
      contentType: AllowedContentType;
      contentDisposition: string;
      contentLength: number | null;
      contentRange: string | null;
      etag: string | null;
      acceptRanges: boolean;
      maxAgeSeconds: number;
    }
  | { status: 416 };

interface Authorized {
  key: string;
  contentType: AllowedContentType;
  displayName: string | null;
}

/** The longest a browser may keep a link's answer: the link's own remaining life, and never more than five minutes. */
const MAX_BROWSER_CACHE_SECONDS = 300;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A staff member's file: in THEIR org, the vehicle not deleted, the address inside the org's folder, the type right for the kind. */
async function authorizeStaffFile(orgId: string, kind: FileLinkKind, id: string): Promise<Authorized | null> {
  const prisma = getPrisma();
  let stored: string | null = null;
  let displayName: string | null = null;
  if (kind === "photo") {
    stored = (await prisma.vehiclePhoto.findFirst({ where: { id, vehicle: { org_id: orgId, deletedAt: null } }, select: { url: true } }))?.url ?? null;
  } else if (kind === "document") {
    const row = await prisma.vehicleDocument.findFirst({ where: { id, vehicle: { org_id: orgId, deletedAt: null } }, select: { url: true, name: true } });
    stored = row?.url ?? null;
    displayName = row?.name ?? null;
  } else {
    stored = (await prisma.vehicle.findFirst({ where: { id, org_id: orgId, deletedAt: null }, select: { auctionSheetUrl: true } }))?.auctionSheetUrl ?? null;
  }
  const key = stored ? keyFromOwnedUrlForOrg(orgId, stored) : null;
  const contentType = key ? contentTypeForKey(key) : null;
  if (!key || !contentType) return null;
  if (kind === "document" ? contentType !== "application/pdf" : !isImageType(contentType)) return null;
  return { key, contentType, displayName };
}

/** A customer's file, by exactly the rules of the customer file gateway (their vehicle, released, export track, allowed type). */
async function authorizeCustomerFileForLink(orgId: string, userId: string, kind: FileLinkKind, id: string): Promise<Authorized | null> {
  if (kind === "auction-sheet") return null; // customers never receive an auction sheet
  if (!(await findActiveCustomer(userId, orgId))) return null;
  try {
    return await authorizeCustomerFile({ id: userId, orgId }, kind, id);
  } catch (error) {
    if (error instanceof ServiceError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/** One range, as the store wants it ("bytes=0-99"), or null: several ranges, a malformed one, or none are ignored (the whole file is sent). */
export function parseSingleRange(header: string | undefined): string | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] !== "" && match[2] !== "" && Number(match[1]) > Number(match[2])) return null;
  return `bytes=${match[1]}-${match[2]}`;
}

/** Wraps a stream whose length is unknown so it can never deliver more than `max` bytes. */
function capStream(body: Readable, max: number): Readable {
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > max) callback(new Error("file too large"));
      else callback(null, chunk);
    },
  });
  body.on("error", (error) => limiter.destroy(error));
  limiter.on("close", () => body.destroy());
  return body.pipe(limiter);
}

const SIZE_CAP: Record<FileLinkKind, number> = {
  photo: UPLOAD_LIMITS.VEHICLE_PHOTO.maxBytes,
  "auction-sheet": UPLOAD_LIMITS.AUCTION_SHEET.maxBytes,
  document: UPLOAD_LIMITS.VEHICLE_DOCUMENT.maxBytes,
};

/**
 * Checks a link and, if every check holds, reads the object. Returns null for EVERY failure (a bad shape, a forged or tampered
 * signature, an expired or too-far-ahead link, a person no longer allowed, a file that is gone or hidden, a missing object): the
 * route answers one identical 404 whatever the reason.
 */
export async function openFileLink(
  params: Record<string, unknown>,
  query: Record<string, unknown>,
  options: { nowMs?: number; ifNoneMatch?: string; rangeHeader?: string } = {}
): Promise<OpenedFileLink | null> {
  const env = loadEnv();
  const secrets = [env.FILE_LINK_SECRET, env.FILE_LINK_SECRET_PREVIOUS].filter((s): s is string => typeof s === "string" && s !== "");
  if (secrets.length === 0) return null;

  // 1-2. shape, then signature
  const parsed = parseLinkParts(params, query);
  if (!parsed) return null;
  const { sig, ...parts } = parsed;
  if (!signatureMatches(parts, sig, secrets)) return null;

  // 3. expiry
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (expiryRefused(parts.exp, nowSeconds, env.FILE_LINK_MAX_TTL_SECONDS)) return null;
  if (!ID.test(parts.id)) return null;

  // 4-5. the person and the file, from the database, every time
  let file: Authorized | null;
  if (parts.audience === "staff") {
    if (!(await getFreshStaffAuth(parts.userId, parts.orgId))) return null;
    file = await authorizeStaffFile(parts.orgId, parts.kind, parts.id);
  } else {
    file = await authorizeCustomerFileForLink(parts.orgId, parts.userId, parts.kind, parts.id);
  }
  if (!file) return null;
  // A document has one version only; a link for its "thumb" was never issued by us.
  if (parts.kind === "document" && parts.variant !== "full") return null;

  // 6. the object
  let store;
  try {
    store = requireStore();
  } catch {
    return null;
  }
  const maxAgeSeconds = Math.max(0, Math.min(parts.exp - nowSeconds, MAX_BROWSER_CACHE_SECONDS));
  const isPdf = file.contentType === "application/pdf";
  const range = isPdf ? parseSingleRange(options.rangeHeader) : null;
  const conditional = options.ifNoneMatch && !range ? { ifNoneMatch: options.ifNoneMatch } : {};
  const rangeArg = range ? { range } : {};

  let result = { kind: "missing" } as Awaited<ReturnType<typeof store.getObject>>;
  const thumbKey = parts.kind === "photo" && parts.variant === "thumb" ? thumbKeyFor(file.key) : null;
  if (thumbKey) result = await store.getObject({ key: thumbKey, ...conditional });
  if (result.kind === "missing") result = await store.getObject({ key: file.key, ...conditional, ...rangeArg });

  if (result.kind === "missing") return null;
  if (result.kind === "rangeNotSatisfiable") return { status: 416 };
  if (result.kind === "notModified") return { status: 304, etag: quoteEtag(result.etag), maxAgeSeconds };

  const cap = SIZE_CAP[parts.kind];
  if (result.contentLength !== null && result.contentLength > cap) {
    result.body.destroy();
    return null;
  }
  const partial = Boolean(range && result.contentRange);
  return {
    status: partial ? 206 : 200,
    body: result.contentLength === null ? capStream(result.body, cap) : result.body,
    contentType: file.contentType,
    contentDisposition: contentDispositionFor(file.contentType, file.displayName),
    contentLength: result.contentLength,
    contentRange: partial ? (result.contentRange ?? null) : null,
    etag: quoteEtag(result.etag),
    acceptRanges: isPdf,
    maxAgeSeconds,
  };
}

