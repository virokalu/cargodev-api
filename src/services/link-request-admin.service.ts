// Staff decide on customers' requests to be linked to a vehicle. Approving creates the ownership link (the vehicle's
// customer) and tells the customer; it does NOT release the vehicle (that is a separate step), and the customer is never
// told why a request was declined.

import type { LinkRequestStatus } from "@prisma/client";
import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import type { SessionUser } from "../lib/session-user.js";
import { emptyBodySchema, linkApproveBodySchema, linkRequestListQuerySchema } from "../validation/customer-admin.schema.js";
import * as activityLog from "./activity-log.service.js";
import * as notificationService from "./notification.service.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOT_FOUND = () => new ServiceError("NOT_FOUND", "Link request not found.");

export interface LinkRequestRow {
  id: string;
  status: LinkRequestStatus;
  serialEntered: string;
  createdAt: string;
  decidedAt: string | null;
  customer: { id: string; name: string; email: string | null; companyName: string | null } | null;
  /** The vehicle the request was approved for. */
  vehicle: { id: string; serial: string } | null;
  /** A vehicle in this org with the serial that was typed, if any (staff only). */
  matchedVehicle: { id: string; serial: string; ownedByThisCustomer: boolean; ownedByAnotherCustomer: boolean } | null;
}

export async function listLinkRequests(orgId: string, rawQuery: unknown): Promise<{ rows: LinkRequestRow[]; total: number; page: number; pageSize: number }> {
  const q = parseInput(linkRequestListQuerySchema, rawQuery);
  const prisma = getPrisma();
  const where = { org_id: orgId, status: q.status };

  const [total, requests] = await Promise.all([
    prisma.vehicleLinkRequest.count({ where }),
    prisma.vehicleLinkRequest.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, status: true, serialEntered: true, createdAt: true, decidedAt: true, customerId: true, vehicleId: true },
    }),
  ]);

  const customerIds = [...new Set(requests.map((r) => r.customerId))];
  const serials = [...new Set(requests.map((r) => r.serialEntered))];
  const vehicleIds = requests.flatMap((r) => (r.vehicleId ? [r.vehicleId] : []));
  const [customers, matched, decided] = await Promise.all([
    customerIds.length ? prisma.user.findMany({ where: { org_id: orgId, id: { in: customerIds } }, select: { id: true, name: true, email: true, companyName: true } }) : [],
    serials.length ? prisma.vehicle.findMany({ where: { org_id: orgId, deletedAt: null, serial: { in: serials } }, select: { id: true, serial: true, customerId: true } }) : [],
    vehicleIds.length ? prisma.vehicle.findMany({ where: { org_id: orgId, id: { in: vehicleIds } }, select: { id: true, serial: true } }) : [],
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c] as const));
  const matchedBySerial = new Map(matched.map((v) => [v.serial, v] as const));
  const decidedById = new Map(decided.map((v) => [v.id, v] as const));

  return {
    rows: requests.map((r) => {
      const customer = customerById.get(r.customerId);
      const match = matchedBySerial.get(r.serialEntered);
      const target = r.vehicleId ? decidedById.get(r.vehicleId) : undefined;
      return {
        id: r.id,
        status: r.status,
        serialEntered: r.serialEntered,
        createdAt: r.createdAt.toISOString(),
        decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
        customer: customer ? { id: customer.id, name: customer.name, email: customer.email, companyName: customer.companyName } : null,
        vehicle: target ? { id: target.id, serial: target.serial } : null,
        matchedVehicle: match
          ? { id: match.id, serial: match.serial, ownedByThisCustomer: match.customerId === r.customerId, ownedByAnotherCustomer: match.customerId !== null && match.customerId !== r.customerId }
          : null,
      };
    }),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

async function loadPending(orgId: string, requestId: string) {
  if (!ID.test(requestId)) throw NOT_FOUND();
  const request = await getPrisma().vehicleLinkRequest.findFirst({ where: { id: requestId, org_id: orgId }, select: { id: true, status: true, customerId: true, serialEntered: true } });
  if (!request) throw NOT_FOUND();
  if (request.status !== "PENDING") throw new ServiceError("CONFLICT", "This request has already been decided.");
  return request;
}

export async function approveLinkRequest(actor: SessionUser, requestId: string, rawBody: unknown): Promise<{ id: string; status: "APPROVED"; vehicle: { id: string; serial: string } }> {
  const { vehicleId } = parseInput(linkApproveBodySchema, rawBody ?? {}, "Invalid request body.");
  const request = await loadPending(actor.orgId, requestId);
  const prisma = getPrisma();

  const customer = await prisma.user.findFirst({
    where: { id: request.customerId, org_id: actor.orgId, userType: "CUSTOMER", deletedAt: null },
    select: { id: true },
  });
  if (!customer) throw new ServiceError("VALIDATION", "The customer account no longer exists.");

  // The staff member can name the vehicle, otherwise it is the one with the serial the customer typed. Same org, not deleted.
  const vehicle = await prisma.vehicle.findFirst({
    where: { org_id: actor.orgId, deletedAt: null, ...(vehicleId ? { id: vehicleId } : { serial: request.serialEntered }) },
    select: { id: true, serial: true, customerId: true },
  });
  if (!vehicle) {
    const message = vehicleId ? "Vehicle not found." : `No vehicle has the serial ${request.serialEntered}. Choose the vehicle.`;
    throw new ServiceError("VALIDATION", message, { vehicleId: message });
  }
  if (vehicle.customerId && vehicle.customerId !== customer.id) {
    throw new ServiceError("CONFLICT", "That vehicle is already linked to another customer.");
  }

  const notification = await prisma.$transaction(async (tx) => {
    // Conditional on still being pending: two staff deciding at once, or a double click, cannot both win.
    const claimed = await tx.vehicleLinkRequest.updateMany({
      where: { id: request.id, org_id: actor.orgId, status: "PENDING" },
      data: { status: "APPROVED", vehicleId: vehicle.id, decidedById: actor.id, decidedAt: new Date() },
    });
    if (claimed.count === 0) throw new ServiceError("CONFLICT", "This request has already been decided.");

    // ...and the vehicle still has no other owner (checked again here, where it cannot change underneath us).
    const linked = await tx.vehicle.updateMany({
      where: { id: vehicle.id, org_id: actor.orgId, deletedAt: null, OR: [{ customerId: null }, { customerId: customer.id }] },
      data: { customerId: customer.id },
    });
    if (linked.count === 0) throw new ServiceError("CONFLICT", "That vehicle is already linked to another customer.");

    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "APPROVE_LINK_REQUEST",
      entity: "VehicleLinkRequest",
      entityId: request.id,
      before: { status: "PENDING", vehicleCustomerId: vehicle.customerId },
      after: { status: "APPROVED", vehicleId: vehicle.id, customerId: customer.id },
    });

    const params: notificationService.EmitParams = {
      orgId: actor.orgId,
      event: "LINK_REQUEST_APPROVED",
      title: "Vehicle linked",
      body: `Your request to link ${request.serialEntered} was approved.`,
      vehicleId: vehicle.id,
      recipientUserIds: [customer.id],
    };
    await notificationService.emit(tx, params);
    return params;
  });

  notificationService.notifyRealtime(notification);
  return { id: request.id, status: "APPROVED", vehicle: { id: vehicle.id, serial: vehicle.serial } };
}

