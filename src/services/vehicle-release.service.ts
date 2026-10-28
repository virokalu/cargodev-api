// What customers are allowed to see, set by staff: release a vehicle, release photos and documents, and fill in the
// customer-facing details (ports, voyage, amount). Everything is private until released here.

import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import type { SessionUser } from "../lib/session-user.js";
import { computeEffectiveTrack } from "../lib/vehicle-track.js";
import {
  customerInfoBodySchema,
  documentReleaseBodySchema,
  photoReleaseBodySchema,
  photosBulkBodySchema,
  visibilityBodySchema,
} from "../validation/customer-admin.schema.js";
import * as activityLog from "./activity-log.service.js";
import { getOwnedVehicle } from "./file.service.js";
import { emitToVehicleCustomer } from "./customer-notify.service.js";
import { notifyRealtime, type EmitParams } from "./notification.service.js";

const DOCUMENT_NAMES: Record<string, string> = { EC: "export certificate", BL: "bill of lading" };

const INVALID = "Invalid request body.";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const photoNotFound = () => new ServiceError("NOT_FOUND", "Photo not found.");
const documentNotFound = () => new ServiceError("NOT_FOUND", "Document not found.");

// ---------------------------------------------------------------------------------------------

export async function setVehicleCustomerVisibility(actor: SessionUser, vehicleId: string, rawBody: unknown): Promise<{ id: string; customerVisible: boolean }> {
  const { customerVisible } = parseInput(visibilityBodySchema, rawBody, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);

  if (customerVisible) {
    if (!vehicle.customerId) {
      const message = "Link a customer to this vehicle first.";
      throw new ServiceError("VALIDATION", message, { customerVisible: message });
    }
    if (computeEffectiveTrack(vehicle.serialPrefix, vehicle.convertedToExport, vehicle.convertedToLocal) !== "FC") {
      const message = "Only export (FC) vehicles can be shown to a customer.";
      throw new ServiceError("VALIDATION", message, { customerVisible: message });
    }
  }

  await getPrisma().$transaction(async (tx) => {
    const updated = await tx.vehicle.updateMany({ where: { id: vehicle.id, org_id: actor.orgId, deletedAt: null }, data: { customerVisible } });
    if (updated.count === 0) throw new ServiceError("NOT_FOUND", "Vehicle not found.");
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_CUSTOMER_VISIBILITY",
      entity: "Vehicle",
      entityId: vehicle.id,
      before: { customerVisible: vehicle.customerVisible },
      after: { customerVisible },
    });
  });
  return { id: vehicle.id, customerVisible };
}

// ---------------------------------------------------------------------------------------------

export interface CustomerInfo {
  portOfLoading: string | null;
  portOfDischarge: string | null;
  voyageNo: string | null;
}

export async function setVehicleCustomerInfo(actor: SessionUser, vehicleId: string, rawBody: unknown): Promise<CustomerInfo> {
  const changes = parseInput(customerInfoBodySchema, rawBody, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);

  // Only the keys the client sent (zod leaves the others out), never an explicit undefined.
  const data = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));

  return getPrisma().$transaction(async (tx) => {
    // The write carries org_id itself (not only getOwnedVehicle above).
    const written = await tx.vehicle.updateMany({ where: { id: vehicle.id, org_id: actor.orgId }, data });
    if (written.count !== 1) throw new ServiceError("NOT_FOUND", "Vehicle not found.");
    const updated = await tx.vehicle.findFirst({ where: { id: vehicle.id, org_id: actor.orgId }, select: { portOfLoading: true, portOfDischarge: true, voyageNo: true } });
    if (!updated) throw new ServiceError("NOT_FOUND", "Vehicle not found.");
    const dto: CustomerInfo = {
      portOfLoading: updated.portOfLoading,
      portOfDischarge: updated.portOfDischarge,
      voyageNo: updated.voyageNo,
    };
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_CUSTOMER_INFO",
      entity: "Vehicle",
      entityId: vehicle.id,
      before: {
        portOfLoading: vehicle.portOfLoading,
        portOfDischarge: vehicle.portOfDischarge,
        voyageNo: vehicle.voyageNo,
      },
      after: dto,
    });
    return dto;
  });
}

// ---------------------------------------------------------------------------------------------

export async function setDocumentRelease(
  actor: SessionUser,
  vehicleId: string,
  documentId: string,
  rawBody: unknown
): Promise<{ id: string; documentType: string; visibleToCustomer: boolean }> {
  const changes = parseInput(documentReleaseBodySchema, rawBody, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);
  if (!ID.test(documentId)) throw documentNotFound();

  let alert: EmitParams | null = null;
  const result = await getPrisma().$transaction(async (tx) => {
    // Scoped to the (already org-checked) vehicle: another vehicle's or org's document id is a 404.
    const document = await tx.vehicleDocument.findFirst({ where: { id: documentId, vehicleId: vehicle.id }, select: { id: true, documentType: true, visibleToCustomer: true } });
    if (!document) throw documentNotFound();

    // Documents have no org column: the write is scoped through the vehicle, which carries org_id.
    const written = await tx.vehicleDocument.updateMany({
      where: { id: document.id, vehicleId: vehicle.id, vehicle: { org_id: actor.orgId } },
      data: {
        ...(changes.documentType !== undefined ? { documentType: changes.documentType } : {}),
        ...(changes.visibleToCustomer !== undefined ? { visibleToCustomer: changes.visibleToCustomer } : {}),
      },
    });
    if (written.count !== 1) throw documentNotFound();
    const updated = await tx.vehicleDocument.findFirst({ where: { id: document.id, vehicleId: vehicle.id, vehicle: { org_id: actor.orgId } }, select: { id: true, documentType: true, visibleToCustomer: true } });
    if (!updated) throw documentNotFound();
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_DOCUMENT_RELEASE",
      entity: "VehicleDocument",
      entityId: document.id,
      before: { documentType: document.documentType, visibleToCustomer: document.visibleToCustomer },
      after: { documentType: updated.documentType, visibleToCustomer: updated.visibleToCustomer },
    });
    // Newly released export certificate or bill of lading: the customer is waiting for these.
    const name = DOCUMENT_NAMES[updated.documentType];
    if (name && updated.visibleToCustomer && !(document.visibleToCustomer && document.documentType === updated.documentType)) {
      alert = await emitToVehicleCustomer(tx, {
        orgId: actor.orgId,
        vehicleId: vehicle.id,
        event: "DOCUMENTS_READY",
        title: () => "Document ready",
        body: (serial) => `The ${name} for ${serial} is ready.`,
      });
    }
    return { id: updated.id, documentType: updated.documentType, visibleToCustomer: updated.visibleToCustomer };
  });
  if (alert) notifyRealtime(alert);
  return result;
}

