// Makes and removes the small version of a stored photo. Best effort and never fatal: a photo without a thumbnail is
// simply served in full (the customer file gateway falls back), so a failure here must not fail an upload or a delete.

import type { Readable } from "node:stream";
import { contentTypeForKey, isImageType, keyFromOwnedUrlForOrg, objectStoreConfigured, requireStore, thumbKeyFor } from "../lib/object-storage.js";
import { safeError } from "../lib/redact.js";
import { makeThumbnail, ThumbnailUnavailableError } from "../lib/thumbnail.js";

/** Photos are limited to 10 MB at upload; anything bigger than this is not even read. */
const MAX_ORIGINAL_BYTES = 12 * 1024 * 1024;

async function readCapped(stream: Readable, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Creates the thumbnail for one stored photo URL (this org's only). Returns true if one was written. */
export async function createPhotoThumbnail(orgId: string, url: string): Promise<boolean> {
  try {
    if (!objectStoreConfigured()) return false;
    const key = keyFromOwnedUrlForOrg(orgId, url);
    const thumbKey = key ? thumbKeyFor(key) : null;
    const contentType = key ? contentTypeForKey(key) : null;
    if (!key || !thumbKey || !contentType || !isImageType(contentType)) return false;

    const store = requireStore();
    const original = await store.getObject({ key });
    if (original.kind !== "found") return false;
    const bytes = await readCapped(original.body, MAX_ORIGINAL_BYTES);
    if (!bytes) return false;

    const thumb = await makeThumbnail(bytes, contentType);
    await store.putObject({ key: thumbKey, body: thumb, contentType });
    return true;
  } catch (error) {
    // The image library missing was already reported once; every other failure is logged (redacted).
    if (!(error instanceof ThumbnailUnavailableError)) console.error("thumbnail not created", safeError(error));
    return false;
  }
}

/** Removes the thumbnail next to a photo that is being deleted. */
export async function deletePhotoThumbnail(orgId: string, url: string): Promise<void> {
  try {
    if (!objectStoreConfigured()) return;
    const key = keyFromOwnedUrlForOrg(orgId, url);
    const thumbKey = key ? thumbKeyFor(key) : null;
    if (thumbKey) await requireStore().deleteKey(thumbKey);
  } catch (error) {
    console.error("thumbnail not deleted", safeError(error));
  }
}
