// Vehicle files: auction sheet (single, replaceable), photos and documents (multi, append/delete).
// The database stores file URLs only, never bytes. Every mutator re-checks vehicle ownership and
// writes its ActivityLog row in the same transaction.
//
// Hardened versus the CargoDev source (see docs/security-model.md). The source stored any string a
// client sent as a file URL, which allowed two attacks:
//   - SSRF: the PDF export makes the SERVER fetch every stored photo URL, so a photo URL pointing at
//     an internal address turned that into a read of internal services.
//   - Cross-org deletion: deleting a photo deletes the storage object its URL names, so a URL pointing
//     at another org's file deleted that org's real object.
// Now: a new URL must be one of this org's own uploads (lib/object-storage.ts); a stored URL is
// re-checked before the server fetches or deletes it (the shared database already holds rows written
// before this check existed); and the fetch refuses redirects, caps size and time, and accepts images only.

import type { VehicleDocumentType } from "@prisma/client";
import { getPrisma } from "../lib/prisma.js";
import { ServiceError } from "../lib/errors.js";
import type { SessionUser } from "../lib/session-user.js";
import { safeError } from "../lib/redact.js";
import { checkNewFileKey, contentTypeForKey, deleteObject, isImageType, keyFromOwnedUrlForOrg, requireStore, storedUrlForKey, verifyUploadedObject, type FileKind } from "../lib/object-storage.js";
import type { Readable } from "node:stream";
import type { FileLinkKind } from "../lib/file-link.js";
import { issueFileLink, type LinkContext } from "./file-link.service.js";
import { DOCUMENT_TYPE_META } from "../lib/constants/document-type.js";
import { parseInput } from "../lib/parse.js";
import { documentBodySchema, fileKeyBodySchema, photosAddedBodySchema } from "../validation/file.schema.js";
import { fileReference } from "../lib/file-reference.js";
import * as activityLog from "./activity-log.service.js";
import * as notificationService from "./notification.service.js";
import { createPhotoThumbnail, deletePhotoThumbnail } from "./photo-thumbnail.service.js";

/** The vehicle if it is in this org and not soft-deleted; otherwise the standard 404. */
export async function getOwnedVehicle(orgId: string, vehicleId: string) {
  const vehicle = await getPrisma().vehicle.findFirst({ where: { id: vehicleId, org_id: orgId, deletedAt: null } });
  if (!vehicle) {
    throw new ServiceError("NOT_FOUND", "Vehicle not found.");
  }
  return vehicle;
}

const INVALID = "Please fix the highlighted fields.";

/**
 * A new file is registered by its KEY: it must be this org's own upload for this vehicle and kind (folder, characters, type),
 * the object must really exist within the size limit, and the value that gets stored is built here from the key.
 */
async function storedUrlForNewFile(orgId: string, vehicleId: string, kind: FileKind, key: string): Promise<string> {
  const message = checkNewFileKey(orgId, key, kind, vehicleId) ?? (await verifyUploadedObject(key, kind));
  const url = storedUrlForKey(key);
  if (message || !url) throw new ServiceError("VALIDATION", message ?? "File storage is not configured.", { key: message ?? "File storage is not configured." });
  return url;
}

/** Best effort cleanup of a replaced/deleted file. Only objects inside THIS org's folder are ever touched. */
function deleteStoredFile(orgId: string, url: string): void {
  const key = keyFromOwnedUrlForOrg(orgId, url);
  if (!key) return;
  deleteObject(key).catch((error: unknown) => console.error("object delete failed", safeError(error)));
}

/**
 * What a STAFF client receives for a stored file: a short-lived link on THIS API's own domain in `url` (never the stored address, never a
 * storage host) and when it stops working. A row whose address cannot be mapped to a file this org may read, or any file when links are not
 * configured, has `url: null` and `unavailable: true`. Clients must not store the link: ask again.
 */
