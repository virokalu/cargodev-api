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

/** Best effort. Today only records the orphan: deleting needs the object-storage SDK. */
export interface ObjectDeleter {
  (key: string): Promise<void>;
}

let deleter: ObjectDeleter = async (key) => {
  console.warn(`object storage delete is not configured; left object in place: ${key}`);
};

export function deleteObject(key: string): Promise<void> {
  return deleter(key);
}

/** Install the real implementation once the SDK is added (and in tests). */
export function setObjectDeleter(next: ObjectDeleter): void {
  deleter = next;
}
