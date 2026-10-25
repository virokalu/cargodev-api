// File storage seam.
//
// The database stores file URLs only. That makes every URL a client sends dangerous if it is
// trusted: the server later FETCHES stored photo URLs (PDF export) and DELETES objects derived
// from them. Two attacks follow from accepting any string:
//   - SSRF: store http://internal-service/... as a "photo", then ask the server to fetch it.
//   - Cross-org deletion: store a link to ANOTHER org's file, then delete the photo and let the
//     server delete the real object.
//
// So a file URL is accepted only if it is under our configured public base URL AND inside the
// caller's own org folder (org/<orgId>/...). Everything else is refused. If storage is not
// configured, every file URL is refused (fail closed).
//
// Signing uploads and deleting objects need the object-storage SDK, which is not added yet.
// `deleteObject` is the seam: today it only records that an orphan was left behind (a harmless
// leak, and the original code tolerated delete failures the same way).

import { loadEnv } from "../config/env.js";
import { ServiceError } from "./errors.js";

export type FileKind = "AUCTION_SHEET" | "VEHICLE_PHOTO" | "VEHICLE_DOCUMENT";

const KIND_FOLDER: Record<FileKind, string> = {
  AUCTION_SHEET: "auction-sheet",
  VEHICLE_PHOTO: "photos",
  VEHICLE_DOCUMENT: "documents",
};

/** The configured public base URL without a trailing slash, or null when storage is not configured. */
export function publicBaseUrl(): string | null {
  const configured = loadEnv().R2_PUBLIC_URL;
  return configured ? configured.replace(/\/+$/, "") : null;
}

/**
 * The object key for `url` if (and only if) it is under `base` and its key starts with one of
 * `allowedPrefixes`. Otherwise null. Pure: no environment, no network.
 */
export function keyFromOwnedUrl(base: string | null, url: string, allowedPrefixes: readonly string[]): string | null {
  if (!base || typeof url !== "string") return null;
  const prefix = `${base}/`;
  // startsWith(base + "/") pins the scheme and the exact host: https://files.example.test.evil.test/ and
  // https://files.example.test@evil.test/ both fail here.
  if (!url.startsWith(prefix)) return null;

  const key = url.slice(prefix.length);
  if (key === "" || key.length > 1024) return null;
  // Keys we generate contain only [A-Za-z0-9._/-]. Anything else (query, fragment, percent-encoding,
  // backslash, spaces, control characters, traversal, empty path segments) is not one of ours.
  if (!/^[A-Za-z0-9._\-/]+$/.test(key)) return null;
  if (key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;

  return allowedPrefixes.some((p) => key.startsWith(p)) ? key : null;
}

/** Where a client may point a NEW file for this org. Without a vehicle id it is the staging area. */
export function allowedPrefixesForNewFile(orgId: string, kind: FileKind, vehicleId?: string): string[] {
  const staging = `org/${orgId}/uploads/staging/`;
  if (!vehicleId) return [staging];
  return [`org/${orgId}/vehicles/${vehicleId}/${KIND_FOLDER[kind]}/`];
}

/** Anything of this org's, for re-checking URLs that are already stored before fetching or deleting. */
export function orgPrefix(orgId: string): string[] {
  return [`org/${orgId}/`];
}

export function keyFromOwnedUrlForOrg(orgId: string, url: string): string | null {
  return keyFromOwnedUrl(publicBaseUrl(), url, orgPrefix(orgId));
}

/**
 * Why a NEW file URL is not acceptable, or null if it is. A new file must live in this org's staging
 * area (no vehicle yet) or in the given vehicle's folder for that kind. Fails closed when storage is
 * not configured.
 */
export function checkNewFileUrl(orgId: string, url: string, kind: FileKind, vehicleId?: string): string | null {
  const base = publicBaseUrl();
  if (!base) return "File storage is not configured.";
  const key = keyFromOwnedUrl(base, url, allowedPrefixesForNewFile(orgId, kind, vehicleId));
  return key ? null : "This file was not uploaded for your organisation.";
}

// ---------------------------------------------------------------------------------------------
// The store: signing and deleting. ONE interface; the S3 implementation (src/lib/s3-store.ts) is installed at
// startup when the R2 credentials are set, and tests install a fake. Everything that signs a URL goes through
// presignUpload / signedDownloadUrl below, so there is exactly one place that decides lifetimes.

export interface ObjectStore {
  /** A URL a client can PUT one object to. Must sign the exact content length and type. */
  presignPut(args: { key: string; contentType: string; contentLength: number; expiresInSeconds: number }): Promise<string>;
  /** A URL a client can GET one object from. */
  presignGet(args: { key: string; expiresInSeconds: number; downloadName?: string }): Promise<string>;
  deleteKey(key: string): Promise<void>;
}

let store: ObjectStore | null = null;

export function setObjectStore(next: ObjectStore | null): void {
  store = next;
}

export function objectStoreConfigured(): boolean {
  return store !== null;
}

function requireStore(): ObjectStore {
  if (!store) throw new ServiceError("VALIDATION", "File storage is not configured.");
  return store;
}

/** Uploads are signed for exactly 5 minutes. */
export const UPLOAD_URL_TTL_SECONDS = 300;

export function downloadUrlTtlSeconds(): number {
  return loadEnv().SIGNED_URL_TTL_SECONDS;
}

/** Characters safe in a key: letters, digits, dot, dash, underscore. Everything else becomes a dash. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").replace(/-{2,}/g, "-");
  const trimmed = cleaned.slice(-80) || "file";
  return trimmed;
}

/** The key a NEW upload gets. Always inside the org's folder (staging while no vehicle exists yet). */
export function buildObjectKey(orgId: string, kind: FileKind, vehicleId: string | undefined, fileName: string, uniqueId: string): string {
  const folder = vehicleId ? `org/${orgId}/vehicles/${vehicleId}/${KIND_FOLDER[kind]}` : `org/${orgId}/uploads/staging`;
  return `${folder}/${uniqueId}-${safeFileName(fileName)}`;
}

export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  publicUrl: string;
  expiresInSeconds: number;
}

