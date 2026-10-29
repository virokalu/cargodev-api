// Customer (userType = CUSTOMER) service — Tech Doc §5, CD-D2-14/15. Two
// tiers of functions live here:
//   - searchCustomers / createCustomer: the minimal slice the Add Vehicle
//     Customer combobox needs (search existing, create a name-only one inline).
//   - listCustomers / createCustomerFull / updateCustomer: the full Customers
//     screen (separate from Users — Tech Doc §5, US-29).
//
// Customers are User rows with userType = CUSTOMER — no uniqueness
// constraint on name, since people can legitimately share names.

import { Prisma } from "@prisma/client";
import { getPrisma } from "../lib/prisma.js";
import { ServiceError } from "../lib/errors.js";
import { buildTrackWhere, type TrackFilter } from "../lib/vehicle-track.js";
import type { SessionUser } from "../lib/session-user.js";
import {
  customerCreateSchema,
  customerUpdateSchema,
} from "../validation/customer.schema.js";
import { flattenFieldErrors, nameSchema } from "../validation/shared.js";
import * as activityLog from "./activity-log.service.js";

export interface CustomerOption {
  id: string;
  name: string;
}

/** Resolves a single customer's label for the vehicle filter bar — only
 * called when the Customer filter is actually active, never as part of
 * listing customers. Mirrors the lookup services' getXById pattern. */
export async function getCustomerById(orgId: string, id: string): Promise<CustomerOption | null> {
  const customer = await getPrisma().user.findFirst({
    where: { id, org_id: orgId, userType: "CUSTOMER" },
    select: { id: true, name: true },
  });
  return customer ?? null;
}

export async function searchCustomers(
  orgId: string,
  query: string,
  track?: TrackFilter
): Promise<CustomerOption[]> {
  return getPrisma().user.findMany({
    where: {
      org_id: orgId,
      userType: "CUSTOMER",
      name: { contains: query, mode: "insensitive" },
      // Vehicle list filter only: offer customers who own a vehicle in the
      // active tab. The Add Vehicle combobox passes no track.
      ...(track && {
        vehicles: { some: { org_id: orgId, deletedAt: null, ...buildTrackWhere(track) } },
      }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 20,
  });
}

function parseCustomerName(name: string): string {
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) {
    throw new ServiceError("VALIDATION", "Please fix the highlighted fields.", {
      name: parsed.error.issues[0]?.message ?? "Invalid name",
    });
  }
  return parsed.data;
}

/** Quick-create from the vehicle form's customer combobox (name only). Unlike
 * the lookups, customers may share a name, so this always creates. */
export async function createCustomer(actor: SessionUser, name: string): Promise<CustomerOption> {
  const trimmed = parseCustomerName(name);

  return getPrisma().$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        org_id: actor.orgId,
        userType: "CUSTOMER",
        name: trimmed,
        loginEnabled: false,
      },
      select: { id: true, name: true },
    });

    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "CREATE_CUSTOMER",
      entity: "User",
      entityId: created.id,
      after: { name: created.name },
    });

    return created;
  });
}

// ── Full Customers screen (CD-D2-15) ────────────────────────────────────────

export interface CustomerListItem {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  address: string | null;
  createdAt: Date;
  vehicleCount: number;
}

const CUSTOMER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  country: true,
  address: true,
  createdAt: true,
  _count: { select: { vehicles: true } },
} satisfies Prisma.UserSelect;

function toListItem(row: {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  address: string | null;
  createdAt: Date;
  _count: { vehicles: number };
}): CustomerListItem {
  const { _count, ...rest } = row;
  return { ...rest, vehicleCount: _count.vehicles };
}

/** What a role that may not see contact details gets: no email, phone or address (the keys are absent, not null). */
export type CustomerListItemWithoutContact = Omit<CustomerListItem, "email" | "phone" | "address">;

/**
 * The customer list. `contact: false` (a VIEWER) removes email, phone and address from every row AND stops the search from
 * matching them: otherwise a search for "@gmail.com" or "077" would reveal who has such an address or number.
 */
