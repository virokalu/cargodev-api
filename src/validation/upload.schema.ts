// Zod schema for the /api/uploads/presign request body — shape-level plus
// per-kind MIME/size limits (US-24: images ≤10MB JPEG/PNG/WebP). No cap is
// specified anywhere for documents; 20MB is a judgment call sized for
// scanned B/L/invoice bundles, not an acceptance criterion.

import { z } from "zod";
import { flattenFieldErrors } from "./shared.js";

export { flattenFieldErrors };

export const UPLOAD_LIMITS = {
  AUCTION_SHEET: { mimeTypes: ["image/jpeg", "image/png", "image/webp"], maxBytes: 10 * 1024 * 1024 },
  VEHICLE_PHOTO: { mimeTypes: ["image/jpeg", "image/png", "image/webp"], maxBytes: 10 * 1024 * 1024 },
  VEHICLE_DOCUMENT: { mimeTypes: ["application/pdf"], maxBytes: 20 * 1024 * 1024 },
} as const;

export const presignRequestSchema = z
  .object({
    // Omitted while staging any of the three kinds during vehicle creation —
    // no vehicle row exists yet to check ownership against. Present for
    // edit-mode uploads (replace auction sheet, add photo/document to an
    // existing vehicle), where the presign route re-checks ownership.
    vehicleId: z.string().min(1).optional(),
    kind: z.enum(["AUCTION_SHEET", "VEHICLE_PHOTO", "VEHICLE_DOCUMENT"]),
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(1),
    fileSize: z.number().int().positive(),
  })
  .superRefine((data, ctx) => {
    const rule = UPLOAD_LIMITS[data.kind];
    // Exact match only: "IMAGE/JPEG", "image/jpeg; charset=x", "image/svg+xml", "text/html" are all refused.
    if (!(rule.mimeTypes as readonly string[]).includes(data.contentType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentType"],
        message: "Unsupported file type.",
      });
    }
    if (data.fileSize > rule.maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fileSize"],
        message: `Must be ${rule.maxBytes / 1024 / 1024} MB or smaller.`,
      });
    }
  });

export type PresignRequest = z.infer<typeof presignRequestSchema>;
