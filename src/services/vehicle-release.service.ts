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
  customerAmount: number | null;
  customerAmountCurrency: string | null;
}

const toNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : typeof value === "number" ? value : Number((value as { toString(): string }).toString());

export async function setVehicleCustomerInfo(actor: SessionUser, vehicleId: string, rawBody: unknown): Promise<CustomerInfo> {
  const changes = parseInput(customerInfoBodySchema, rawBody, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);

  // Only the keys the client sent (zod leaves the others out), never an explicit undefined.
  const data = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));

  return getPrisma().$transaction(async (tx) => {
    const updated = await tx.vehicle.update({
      where: { id: vehicle.id },
      data,
      select: { portOfLoading: true, portOfDischarge: true, voyageNo: true, customerAmount: true, customerAmountCurrency: true },
    });
    const dto: CustomerInfo = {
      portOfLoading: updated.portOfLoading,
      portOfDischarge: updated.portOfDischarge,
      voyageNo: updated.voyageNo,
      customerAmount: toNumber(updated.customerAmount),
      customerAmountCurrency: updated.customerAmountCurrency,
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
        customerAmount: toNumber(vehicle.customerAmount),
        customerAmountCurrency: vehicle.customerAmountCurrency,
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

  return getPrisma().$transaction(async (tx) => {
    // Scoped to the (already org-checked) vehicle: another vehicle's or org's document id is a 404.
    const document = await tx.vehicleDocument.findFirst({ where: { id: documentId, vehicleId: vehicle.id }, select: { id: true, documentType: true, visibleToCustomer: true } });
    if (!document) throw documentNotFound();

    const updated = await tx.vehicleDocument.update({
      where: { id: document.id },
      data: {
        ...(changes.documentType !== undefined ? { documentType: changes.documentType } : {}),
        ...(changes.visibleToCustomer !== undefined ? { visibleToCustomer: changes.visibleToCustomer } : {}),
      },
      select: { id: true, documentType: true, visibleToCustomer: true },
    });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_DOCUMENT_RELEASE",
      entity: "VehicleDocument",
      entityId: document.id,
      before: { documentType: document.documentType, visibleToCustomer: document.visibleToCustomer },
      after: { documentType: updated.documentType, visibleToCustomer: updated.visibleToCustomer },
    });
    return { id: updated.id, documentType: updated.documentType, visibleToCustomer: updated.visibleToCustomer };
  });
}

export async function setPhotoRelease(actor: SessionUser, vehicleId: string, photoId: string, rawBody: unknown): Promise<{ id: string; visibleToCustomer: boolean }> {
  const { visibleToCustomer } = parseInput(photoReleaseBodySchema, rawBody, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);
  if (!ID.test(photoId)) throw photoNotFound();

  return getPrisma().$transaction(async (tx) => {
    const photo = await tx.vehiclePhoto.findFirst({ where: { id: photoId, vehicleId: vehicle.id }, select: { id: true, visibleToCustomer: true } });
    if (!photo) throw photoNotFound();
    await tx.vehiclePhoto.update({ where: { id: photo.id }, data: { visibleToCustomer } });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_PHOTO_RELEASE",
      entity: "VehiclePhoto",
      entityId: photo.id,
      before: { visibleToCustomer: photo.visibleToCustomer },
      after: { visibleToCustomer },
    });
    return { id: photo.id, visibleToCustomer };
  });
}

/** Release (or hide) a chosen set of a vehicle's photos in one step. Every id must be one of THIS vehicle's photos, or nothing changes. */
export async function setPhotosRelease(actor: SessionUser, vehicleId: string, rawBody: unknown): Promise<{ updated: number; visibleToCustomer: boolean }> {
  const { visibleToCustomer, photoIds } = parseInput(photosBulkBodySchema, rawBody, INVALID);
  const vehicle = await getOwnedVehicle(actor.orgId, vehicleId);
  const ids = [...new Set(photoIds)];

  return getPrisma().$transaction(async (tx) => {
    const found = await tx.vehiclePhoto.findMany({ where: { vehicleId: vehicle.id, id: { in: ids } }, select: { id: true } });
    if (found.length !== ids.length) throw photoNotFound();

    const result = await tx.vehiclePhoto.updateMany({ where: { vehicleId: vehicle.id, id: { in: ids } }, data: { visibleToCustomer } });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_PHOTOS_RELEASE",
      entity: "Vehicle",
      entityId: vehicle.id,
      after: { visibleToCustomer, photoIds: ids },
    });
    return { updated: result.count, visibleToCustomer };
  });
}
