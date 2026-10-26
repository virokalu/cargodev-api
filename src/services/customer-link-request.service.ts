// A customer asking to be linked to a vehicle by its serial number.
//
// The answer is always the same and NOTHING here looks the vehicle up: a request never confirms or denies that a serial
// exists, and takes the same path whether or not it does. Staff see the request and decide (slice 4). Repeats of a
// pending request and a runaway number of pending requests are ignored silently, with the same answer.

import { getPrisma } from "../lib/prisma.js";
import { parseInput } from "../lib/parse.js";
import { linkRequestBodySchema } from "../validation/customer-data.schema.js";
import * as activityLog from "./activity-log.service.js";
import * as notificationService from "./notification.service.js";

const MAX_PENDING_PER_CUSTOMER = 20;

export const LINK_REQUEST_ACCEPTED = { accepted: true } as const;

export async function createLinkRequest(customer: { id: string; orgId: string }, rawBody: unknown): Promise<typeof LINK_REQUEST_ACCEPTED> {
  const { serial } = parseInput(linkRequestBodySchema, rawBody, "Enter a serial number such as FC1024.");
  const prisma = getPrisma();

  const notification = await prisma.$transaction(async (tx) => {
    const account = await tx.user.findFirst({
      where: { id: customer.id, org_id: customer.orgId, userType: "CUSTOMER", deletedAt: null },
      select: { name: true, assignedAgentId: true },
    });
    if (!account) return null;

    const [pending, duplicate] = await Promise.all([
      tx.vehicleLinkRequest.count({ where: { org_id: customer.orgId, customerId: customer.id, status: "PENDING" } }),
      tx.vehicleLinkRequest.count({ where: { org_id: customer.orgId, customerId: customer.id, status: "PENDING", serialEntered: serial } }),
    ]);
    if (duplicate > 0 || pending >= MAX_PENDING_PER_CUSTOMER) return null;

    const created = await tx.vehicleLinkRequest.create({
      data: { org_id: customer.orgId, customerId: customer.id, serialEntered: serial, status: "PENDING" },
      select: { id: true },
    });
    await activityLog.record(tx, {
      orgId: customer.orgId,
      actorId: customer.id,
      action: "CREATE_LINK_REQUEST",
      entity: "VehicleLinkRequest",
      entityId: created.id,
      after: { serial },
    });

    // Administrators and managers, plus the customer's assigned agent when there is one (and they can sign in).
    const recipients = new Set(await notificationService.listNotifiableStaffIds(tx, customer.orgId));
    if (account.assignedAgentId) {
      const agent = await tx.user.findFirst({
        where: { id: account.assignedAgentId, org_id: customer.orgId, userType: "STAFF", loginEnabled: true },
        select: { id: true },
      });
      if (agent) recipients.add(agent.id);
    }
    const params: notificationService.EmitParams = {
      orgId: customer.orgId,
      event: "VEHICLE_LINK_REQUESTED",
      title: "Vehicle link request",
      body: `${account.name} asked to be linked to ${serial}.`,
      recipientUserIds: [...recipients],
    };
    await notificationService.emit(tx, params);
    return params;
  });

  if (notification) notificationService.notifyRealtime(notification);
  return LINK_REQUEST_ACCEPTED;
}