/** Signs one upload. The key must already be inside an allowed prefix (the caller builds it with buildObjectKey). */
export async function presignUpload(args: { key: string; contentType: string; contentLength: number }): Promise<PresignedUpload> {
  const base = publicBaseUrl();
  if (!base) throw new ServiceError("VALIDATION", "File storage is not configured.");
  const uploadUrl = await requireStore().presignPut({ ...args, expiresInSeconds: UPLOAD_URL_TTL_SECONDS });
  return { uploadUrl, key: args.key, publicUrl: `${base}/${args.key}`, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
}

/**
 * THE one function that turns a stored key into a time-limited download link. It trusts nothing: callers must
 * have authorised the file first. A key outside the org's folder is refused here too, as a last line of defence.
 */
export async function signedDownloadUrl(orgId: string, key: string, downloadName?: string): Promise<{ url: string; expiresInSeconds: number }> {
  if (!keyFromOwnedUrl(`https://key.invalid`, `https://key.invalid/${key}`, orgPrefix(orgId))) {
    throw new ServiceError("NOT_FOUND", "File not found.");
  }
  const expiresInSeconds = downloadUrlTtlSeconds();
  const url = await requireStore().presignGet({ key, expiresInSeconds, ...(downloadName ? { downloadName } : {}) });
  return { url, expiresInSeconds };
}

/** Best effort. Today only records the orphan: deleting needs the object-storage SDK. */
export interface ObjectDeleter {
  (key: string): Promise<void>;
}

let deleter: ObjectDeleter = async (key) => {
  console.warn(`object storage delete is not configured; left object in place: ${key}`);
};

export function deleteObject(key: string): Promise<void> {
  return store ? store.deleteKey(key) : deleter(key);
}

/** Install the real implementation once the SDK is added (and in tests). */
export function setObjectDeleter(next: ObjectDeleter): void {
  deleter = next;
}
