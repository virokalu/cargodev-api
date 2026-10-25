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
import { checkNewFileUrl, deleteObject, keyFromOwnedUrlForOrg, type FileKind } from "../lib/object-storage.js";
import { DOCUMENT_TYPE_META } from "../lib/constants/document-type.js";
import { parseInput } from "../lib/parse.js";
import { documentBodySchema, fileUrlBodySchema, photosAddedBodySchema } from "../validation/file.schema.js";
import * as activityLog from "./activity-log.service.js";
import * as notificationService from "./notification.service.js";

/** The vehicle if it is in this org and not soft-deleted; otherwise the standard 404. */
export async function getOwnedVehicle(orgId: string, vehicleId: string) {
  const vehicle = await getPrisma().vehicle.findFirst({ where: { id: vehicleId, org_id: orgId, deletedAt: null } });
  if (!vehicle) {
    throw new ServiceError("NOT_FOUND", "Vehicle not found.");
  }
  return vehicle;
}

const INVALID = "Please fix the highlighted fields.";

/** A new file URL must be this org's own upload for this vehicle and kind. */
function assertNewFileUrl(orgId: string, vehicleId: string, kind: FileKind, url: string): void {
  const message = checkNewFileUrl(orgId, url, kind, vehicleId);
  if (message) throw new ServiceError("VALIDATION", message, { url: message });
}

/** Best effort cleanup of a replaced/deleted file. Only objects inside THIS org's folder are ever touched. */
function deleteStoredFile(orgId: string, url: string): void {
  const key = keyFromOwnedUrlForOrg(orgId, url);
  if (!key) return;
  deleteObject(key).catch((error: unknown) => console.error("object delete failed", safeError(error)));
}

export interface VehiclePhotoListItem {
  id: string;
  url: string;
  uploaderName: string;
  createdAt: Date;
}

export interface VehicleDocumentListItem {
  id: string;
  url: string;
  name: string;
  documentType: VehicleDocumentType;
  uploaderName: string;
  createdAt: Date;
}

export interface VehicleFiles {
  auctionSheetUrl: string | null;
  photos: VehiclePhotoListItem[];
  documents: VehicleDocumentListItem[];
}

export async function listVehicleFiles(orgId: string, vehicleId: string): Promise<VehicleFiles> {
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

export interface VehiclePdfImages {
  auctionSheetDataUrl: string | null;
  photoDataUrls: string[];
}

/** Limits for the server-side fetch of a stored image. */
export const PDF_IMAGE_FETCH = { timeoutMs: 10_000, maxBytes: 15 * 1024 * 1024 } as const;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function readCapped(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetches one stored image and returns it as a data URL, or null. The URL is re-checked against this
 * org's folder first (rows written before validation existed may hold anything), redirects are refused
 * (a redirect could send us to an internal address), and size, time and content type are capped.
 */
async function fetchAsDataUrl(orgId: string, url: string): Promise<string | null> {
  if (!keyFromOwnedUrlForOrg(orgId, url)) return null;
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(PDF_IMAGE_FETCH.timeoutMs),
    });
    if (!response.ok) return null;
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) return null;
    const buffer = await readCapped(response, PDF_IMAGE_FETCH.maxBytes);
    if (!buffer) return null;
    return `data:${contentType};base64,${buffer.toString("base64")}`;
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
  const files = await listVehicleFiles(orgId, vehicleId);

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
): Promise<{ auctionSheetUrl: string }> {
  const { url } = parseInput(fileUrlBodySchema, rawInput, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);
  assertNewFileUrl(actor.orgId, vehicleId, "AUCTION_SHEET", url);

  const result = await getPrisma().$transaction(async (tx) => {
    const updated = await tx.vehicle.update({ where: { id: vehicleId }, data: { auctionSheetUrl: url } });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_AUCTION_SHEET",
      entity: "Vehicle",
      entityId: vehicleId,
      before: { auctionSheetUrl: vehicle.auctionSheetUrl },
      after: { auctionSheetUrl: url },
    });
    return updated;
  });

  // Best-effort cleanup of the replaced file: a storage failure never blocks the replace.
  if (vehicle.auctionSheetUrl && vehicle.auctionSheetUrl !== url) deleteStoredFile(actor.orgId, vehicle.auctionSheetUrl);

  return { auctionSheetUrl: result.auctionSheetUrl! };
}

// No per-photo notification here: a multi-file upload calls this once per file as each finishes, so
// notifying inside would turn "5 images uploaded" into 5 pings. Each photo still gets its own
// ActivityLog row; only the NOTIFICATION is batched, via notifyPhotosAdded, called once per batch.
export async function addVehiclePhoto(
  actor: SessionUser,
  vehicleId: string,
  rawInput: unknown
): Promise<VehiclePhotoListItem> {
  const { url } = parseInput(fileUrlBodySchema, rawInput, INVALID);
  await getOwnedVehicle(actor.orgId, vehicleId);
  assertNewFileUrl(actor.orgId, vehicleId, "VEHICLE_PHOTO", url);

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
      after: { url },
    });
    return created;
  });

  return { id: photo.id, url: photo.url, uploaderName: photo.uploadedBy.name, createdAt: photo.createdAt };
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
    await tx.vehiclePhoto.delete({ where: { id: photoId } });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "DELETE_VEHICLE_PHOTO",
      entity: "VehiclePhoto",
      entityId: photoId,
      before: { url: photo.url },
    });
  });

  deleteStoredFile(actor.orgId, photo.url);
}

export async function addVehicleDocument(
  actor: SessionUser,
  vehicleId: string,
  rawInput: unknown
): Promise<VehicleDocumentListItem> {
  const { url, name, documentType } = parseInput(documentBodySchema, rawInput, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);
  assertNewFileUrl(actor.orgId, vehicleId, "VEHICLE_DOCUMENT", url);

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
      after: { url, name, documentType },
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
  return {
    id: document.id,
    url: document.url,
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
    await tx.vehicleDocument.delete({ where: { id: documentId } });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "DELETE_VEHICLE_DOCUMENT",
      entity: "VehicleDocument",
      entityId: documentId,
      before: { url: document.url, name: document.name },
    });
  });

  deleteStoredFile(actor.orgId, document.url);
}