export async function rejectLinkRequest(actor: SessionUser, requestId: string, rawBody: unknown): Promise<{ id: string; status: "REJECTED" }> {
  parseInput(emptyBodySchema, rawBody ?? {}, "Invalid request body.");
  const request = await loadPending(actor.orgId, requestId);

  const notification = await getPrisma().$transaction(async (tx) => {
    const claimed = await tx.vehicleLinkRequest.updateMany({
      where: { id: request.id, org_id: actor.orgId, status: "PENDING" },
      data: { status: "REJECTED", decidedById: actor.id, decidedAt: new Date() },
    });
    if (claimed.count === 0) throw new ServiceError("CONFLICT", "This request has already been decided.");

    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "REJECT_LINK_REQUEST",
      entity: "VehicleLinkRequest",
      entityId: request.id,
      before: { status: "PENDING" },
      after: { status: "REJECTED" },
    });

    // No reason is given to the customer, and nothing says whether the vehicle exists.
    const params: notificationService.EmitParams = {
      orgId: actor.orgId,
      event: "LINK_REQUEST_REJECTED",
      title: "Vehicle request",
      body: `Your request to link ${request.serialEntered} could not be approved.`,
      recipientUserIds: [request.customerId],
    };
    await notificationService.emit(tx, params);
    return params;
  });

  notificationService.notifyRealtime(notification);
  return { id: request.id, status: "REJECTED" };
}
