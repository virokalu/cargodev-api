// Staff tools for customer accounts: switch sign-in on or off, assign the responsible agent, see who is online.

import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import type { SessionUser } from "../lib/session-user.js";
import { agentBodySchema, loginAccessBodySchema } from "../validation/customer-admin.schema.js";
import * as activityLog from "./activity-log.service.js";
import { revokeAllCustomerSessions } from "./customer-auth.service.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOT_FOUND = () => new ServiceError("NOT_FOUND", "Customer not found.");

/** Online means: seen in the last 5 minutes. */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export async function setCustomerLoginAccess(actor: SessionUser, customerId: string, rawBody: unknown): Promise<{ id: string; loginEnabled: boolean }> {
  const { loginEnabled } = parseInput(loginAccessBodySchema, rawBody, "Invalid request body.");
  if (!ID.test(customerId)) throw NOT_FOUND();

  return getPrisma().$transaction(async (tx) => {
    const customer = await tx.user.findFirst({
      where: { id: customerId, org_id: actor.orgId, userType: "CUSTOMER", deletedAt: null },
      select: { id: true, email: true, loginEnabled: true },
    });
    if (!customer) throw NOT_FOUND();
    if (loginEnabled && !customer.email) {
      const message = "This customer has no email address, so they could not set a password.";
      throw new ServiceError("VALIDATION", message, { loginEnabled: message });
    }

    const written = await tx.user.updateMany({ where: { id: customer.id, org_id: actor.orgId, userType: "CUSTOMER" }, data: { loginEnabled } });
    if (written.count !== 1) throw NOT_FOUND();
    if (!loginEnabled) {
      // Switching sign-in off ends every session at once and stops push notifications to their phones.
      await revokeAllCustomerSessions(tx, actor.orgId, customer.id);
      await tx.deviceToken.deleteMany({ where: { org_id: actor.orgId, userId: customer.id } });
    }
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: loginEnabled ? "ENABLE_CUSTOMER_LOGIN" : "DISABLE_CUSTOMER_LOGIN",
      entity: "Customer",
      entityId: customer.id,
      before: { loginEnabled: customer.loginEnabled },
      after: { loginEnabled },
    });
    return { id: customer.id, loginEnabled };
  });
}

export async function setCustomerAgent(actor: SessionUser, customerId: string, rawBody: unknown): Promise<{ id: string; assignedAgentId: string | null }> {
  const { agentId } = parseInput(agentBodySchema, rawBody, "Invalid request body.");
  if (!ID.test(customerId)) throw NOT_FOUND();

  return getPrisma().$transaction(async (tx) => {
    const customer = await tx.user.findFirst({
      where: { id: customerId, org_id: actor.orgId, userType: "CUSTOMER", deletedAt: null },
      select: { id: true, assignedAgentId: true },
    });
    if (!customer) throw NOT_FOUND();

    if (agentId !== null) {
      // The agent must be a staff member of THIS org who can sign in.
      const agent = await tx.user.findFirst({ where: { id: agentId, org_id: actor.orgId, userType: "STAFF", loginEnabled: true }, select: { id: true } });
      if (!agent) throw new ServiceError("VALIDATION", "Select an active staff member.", { agentId: "Select an active staff member." });
    }

    const written = await tx.user.updateMany({ where: { id: customer.id, org_id: actor.orgId, userType: "CUSTOMER" }, data: { assignedAgentId: agentId } });
    if (written.count !== 1) throw NOT_FOUND();
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "ASSIGN_CUSTOMER_AGENT",
      entity: "Customer",
      entityId: customer.id,
      before: { assignedAgentId: customer.assignedAgentId },
      after: { assignedAgentId: agentId },
    });
    return { id: customer.id, assignedAgentId: agentId };
  });
}

export interface ActiveCustomer {
  id: string;
  name: string;
  companyName: string | null;
  lastActiveAt: string;
}

export async function listActiveCustomers(orgId: string, now = new Date()): Promise<ActiveCustomer[]> {
  const rows = await getPrisma().user.findMany({
    where: { org_id: orgId, userType: "CUSTOMER", deletedAt: null, lastActiveAt: { gte: new Date(now.getTime() - ACTIVE_WINDOW_MS) } },
    select: { id: true, name: true, companyName: true, lastActiveAt: true },
    orderBy: [{ lastActiveAt: "desc" }, { id: "asc" }],
    take: 200,
  });
  return rows.flatMap((r) => (r.lastActiveAt ? [{ id: r.id, name: r.name, companyName: r.companyName, lastActiveAt: r.lastActiveAt.toISOString() }] : []));
}
