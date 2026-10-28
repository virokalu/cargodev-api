// Small versions of photos, made on the server after an upload. sharp is the only image library used.
//
// The bytes come from a client, so nothing about them is trusted:
//   - the real format is read from the bytes (never the file name) and must be jpeg, png or webp: an SVG, GIF, TIFF or
//     anything else renamed to .jpg is refused;
//   - the number of pixels is capped before decoding (a small file can decode to gigabytes);
//   - EXIF orientation is applied and then ALL metadata (GPS position, camera, etc.) is dropped from the thumbnail.

import type sharpModule from "sharp";
import type { AllowedContentType } from "./object-storage.js";

export const THUMB_MAX_EDGE = 480;
export const MAX_INPUT_PIXELS = 50_000_000;

const FORMAT_FOR_TYPE = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" } as const;

export class ThumbnailError extends Error {}
/** The image library could not be loaded on this machine. Thumbnails are skipped; photos are served in full. */
export class ThumbnailUnavailableError extends ThumbnailError {}

// sharp is loaded on first use, not at start-up: a missing or incompatible native binary must cost thumbnails only, never the
// whole API. The failure is logged once, with a fixed message (the library's own message can contain paths).
type Sharp = typeof sharpModule;
let sharpLoad: Promise<Sharp | null> | undefined;
let reported = false;

export function loadSharp(): Promise<Sharp | null> {
  sharpLoad ??= import("sharp")
    .then((module) => module.default)
    .catch(() => {
      if (!reported) {
        reported = true;
        console.error("image library (sharp) could not be loaded; thumbnails are disabled and photos are served in full");
      }
      return null;
    });
  return sharpLoad;
}

/** Tests only: forget the cached load so the next call tries again. */
export function resetSharpForTests(): void {
  sharpLoad = undefined;
  reported = false;
}

export async function makeThumbnail(
  input: Buffer,
  contentType: AllowedContentType,
  options: { maxInputPixels?: number } = {}
): Promise<Buffer> {
  const expected = FORMAT_FOR_TYPE[contentType as keyof typeof FORMAT_FOR_TYPE];
  if (!expected) throw new ThumbnailError("Not an image type.");
  const sharp = await loadSharp();
  if (!sharp) throw new ThumbnailUnavailableError("The image library is not available.");
  const limitInputPixels = options.maxInputPixels ?? MAX_INPUT_PIXELS;

  try {
    const meta = await sharp(input, { limitInputPixels, failOn: "error" }).metadata();
    if (meta.format !== expected) throw new ThumbnailError("The file is not the image type it claims to be.");

    const pipeline = sharp(input, { limitInputPixels, failOn: "error" })
      .rotate() // applies the EXIF orientation, then the metadata is not carried over
      .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: "inside", withoutEnlargement: true });
    return await (expected === "jpeg" ? pipeline.jpeg({ quality: 78 }) : expected === "png" ? pipeline.png() : pipeline.webp({ quality: 78 })).toBuffer();
  } catch (error) {
    if (error instanceof ThumbnailError) throw error;
    // sharp's own messages can mention paths or pixel counts: keep ours generic.
    throw new ThumbnailError("The image could not be processed.");
  }
}