export async function setPhotoRelease(actor: SessionUser, vehicleId: string, photoId: string, rawBody: unknown): Promise<{ id: string; visibleToCustomer: boolean }> {
  const { visibleToCustomer } = parseInput(photoReleaseBodySchema, rawBody, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);
  if (!ID.test(photoId)) throw photoNotFound();

  let alert: EmitParams | null = null;
  const result = await getPrisma().$transaction(async (tx) => {
    const photo = await tx.vehiclePhoto.findFirst({ where: { id: photoId, vehicleId: vehicle.id }, select: { id: true, visibleToCustomer: true } });
    if (!photo) throw photoNotFound();
    const written = await tx.vehiclePhoto.updateMany({ where: { id: photo.id, vehicleId: vehicle.id, vehicle: { org_id: actor.orgId } }, data: { visibleToCustomer } });
    if (written.count !== 1) throw photoNotFound();
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_PHOTO_RELEASE",
      entity: "VehiclePhoto",
      entityId: photo.id,
      before: { visibleToCustomer: photo.visibleToCustomer },
      after: { visibleToCustomer },
    });
    if (visibleToCustomer && !photo.visibleToCustomer) alert = await photosAddedAlert(tx, actor.orgId, vehicle.id);
    return { id: photo.id, visibleToCustomer };
  });
  if (alert) notifyRealtime(alert);
  return result;
}

/** One alert per burst of photo releases (10 minutes), never one per photo. */
function photosAddedAlert(tx: Parameters<typeof emitToVehicleCustomer>[0], orgId: string, vehicleId: string) {
  return emitToVehicleCustomer(tx, {
    orgId,
    vehicleId,
    event: "PHOTOS_ADDED",
    title: () => "New photos",
    body: (serial) => `New photos are available for ${serial}.`,
    coalesceMinutes: 10,
  });
}

/** Release (or hide) a chosen set of a vehicle's photos in one step. Every id must be one of THIS vehicle's photos, or nothing changes. */
export async function setPhotosRelease(actor: SessionUser, vehicleId: string, rawBody: unknown): Promise<{ updated: number; visibleToCustomer: boolean }> {
  const { visibleToCustomer, photoIds } = parseInput(photosBulkBodySchema, rawBody, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);
  const ids = [...new Set(photoIds)];

  let alert: EmitParams | null = null;
  const outcome = await getPrisma().$transaction(async (tx) => {
    const found = await tx.vehiclePhoto.findMany({ where: { vehicleId: vehicle.id, id: { in: ids } }, select: { id: true, visibleToCustomer: true } });
    if (found.length !== ids.length) throw photoNotFound();

    const result = await tx.vehiclePhoto.updateMany({ where: { vehicleId: vehicle.id, vehicle: { org_id: actor.orgId }, id: { in: ids } }, data: { visibleToCustomer } });
    if (result.count !== ids.length) throw photoNotFound();
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_PHOTOS_RELEASE",
      entity: "Vehicle",
      entityId: vehicle.id,
      after: { visibleToCustomer, photoIds: ids },
    });
    if (visibleToCustomer && found.some((photo) => !photo.visibleToCustomer)) alert = await photosAddedAlert(tx, actor.orgId, vehicle.id);
    return { updated: result.count, visibleToCustomer };
  });
  if (alert) notifyRealtime(alert);
  return outcome;
}

// ---------------------------------------------------------------------------------------------

/** Booleans and counts only: no ids, no names, no addresses. Read-only. */
export interface ReleaseReadiness {
  customerLinked: boolean;
  customerVisible: boolean;
  photosReleased: number;
  photosHidden: number;
  documentsReleased: number;
  documentsHidden: number;
}

export async function getReleaseReadiness(actor: SessionUser, vehicleId: string): Promise<ReleaseReadiness> {
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId); // another org's, a deleted or an unknown vehicle: 404
  const prisma = getPrisma();
  const [photosReleased, photosHidden, documentsReleased, documentsHidden] = await Promise.all([
    prisma.vehiclePhoto.count({ where: { vehicleId: vehicle.id, visibleToCustomer: true } }),
    prisma.vehiclePhoto.count({ where: { vehicleId: vehicle.id, visibleToCustomer: false } }),
    prisma.vehicleDocument.count({ where: { vehicleId: vehicle.id, visibleToCustomer: true } }),
    prisma.vehicleDocument.count({ where: { vehicleId: vehicle.id, visibleToCustomer: false } }),
  ]);
  return {
    customerLinked: vehicle.customerId !== null && vehicle.customerId !== undefined,
    customerVisible: vehicle.customerVisible === true,
    photosReleased,
    photosHidden,
    documentsReleased,
    documentsHidden,
  };
}
