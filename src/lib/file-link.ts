// Temporary file links on our own domain: the pure part (building the signed text, checking it). No database, no storage.
//
//   <FILE_LINK_BASE_URL>/f/v1/<kind>/<id>/<variant>?o=<org>&u=<user>&a=<staff|customer>&exp=<unix seconds>&sig=<base64url>
//
//   kind     photo | document | auction-sheet        id       the DATABASE id (the vehicle's id for an auction sheet), never a key
//   variant  thumb | full                            sig      HMAC-SHA256 over the exact string  v1|kind|id|variant|o|u|a|exp
//
// Nothing in a link reveals an object key, a bucket, a storage host or the account id. The signature says "this API issued this
// link to this user until this time"; it is NOT the authorization: every fetch re-checks the database (file-link.service.ts).

import { createHmac, timingSafeEqual } from "node:crypto";

export const FILE_LINK_KINDS = ["photo", "document", "auction-sheet"] as const;
export type FileLinkKind = (typeof FILE_LINK_KINDS)[number];
export const FILE_LINK_VARIANTS = ["thumb", "full"] as const;
export type FileLinkVariant = (typeof FILE_LINK_VARIANTS)[number];
export const FILE_LINK_AUDIENCES = ["staff", "customer"] as const;
export type FileLinkAudience = (typeof FILE_LINK_AUDIENCES)[number];

/** How far a clock may be off, in seconds, in either direction. */
export const CLOCK_SKEW_SECONDS = 30;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
// No leading zeros: one ticket must have exactly one way of being written (otherwise "01893..." and "1893..." would sign alike).
const EXP = /^[1-9]\d{0,11}$/;
const SIG = /^[A-Za-z0-9_-]{43}$/; // base64url of a 32-byte HMAC

export interface FileLinkParts {
  kind: FileLinkKind;
  id: string;
  variant: FileLinkVariant;
  orgId: string;
  userId: string;
  audience: FileLinkAudience;
  /** Unix seconds. */
  exp: number;
}

/** The exact text that is signed. */
export function canonicalString(parts: FileLinkParts): string {
  return ["v1", parts.kind, parts.id, parts.variant, parts.orgId, parts.userId, parts.audience, String(parts.exp)].join("|");
}

export function signParts(secret: string, parts: FileLinkParts): string {
  return createHmac("sha256", secret).update(canonicalString(parts)).digest("base64url");
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

/**
 * The parts of a link from the route's params and query, or null if anything is missing, extra, the wrong shape or the wrong type.
 * Strict on purpose: a link has exactly these five query values and nothing else.
 */
export function parseLinkParts(
  params: Record<string, unknown>,
  query: Record<string, unknown>
): (FileLinkParts & { sig: string }) | null {
  if (Object.keys(query).sort().join(",") !== "a,exp,o,sig,u") return null;
  const { kind, id, variant } = params;
  const { o, u, a, exp, sig } = query;
  if (!oneOf(FILE_LINK_KINDS, kind) || !oneOf(FILE_LINK_VARIANTS, variant) || !oneOf(FILE_LINK_AUDIENCES, a)) return null;
  if (typeof id !== "string" || !ID.test(id) || typeof o !== "string" || !ID.test(o) || typeof u !== "string" || !ID.test(u)) return null;
  if (typeof exp !== "string" || !EXP.test(exp) || typeof sig !== "string" || !SIG.test(sig)) return null;
  return { kind, id, variant, orgId: o, userId: u, audience: a, exp: Number(exp), sig };
}

/**
 * Does `sig` match the link for ANY of the secrets (the current one, then the previous one during a rotation)? Constant-time
 * comparison; every secret is always checked, so the time does not say which one matched.
 */
export function signatureMatches(parts: FileLinkParts, sig: string, secrets: readonly string[]): boolean {
  const provided = Buffer.from(sig);
  let matched = false;
  for (const secret of secrets) {
    const expected = Buffer.from(signParts(secret, parts));
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) matched = true;
  }
  return matched;
}

/** True when the link must be refused: expired (beyond the skew), or issued further ahead than any link may be. */
export function expiryRefused(exp: number, nowSeconds: number, maxTtlSeconds: number): boolean {
  return exp + CLOCK_SKEW_SECONDS < nowSeconds || exp > nowSeconds + maxTtlSeconds + CLOCK_SKEW_SECONDS;
}
