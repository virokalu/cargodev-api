// Where public stock images live. A SEPARATE bucket from the private files (vehicle photos, documents), served from its
// own public base URL, with nothing private in it. Keys are `stock/<org segment>/<random id>.<ext>`: the segment is a
// one-way hash of the org id, so a public image address never contains the org id, and one org cannot register another
// org's key. Images are jpeg, png or webp only (never SVG or HTML).

import { createHash, randomUUID } from "node:crypto";
import { loadEnv } from "../config/env.js";
import { MAX_STOCK_IMAGE_BYTES, STOCK_IMAGE_TYPES } from "../config/public-stock.js";
import { ServiceError } from "./errors.js";
import { UPLOAD_URL_TTL_SECONDS, type ObjectStore } from "./object-storage.js";
import { safeError } from "./redact.js";

type StockImageType = (typeof STOCK_IMAGE_TYPES)[number];

const EXTENSION: Record<StockImageType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

let store: ObjectStore | null = null;

export function setPublicStockStore(next: ObjectStore | null): void {
  store = next;
}

export function publicStockStoreConfigured(): boolean {
  return store !== null;
}

/** The public base URL stock images are served from, without a trailing slash, or null. */
export function stockImageBaseUrl(): string | null {
  const configured = loadEnv().PUBLIC_STOCK_IMAGE_BASE_URL;
  return configured ? configured.replace(/\/+$/, "") : null;
}

export function orgSegment(orgId: string): string {
  return createHash("sha256").update(`stock:${orgId}`).digest("hex").slice(0, 16);
}

export function stockKeyPrefix(orgId: string): string {
  return `stock/${orgSegment(orgId)}/`;
}

/** True only for a key of exactly the shape this API issues, inside this org's own segment. */
export function isOwnStockImageKey(orgId: string, key: string): boolean {
  return key.startsWith(stockKeyPrefix(orgId)) && /^stock\/[0-9a-f]{16}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(key);
}

/** The public address of a stored image, or null when no public base URL is configured. */
export function stockImageUrl(key: string): string | null {
  const base = stockImageBaseUrl();
  return base ? `${base}/${key}` : null;
}

export interface PresignedStockImage {
  uploadUrl: string;
  key: string;
  publicUrl: string | null;
  expiresInSeconds: number;
  headers: Record<string, string>;
}

export async function presignStockImage(orgId: string, contentType: string, contentLength: number): Promise<PresignedStockImage> {
  if (!store) throw new ServiceError("VALIDATION", "Stock image uploads are not configured.");
  if (!(STOCK_IMAGE_TYPES as readonly string[]).includes(contentType) || contentLength > MAX_STOCK_IMAGE_BYTES) {
    throw new ServiceError("VALIDATION", "Unsupported file.");
  }
  const key = `${stockKeyPrefix(orgId)}${randomUUID()}.${EXTENSION[contentType as StockImageType]}`;
  const uploadUrl = await store.presignPut({ key, contentType, contentLength, expiresInSeconds: UPLOAD_URL_TTL_SECONDS });
  return { uploadUrl, key, publicUrl: stockImageUrl(key), expiresInSeconds: UPLOAD_URL_TTL_SECONDS, headers: { "Content-Type": contentType } };
}

/** Best effort: a leftover object is harmless, a failed delete never fails the request. */
export async function deleteStockImageObject(key: string): Promise<void> {
  if (!store) return;
  try {
    await store.deleteKey(key);
  } catch (error) {
    console.error("deleting a stock image failed", safeError(error));
  }
}
