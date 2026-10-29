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
import { UPLOAD_LIMITS } from "../validation/upload.schema.js";

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
// The store (Cloudflare R2). ONE interface; src/lib/r2-object-store.ts is installed at startup when the R2 credentials
// are set, and tests install a recorder. Two jobs only:
//   - STAFF UPLOADS: a short-lived signed PUT link, built by presignUpload below.
//   - CUSTOMER DOWNLOADS: the API reads the object itself (getObject) and streams it. Customers never receive an R2
//     address, a key or a signed link (see customer-file-access.service.ts).

import type { Readable } from "node:stream";

export type StoredObject =
  | { kind: "found"; body: Readable; contentLength: number | null; etag: string | null; contentRange?: string | null }
  | { kind: "notModified"; etag: string | null }
  | { kind: "rangeNotSatisfiable" }
  | { kind: "missing" };

export interface ObjectStore {
  /** A URL a staff client can PUT one object to. Signs the exact content length and type, nothing more. */
  presignPut(args: { key: string; contentType: string; contentLength: number; expiresInSeconds: number }): Promise<string>;
  /** Reads one object. With `ifNoneMatch`, answers notModified when the ETag still matches (no body is read). With `range` ("bytes=0-99"), one part. */
  getObject(args: { key: string; ifNoneMatch?: string; range?: string }): Promise<StoredObject>;
  /** Writes one object (server side: thumbnails). */
  putObject(args: { key: string; body: Buffer; contentType: string }): Promise<void>;
  deleteKey(key: string): Promise<void>;
}

let store: ObjectStore | null = null;

export function setObjectStore(next: ObjectStore | null): void {
  store = next;
}

export function objectStoreConfigured(): boolean {
  return store !== null;
}

export function requireStore(): ObjectStore {
  if (!store) throw new ServiceError("VALIDATION", "File storage is not configured.");
  return store;
}

/** Uploads are signed for exactly 5 minutes. */
export const UPLOAD_URL_TTL_SECONDS = 300;

// The ONLY content types this API accepts, stores or serves. No SVG, no HTML, nothing a browser could run.
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const ALLOWED_DOCUMENT_TYPES = ["application/pdf"] as const;
export type AllowedContentType = (typeof ALLOWED_IMAGE_TYPES)[number] | (typeof ALLOWED_DOCUMENT_TYPES)[number];

const EXTENSION_FOR_TYPE: Record<AllowedContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
const TYPE_FOR_EXTENSION: Record<string, AllowedContentType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** The type a stored key is served as, decided by its extension (uploads force the extension from the signed type). */
export function contentTypeForKey(key: string): AllowedContentType | null {
  const extension = key.split(".").at(-1)?.toLowerCase() ?? "";
  return key.includes(".") ? (TYPE_FOR_EXTENSION[extension] ?? null) : null;
}

export function isImageType(type: string): boolean {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type);
}

/** Characters safe in a key: letters, digits, dot, dash, underscore. Everything else becomes a dash. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").replace(/-{2,}/g, "-");
  return cleaned.slice(-80) || "file";
}

/** A name with its extension removed (the extension of a key always comes from the signed content type). */
function baseName(name: string): string {
  return safeFileName(name).replace(/\.[A-Za-z0-9]{1,8}$/, "") || "file";
}

/**
 * The key a NEW upload gets. Always inside the org's folder (staging while no vehicle exists yet). The extension is
 * forced from the signed content type, whatever the client's file name says, so a key's extension is trustworthy.
 */
export function buildObjectKey(
  orgId: string,
  kind: FileKind,
  vehicleId: string | undefined,
  fileName: string,
  uniqueId: string,
  contentType: AllowedContentType
): string {
  const folder = vehicleId ? `org/${orgId}/vehicles/${vehicleId}/${KIND_FOLDER[kind]}` : `org/${orgId}/uploads/staging`;
  return `${folder}/${uniqueId}-${baseName(fileName)}.${EXTENSION_FOR_TYPE[contentType]}`;
}

/**
 * Where the small version of a photo lives: next to the folder, never inside the one the client uploads to. Photos of a
 * vehicle (`.../photos/x`) and photos staged before the vehicle existed (`.../uploads/staging/x`) both have one.
 */
