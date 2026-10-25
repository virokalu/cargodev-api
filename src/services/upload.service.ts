// POST /uploads/presign: a short-lived URL the client uploads one file to, straight to storage. The file never passes
// through this server. Ownership is checked FIRST (the vehicle must be this org's and not deleted), the key is built
// here (the client never chooses it), and the signed URL pins the exact size and type.

import { randomUUID } from "node:crypto";
import type { SessionUser } from "../lib/session-user.js";
import { parseInput } from "../lib/parse.js";
import { buildObjectKey, presignUpload, type PresignedUpload } from "../lib/object-storage.js";
import { presignRequestSchema } from "../validation/upload.schema.js";
import { getOwnedVehicle } from "./file.service.js";

export async function createPresignedUpload(actor: SessionUser, rawBody: unknown): Promise<PresignedUpload & { headers: Record<string, string> }> {
  const input = parseInput(presignRequestSchema, rawBody, "Please fix the highlighted fields.");

  // Authorization before anything is signed. Another org's, a deleted or an unknown vehicle is the standard 404.
  if (input.vehicleId) await getOwnedVehicle(actor.orgId, input.vehicleId);

  const key = buildObjectKey(actor.orgId, input.kind, input.vehicleId, input.fileName, randomUUID());
  const signed = await presignUpload({ key, contentType: input.contentType, contentLength: input.fileSize });
  // The client must send exactly these headers or storage refuses the upload.
  return { ...signed, headers: { "Content-Type": input.contentType } };
}
