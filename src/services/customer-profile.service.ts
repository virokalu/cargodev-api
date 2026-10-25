// The signed-in customer's own profile. Every field of the response is listed here, one by one:
// a database row is never returned as it is.

import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import { customerUpdateMeSchema } from "../validation/customer-auth.schema.js";
import * as activityLog from "./activity-log.service.js";

export interface CustomerMe {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  country: string | null;
  destinationPort: string | null;
  language: string;
  theme: string | null;
  memberSince: string;
}

const meSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  companyName: true,
  country: true,
  destinationPort: true,
  language: true,
  theme: true,
  createdAt: true,
} as const;

function toMe(row: {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  country: string | null;
  destinationPort: string | null;
  language: string | null;
  theme: string | null;
  createdAt: Date;
}): CustomerMe {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    companyName: row.companyName,
    country: row.country,
    destinationPort: row.destinationPort,
    language: row.language ?? "en",
    theme: row.theme,
    memberSince: row.createdAt.toISOString(),
  };
}

export async function getMe(customer: { id: string; orgId: string }): Promise<CustomerMe> {
  const row = await getPrisma().user.findFirst({
    where: { id: customer.id, org_id: customer.orgId, userType: "CUSTOMER", deletedAt: null },
    select: meSelect,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Account not found.");
  return toMe(row);
}

export async function updateMe(customer: { id: string; orgId: string }, rawBody: unknown): Promise<CustomerMe> {
  const changes = parseInput(customerUpdateMeSchema, rawBody, "Please fix the highlighted fields.");
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.findFirst({
      where: { id: customer.id, org_id: customer.orgId, userType: "CUSTOMER", deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new ServiceError("NOT_FOUND", "Account not found.");

    // Only the keys the client sent (zod leaves the others out), never an explicit undefined.
    const data = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    const row = await tx.user.update({ where: { id: customer.id }, data, select: meSelect });
    // Field names only: the log is read by staff and holds no personal values.
    await activityLog.record(tx, {
      orgId: customer.orgId,
      actorId: customer.id,
      action: "CUSTOMER_UPDATE_PROFILE",
      entity: "Customer",
      entityId: customer.id,
      after: { fields: Object.keys(changes) },
    });
    return toMe(row);
  });
}