export interface StaffFileLink {
  url: string | null;
  expiresAt: string | null;
  unavailable?: true;
}

const staffContext = (actor: { id: string; orgId: string }): LinkContext => ({ orgId: actor.orgId, userId: actor.id, audience: "staff" });

/** Called only after the endpoint's own authorization (the vehicle is the caller's, the role is allowed). */
function staffLink(context: LinkContext, kind: FileLinkKind, id: string, stored: string | null): StaffFileLink {
  // The stored address must map to a file this org may read, through the same validated function as the customer gateway.
  const key = stored ? keyFromOwnedUrlForOrg(context.orgId, stored) : null;
  const type = key ? contentTypeForKey(key) : null;
  const suitable = type !== null && (kind === "document" ? type === "application/pdf" : isImageType(type));
  const issued = suitable ? issueFileLink(context, kind, id, "full") : null;
  return issued ? { url: issued.url, expiresAt: issued.expiresAt } : { url: null, expiresAt: null, unavailable: true };
}

/** A masked count only: never an address, a key or an id. */
function warnUnavailable(links: StaffFileLink[]): void {
  const count = links.filter((link) => link.unavailable).length;
  if (count > 0) console.warn(`staff file links: ${count} file(s) could not be linked`);
}

export interface VehiclePhotoListItem extends StaffFileLink {
  id: string;
  uploaderName: string;
  createdAt: Date;
}

export interface VehicleDocumentListItem extends StaffFileLink {
  id: string;
  name: string;
  documentType: VehicleDocumentType;
  uploaderName: string;
  createdAt: Date;
}

export interface VehicleFiles {
  /** A signed link (or null), like every `url` below. */
  auctionSheetUrl: string | null;
  auctionSheetExpiresAt: string | null;
  auctionSheetUnavailable?: true;
  photos: VehiclePhotoListItem[];
  documents: VehicleDocumentListItem[];
}

/** The vehicle's files exactly as STORED (addresses, not links). Internal: nothing here is returned to a client. */
interface StoredVehicleFiles {
  auctionSheetUrl: string | null;
  photos: { id: string; url: string; uploaderName: string; createdAt: Date }[];
  documents: { id: string; url: string; name: string; documentType: VehicleDocumentType; uploaderName: string; createdAt: Date }[];
}

