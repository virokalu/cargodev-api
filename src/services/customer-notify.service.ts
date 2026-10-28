// Tells the customer who owns a vehicle that something happened to it. The alert is written inside the caller's
// transaction (emit), delivery (stream, push, email) happens after commit (notifyRealtime). A customer hears about a
// vehicle ONLY while they may see it: the same "released, export track, not cancelled" rule as the read API.

import type { Prisma } from "@prisma/client";
import { emit, type EmitParams, type NotificationEvent } from "./notification.service.js";
import { customerVehicleWhere } from "./customer-data.service.js";

type TxClient = Prisma.TransactionClient;

export interface VehicleCustomerEvent {
  orgId: string;
  vehicleId: string;
  event: NotificationEvent;
  title: (serial: string) => string;
  body: (serial: string) => string;
  /** Skip if this customer already got the same event for this vehicle within this many minutes (a burst becomes one alert). */
  coalesceMinutes?: number;
}

/** Returns the params to hand to notifyRealtime after commit, or null when nobody should be told. */
export async function emitToVehicleCustomer(tx: TxClient, input: VehicleCustomerEvent): Promise<EmitParams | null> {
  const owner = await tx.vehicle.findFirst({
    where: { id: input.vehicleId, org_id: input.orgId, deletedAt: null },
    select: { customerId: true, serial: true },
  });
  if (!owner?.customerId) return null;

  const visible = await tx.vehicle.findFirst({
    where: { AND: [customerVehicleWhere({ id: owner.customerId, orgId: input.orgId }), { id: input.vehicleId }] },
    select: { id: true },
  });
  if (!visible) return null;

  if (input.coalesceMinutes) {
    const since = new Date(Date.now() - input.coalesceMinutes * 60_000);
    const recent = await tx.notification.findFirst({
      where: { org_id: input.orgId, userId: owner.customerId, event: input.event, vehicleId: input.vehicleId, createdAt: { gte: since } },
      select: { id: true },
    });
    if (recent) return null;
  }

  const params: EmitParams = {
    orgId: input.orgId,
    event: input.event,
    title: input.title(owner.serial),
    body: input.body(owner.serial),
    vehicleId: input.vehicleId,
    recipientUserIds: [owner.customerId],
  };
  await emit(tx, params);
  return params.recipientUserIds.length > 0 ? params : null;
}