export function thumbKeyFor(key: string): string | null {
  if (key.includes("/photos/")) return key.replace("/photos/", "/photos-thumb/");
  if (key.includes("/uploads/staging/")) return key.replace("/uploads/staging/", "/uploads/staging-thumb/");
  return null;
}

/**
 * What a staff client gets to upload one file: a signed PUT link and the KEY to send back when it registers the file. There is no
 * public address in it. (The PUT link is staff-only, valid 300 s, for one key; it necessarily contains the storage host and the
 * account id: an accepted exposure, see docs/security-model.md.)
 */
export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  expiresInSeconds: number;
}

/** Signs one upload. The key must already be inside an allowed prefix (the caller builds it with buildObjectKey). */
export async function presignUpload(args: { key: string; contentType: AllowedContentType; contentLength: number }): Promise<PresignedUpload> {
  if (!publicBaseUrl()) throw new ServiceError("VALIDATION", "File storage is not configured.");
  const uploadUrl = await requireStore().presignPut({ ...args, expiresInSeconds: UPLOAD_URL_TTL_SECONDS });
  return { uploadUrl, key: args.key, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
}

/** The value stored in the database for a registered file: built HERE from the key, never taken from a client. */
export function storedUrlForKey(key: string): string | null {
  const base = publicBaseUrl();
  return base ? `${base}/${key}` : null;
}

const EXTENSIONS_FOR_KIND: Record<FileKind, readonly string[]> = {
  AUCTION_SHEET: UPLOAD_LIMITS.AUCTION_SHEET.mimeTypes.map((m) => EXTENSION_FOR_TYPE[m as AllowedContentType]),
  VEHICLE_PHOTO: UPLOAD_LIMITS.VEHICLE_PHOTO.mimeTypes.map((m) => EXTENSION_FOR_TYPE[m as AllowedContentType]),
  VEHICLE_DOCUMENT: UPLOAD_LIMITS.VEHICLE_DOCUMENT.mimeTypes.map((m) => EXTENSION_FOR_TYPE[m as AllowedContentType]),
};

/**
 * Why a KEY sent to register a new file is not acceptable, or null. The key must be inside this org's staging folder (no vehicle
 * yet) or this vehicle's folder for that kind, made only of the characters keys are made of (no traversal), and its extension
 * must be one this kind allows (uploads force the extension from the signed type). Fails closed when storage is not configured.
 */
export function checkNewFileKey(orgId: string, key: unknown, kind: FileKind, vehicleId?: string): string | null {
  const base = publicBaseUrl();
  if (!base) return "File storage is not configured.";
  if (typeof key !== "string" || key === "") return "This file was not uploaded for your organisation.";
  const extension = key.split(".").at(-1)?.toLowerCase() ?? "";
  if (!key.includes(".") || !EXTENSIONS_FOR_KIND[kind].includes(extension)) return "This file type is not allowed.";
  return checkNewFileUrl(orgId, `${base}/${key}`, kind, vehicleId);
}

/**
 * The object must really be there and within the size limit for its kind (the signed upload pinned both, but a key can be sent
 * without ever uploading, or the object replaced). Skipped only when no store is configured (nothing to check against).
 */
export async function verifyUploadedObject(key: string, kind: FileKind): Promise<string | null> {
  if (!store) return null;
  const found = await store.getObject({ key });
  if (found.kind === "missing") return "This file has not been uploaded.";
  if (found.kind === "found") {
    found.body.destroy(); // only the size is needed
    if (found.contentLength !== null && found.contentLength > UPLOAD_LIMITS[kind].maxBytes) return `This file is larger than ${UPLOAD_LIMITS[kind].maxBytes / 1024 / 1024} MB.`;
  }
  return null;
}

/** Best effort. Used only while no store is installed: it records that an object was left behind. */
export interface ObjectDeleter {
  (key: string): Promise<void>;
}

let deleter: ObjectDeleter = async (key) => {
  void key;
  console.warn("object storage delete is not configured; an object was left in place");
};

export function deleteObject(key: string): Promise<void> {
  return store ? store.deleteKey(key) : deleter(key);
}

/** Replaces the no-store fallback (tests). */
export function setObjectDeleter(next: ObjectDeleter): void {
  deleter = next;
}