export async function listCustomers(orgId: string, query: string | undefined, contact: boolean): Promise<Array<CustomerListItem | CustomerListItemWithoutContact>> {
  const q = query?.trim();
  const customers = await getPrisma().user.findMany({
    where: {
      org_id: orgId,
      userType: "CUSTOMER",
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              ...(contact
                ? [
                    { email: { contains: q, mode: "insensitive" as const } },
                    { phone: { contains: q, mode: "insensitive" as const } },
                  ]
                : []),
            ],
          }
        : {}),
    },
    select: CUSTOMER_SELECT,
    orderBy: { name: "asc" },
  });
  return customers.map((row) => {
    const item = toListItem(row);
    if (contact) return item;
    const { email: _email, phone: _phone, address: _address, ...withoutContact } = item;
    return withoutContact;
  });
}

/** Fetches one customer row scoped to the org, or throws NOT_FOUND. */
async function getOwnedCustomer(orgId: string, customerId: string) {
  const existing = await getPrisma().user.findUnique({ where: { id: customerId } });
  if (!existing || existing.org_id !== orgId || existing.userType !== "CUSTOMER") {
    throw new ServiceError("NOT_FOUND", "Customer not found.");
  }
  return existing;
}

export async function createCustomerFull(
  actor: SessionUser,
  rawInput: unknown
): Promise<CustomerListItem> {
  const parsed = customerCreateSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ServiceError(
      "VALIDATION",
      "Please fix the highlighted fields.",
      flattenFieldErrors(parsed.error)
    );
  }
  const input = parsed.data;

  return getPrisma().$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        org_id: actor.orgId,
        userType: "CUSTOMER",
        name: input.name,
        email: input.email,
        phone: input.phone,
        country: input.country,
        address: input.address,
        loginEnabled: false,
      },
      select: CUSTOMER_SELECT,
    });

    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "CREATE_CUSTOMER",
      entity: "User",
      entityId: created.id,
      after: JSON.parse(JSON.stringify(created)),
    });

    return toListItem(created);
  });
}

export async function updateCustomer(
  actor: SessionUser,
  customerId: string,
  rawInput: unknown
): Promise<CustomerListItem> {
  const parsed = customerUpdateSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ServiceError(
      "VALIDATION",
      "Please fix the highlighted fields.",
      flattenFieldErrors(parsed.error)
    );
  }
  const input = parsed.data;
  const existing = await getOwnedCustomer(actor.orgId, customerId);

  return getPrisma().$transaction(async (tx) => {
    // The write carries org_id itself (not only getOwnedCustomer above): another org's id changes nothing.
    const written = await tx.user.updateMany({
      where: { id: customerId, org_id: actor.orgId, userType: "CUSTOMER" },
      data: {
        name: input.name,
        email: input.email,
        phone: input.phone,
        country: input.country,
        address: input.address,
      },
    });
    if (written.count !== 1) throw new ServiceError("NOT_FOUND", "Customer not found.");
    const updated = await tx.user.findFirst({ where: { id: customerId, org_id: actor.orgId, userType: "CUSTOMER" }, select: CUSTOMER_SELECT });
    if (!updated) throw new ServiceError("NOT_FOUND", "Customer not found.");

    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "UPDATE_CUSTOMER",
      entity: "User",
      entityId: updated.id,
      before: {
        name: existing.name,
        email: existing.email,
        phone: existing.phone,
        country: existing.country,
        address: existing.address,
      },
      after: JSON.parse(JSON.stringify(updated)),
    });

    return toListItem(updated);
  });
}

/** Rename only — unlike the lookup services, this never checks for a
 * duplicate name (customers can legitimately share a name, see above). */
export async function renameCustomer(
  actor: SessionUser,
  id: string,
  newName: string
): Promise<CustomerOption> {
  const trimmed = parseCustomerName(newName);
  const current = await getOwnedCustomer(actor.orgId, id);

  return getPrisma().$transaction(async (tx) => {
    const written = await tx.user.updateMany({ where: { id, org_id: actor.orgId, userType: "CUSTOMER" }, data: { name: trimmed } });
    if (written.count !== 1) throw new ServiceError("NOT_FOUND", "Customer not found.");
    const updated = await tx.user.findFirst({ where: { id, org_id: actor.orgId, userType: "CUSTOMER" }, select: { id: true, name: true } });
    if (!updated) throw new ServiceError("NOT_FOUND", "Customer not found.");

    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "RENAME_CUSTOMER",
      entity: "User",
      entityId: id,
      before: { name: current.name },
      after: { name: updated.name },
    });

    return updated;
  });
}