async function loadStoredVehicleFiles(orgId: string, vehicleId: string): Promise<StoredVehicleFiles> {
  await getOwnedVehicle(orgId, vehicleId);
  const vehicle = await getPrisma().vehicle.findFirstOrThrow({
    where: { id: vehicleId, org_id: orgId },
    select: {
      auctionSheetUrl: true,
      photos: {
        select: { id: true, url: true, createdAt: true, uploadedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      },
      documents: {
        select: {
          id: true,
          url: true,
          name: true,
          documentType: true,
          createdAt: true,
          uploadedBy: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  return {
    auctionSheetUrl: vehicle.auctionSheetUrl,
    photos: vehicle.photos.map((p) => ({
      id: p.id,
      url: p.url,
      uploaderName: p.uploadedBy.name,
      createdAt: p.createdAt,
    })),
    documents: vehicle.documents.map((d) => ({
      id: d.id,
      url: d.url,
      name: d.name,
      documentType: d.documentType,
      uploaderName: d.uploadedBy.name,
      createdAt: d.createdAt,
    })),
  };
}

/** The files of one vehicle for a staff client: every address is replaced by a short-lived link on our own domain. */
export async function listVehicleFiles(actor: { id: string; orgId: string }, vehicleId: string): Promise<VehicleFiles> {
  const stored = await loadStoredVehicleFiles(actor.orgId, vehicleId);
  const context = staffContext(actor);
  const sheet = stored.auctionSheetUrl ? staffLink(context, "auction-sheet", vehicleId, stored.auctionSheetUrl) : null;
  const photos = stored.photos.map((p) => ({ id: p.id, ...staffLink(context, "photo", p.id, p.url), uploaderName: p.uploaderName, createdAt: p.createdAt }));
  const documents = stored.documents.map((d) => ({ id: d.id, ...staffLink(context, "document", d.id, d.url), name: d.name, documentType: d.documentType, uploaderName: d.uploaderName, createdAt: d.createdAt }));
  warnUnavailable([...(sheet ? [sheet] : []), ...photos, ...documents]);
  return {
    auctionSheetUrl: sheet?.url ?? null,
    auctionSheetExpiresAt: sheet?.expiresAt ?? null,
    ...(sheet?.unavailable ? { auctionSheetUnavailable: true as const } : {}),
    photos,
    documents,
  };
}

export interface VehiclePdfImages {
  auctionSheetDataUrl: string | null;
  photoDataUrls: string[];
}

/** Limits for the server-side fetch of a stored image. */
export const PDF_IMAGE_FETCH = { timeoutMs: 10_000, maxBytes: 15 * 1024 * 1024 } as const;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Reads a stream up to `maxBytes` within `timeoutMs`; null if it is larger or too slow (the stream is closed either way). */
async function readStreamCapped(stream: Readable, maxBytes: number, timeoutMs: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  const timer = setTimeout(() => stream.destroy(new Error("timeout")), timeoutMs);
  try {
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
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads one stored image through the object store and returns it as a data URL, or null. The stored address is re-checked against this
 * org's folder first (rows written before validation existed may hold anything). The bytes come from the store directly: no link, no
 * network call to a stored address. Size, time and content type are capped.
 */
async function fetchAsDataUrl(orgId: string, url: string): Promise<string | null> {
  const key = keyFromOwnedUrlForOrg(orgId, url);
  const contentType = key ? contentTypeForKey(key) : null;
  if (!key || !contentType || !ALLOWED_IMAGE_TYPES.has(contentType)) return null;
  try {
    const found = await Promise.race([
      requireStore().getObject({ key }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PDF_IMAGE_FETCH.timeoutMs).unref()),
    ]);
    if (found.kind !== "found") return null;
    if (found.contentLength !== null && found.contentLength > PDF_IMAGE_FETCH.maxBytes) {
      found.body.destroy();
      return null;
    }
    const buffer = await readStreamCapped(found.body, PDF_IMAGE_FETCH.maxBytes, PDF_IMAGE_FETCH.timeoutMs);
    return buffer ? `data:${contentType};base64,${buffer.toString("base64")}` : null;
  } catch {
    return null;
  }
}

/**
 * The auction sheet and every photo as base64 data URLs, for the client-side PDF export. It takes no
 * URL from the caller: it re-derives them from this vehicle's own stored files, then validates each
 * one again before fetching. A single failed or refused image is skipped (a partial PDF beats none).
 */
export async function getVehiclePdfImages(orgId: string, vehicleId: string): Promise<VehiclePdfImages> {
  const files = await loadStoredVehicleFiles(orgId, vehicleId);

  const [auctionSheetDataUrl, photoDataUrls] = await Promise.all([
    files.auctionSheetUrl ? fetchAsDataUrl(orgId, files.auctionSheetUrl) : Promise.resolve(null),
    Promise.all(files.photos.map((photo) => fetchAsDataUrl(orgId, photo.url))),
  ]);

  return {
    auctionSheetDataUrl,
    photoDataUrls: photoDataUrls.filter((url): url is string => url !== null),
  };
}

export async function setAuctionSheet(
  actor: SessionUser,
  vehicleId: string,
  rawInput: unknown
): Promise<{ auctionSheetUrl: string | null; auctionSheetExpiresAt: string | null; auctionSheetUnavailable?: true }> {
  const { key } = parseInput(fileKeyBodySchema, rawInput, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);
  const url = await storedUrlForNewFile(actor.orgId, vehicleId, "AUCTION_SHEET", key);

  const result = await getPrisma().$transaction(async (tx) => {
    // The write carries org_id itself (not only getOwnedVehicle above).
    const written = await tx.vehicle.updateMany({ where: { id: vehicleId, org_id: actor.orgId }, data: { auctionSheetUrl: url } });
    if (written.count !== 1) throw new ServiceError("NOT_FOUND", "Vehicle not found.");
    const updated = await tx.vehicle.findFirst({ where: { id: vehicleId, org_id: actor.orgId } });
    if (!updated) throw new ServiceError("NOT_FOUND", "Vehicle not found.");
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_AUCTION_SHEET",
      entity: "Vehicle",
      entityId: vehicleId,
      // The file's id, kind and name: never the stored address.
      before: vehicle.auctionSheetUrl ? fileReference("AUCTION_SHEET", vehicleId, vehicle.auctionSheetUrl) : null,
      after: fileReference("AUCTION_SHEET", vehicleId, url),
    });
    return updated;
  });

  // Best-effort cleanup of the replaced file: a storage failure never blocks the replace.
  if (vehicle.auctionSheetUrl && vehicle.auctionSheetUrl !== url) deleteStoredFile(actor.orgId, vehicle.auctionSheetUrl);

  const link = staffLink(staffContext(actor), "auction-sheet", vehicleId, result.auctionSheetUrl);
  warnUnavailable([link]);
  return { auctionSheetUrl: link.url, auctionSheetExpiresAt: link.expiresAt, ...(link.unavailable ? { auctionSheetUnavailable: true as const } : {}) };
}

// No per-photo notification here: a multi-file upload calls this once per file as each finishes, so
// notifying inside would turn "5 images uploaded" into 5 pings. Each photo still gets its own
// ActivityLog row; only the NOTIFICATION is batched, via notifyPhotosAdded, called once per batch.
export async function addVehiclePhoto(
  actor: SessionUser,
  vehicleId: string,
  rawInput: unknown
): Promise<VehiclePhotoListItem> {
  const { key } = parseInput(fileKeyBodySchema, rawInput, INVALID);
  await getOwnedVehicle(actor.orgId, vehicleId);
  const url = await storedUrlForNewFile(actor.orgId, vehicleId, "VEHICLE_PHOTO", key);

  const photo = await getPrisma().$transaction(async (tx) => {
    const created = await tx.vehiclePhoto.create({
      data: { vehicleId, url, uploadedById: actor.id },
      include: { uploadedBy: { select: { name: true } } },
    });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "ADD_VEHICLE_PHOTO",
      entity: "VehiclePhoto",
      entityId: created.id,
      after: fileReference("VEHICLE_PHOTO", created.id, url),
    });
    return created;
  });

  // Best effort, after the commit: a missing thumbnail only means the photo is served in full.
  await createPhotoThumbnail(actor.orgId, photo.url);

  const link = staffLink(staffContext(actor), "photo", photo.id, photo.url);
  warnUnavailable([link]);
  return { id: photo.id, ...link, uploaderName: photo.uploadedBy.name, createdAt: photo.createdAt };
}

/** One notification for a whole batch of photos (called once by the client after the batch settles).
 * No-ops for an empty batch. */
export async function notifyPhotosAdded(actor: SessionUser, vehicleId: string, rawInput: unknown): Promise<void> {
  const { count } = parseInput(photosAddedBodySchema, rawInput, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);

  const notification = await getPrisma().$transaction(async (tx) => {
    const recipientUserIds = await notificationService.listNotifiableStaffIds(tx, actor.orgId, actor.id);
    const params: notificationService.EmitParams = {
      orgId: actor.orgId,
      event: "DOCUMENT_UPLOADED",
      title: count === 1 ? "Photo added" : "Photos added",
      body: `${actor.name} added ${count} ${count === 1 ? "photo" : "photos"} to ${vehicle.serial}.`,
      vehicleId,
      recipientUserIds,
    };
    await notificationService.emit(tx, params);
    return params;
  });

  notificationService.notifyRealtime(notification);
}

export async function deleteVehiclePhoto(actor: SessionUser, vehicleId: string, photoId: string): Promise<void> {
  await getOwnedVehicle(actor.orgId, vehicleId);
  // Scoped to the (already org-checked) vehicle, so another vehicle's or org's photo id is a 404.
  const photo = await getPrisma().vehiclePhoto.findFirst({ where: { id: photoId, vehicleId } });
  if (!photo) {
    throw new ServiceError("NOT_FOUND", "Photo not found.");
  }

  await getPrisma().$transaction(async (tx) => {
    // Photos have no org column: the write is scoped through the vehicle, which carries org_id.
    const removed = await tx.vehiclePhoto.deleteMany({ where: { id: photoId, vehicleId, vehicle: { org_id: actor.orgId } } });
    if (removed.count !== 1) throw new ServiceError("NOT_FOUND", "Photo not found.");
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "DELETE_VEHICLE_PHOTO",
      entity: "VehiclePhoto",
      entityId: photoId,
      before: fileReference("VEHICLE_PHOTO", photoId, photo.url),
    });
  });

  deleteStoredFile(actor.orgId, photo.url);
  void deletePhotoThumbnail(actor.orgId, photo.url);
}

export async function addVehicleDocument(
  actor: SessionUser,
  vehicleId: string,
  rawInput: unknown
): Promise<VehicleDocumentListItem> {
  const { key, name, documentType } = parseInput(documentBodySchema, rawInput, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);
  const url = await storedUrlForNewFile(actor.orgId, vehicleId, "VEHICLE_DOCUMENT", key);

  const { document, notification } = await getPrisma().$transaction(async (tx) => {
    const created = await tx.vehicleDocument.create({
      data: { vehicleId, url, name, documentType, uploadedById: actor.id },
      include: { uploadedBy: { select: { name: true } } },
    });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "ADD_VEHICLE_DOCUMENT",
      entity: "VehicleDocument",
      entityId: created.id,
      after: { ...fileReference("VEHICLE_DOCUMENT", created.id, url), name, documentType },
    });

    const recipientUserIds = await notificationService.listNotifiableStaffIds(tx, actor.orgId, actor.id);
    const params: notificationService.EmitParams = {
      orgId: actor.orgId,
      event: "DOCUMENT_UPLOADED",
      title: "Document added",
      body: `${actor.name} added ${DOCUMENT_TYPE_META[documentType].label} to ${vehicle.serial}.`,
      vehicleId,
      recipientUserIds,
    };
    await notificationService.emit(tx, params);

    return { document: created, notification: params };
  });

  notificationService.notifyRealtime(notification);
  const link = staffLink(staffContext(actor), "document", document.id, document.url);
  warnUnavailable([link]);
  return {
    id: document.id,
    ...link,
    name: document.name,
    documentType: document.documentType,
    uploaderName: document.uploadedBy.name,
    createdAt: document.createdAt,
  };
}

export async function deleteVehicleDocument(actor: SessionUser, vehicleId: string, documentId: string): Promise<void> {
  await getOwnedVehicle(actor.orgId, vehicleId);
  const document = await getPrisma().vehicleDocument.findFirst({ where: { id: documentId, vehicleId } });
  if (!document) {
    throw new ServiceError("NOT_FOUND", "Document not found.");
  }

  await getPrisma().$transaction(async (tx) => {
    const removed = await tx.vehicleDocument.deleteMany({ where: { id: documentId, vehicleId, vehicle: { org_id: actor.orgId } } });
    if (removed.count !== 1) throw new ServiceError("NOT_FOUND", "Document not found.");
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "DELETE_VEHICLE_DOCUMENT",
      entity: "VehicleDocument",
      entityId: documentId,
      before: { ...fileReference("VEHICLE_DOCUMENT", documentId, document.url), name: document.name },
    });
  });

  deleteStoredFile(actor.orgId, document.url);
}
