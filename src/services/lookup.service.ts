// Lookup services — the ONLY code path allowed to create Brand, VehicleModelRef,
// Grade, AuctionHall, TransportCompany or VehicleLocation rows (CLAUDE.md
// architecture rule 8). The combobox-create component calls these through a
// Server Action; it never calls getPrisma().*.create itself.
//
// WHY case-insensitive matching: "Toyota", "TOYOTA" and "toyota " as free text
// would be three different rows that wreck every filter and dashboard
// grouping. Searching case-insensitively before creating means the same name
// typed in any case reuses the existing row.

import { getPrisma } from "../lib/prisma.js";
import { ServiceError } from "../lib/errors.js";
import { buildTrackWhere, type TrackFilter } from "../lib/vehicle-track.js";
import type { SessionUser } from "../lib/session-user.js";
import { nameSchema } from "../validation/shared.js";
import * as activityLog from "./activity-log.service.js";
import { Prisma } from "@prisma/client";

export interface LookupOption {
  id: string;
  name: string;
}

const SEARCH_LIMIT = 20;

/** Relation filter "at least one live vehicle in this track uses this row".
 * Used by the vehicle list's filter dropdowns so each tab only offers values
 * that exist in that tab's data — picking one can never land on an empty
 * table. Optional everywhere: the vehicle form's searches pass no track and
 * still see every lookup row. */
function usedByVehiclesIn(orgId: string, track: TrackFilter): Prisma.VehicleListRelationFilter {
  return { some: { org_id: orgId, deletedAt: null, ...buildTrackWhere(track) } };
}

/** Every rename below fetches the row first and checks this — `update({where:{id}})`
 * alone can't filter by org_id (id is already the unique key), so ownership
 * has to be verified explicitly instead of left to the query shape. */
function assertBelongsToOrg<T extends { org_id: string }>(
  orgId: string,
  row: T | null,
  notFoundMessage: string
): asserts row is T {
  if (!row || row.org_id !== orgId) {
    throw new ServiceError("NOT_FOUND", notFoundMessage);
  }
}

// ── Brand ──────────────────────────────────────────────────────────────────

export async function searchBrands(
  orgId: string,
  query: string,
  track?: TrackFilter
): Promise<LookupOption[]> {
  return getPrisma().brand.findMany({
    where: {
      org_id: orgId,
      name: { contains: query, mode: "insensitive" },
      // A brand has no direct vehicles relation — it's reached through its models.
      ...(track && { models: { some: { vehicles: usedByVehiclesIn(orgId, track) } } }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

/** Resolves a single brand's label for the vehicle filter panel — only called
 * when a Brand filter is actually active, never as part of listing brands. */
export async function getBrandById(orgId: string, id: string): Promise<LookupOption | null> {
  const brand = await getPrisma().brand.findFirst({ where: { id, org_id: orgId }, select: { id: true, name: true } });
  return brand ?? null;
}



// ── Model (scoped to a brand) ────────────────────────────────────────────────

export async function searchModels(
  orgId: string,
  brandId: string,
  query: string,
  track?: TrackFilter
): Promise<LookupOption[]> {
  return getPrisma().vehicleModelRef.findMany({
    where: {
      org_id: orgId,
      brand_id: brandId,
      name: { contains: query, mode: "insensitive" },
      ...(track && { vehicles: usedByVehiclesIn(orgId, track) }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

/** Resolves a single model's label for the vehicle filter panel. */
export async function getModelById(orgId: string, id: string): Promise<LookupOption | null> {
  const model = await getPrisma().vehicleModelRef.findFirst({
    where: { id, org_id: orgId },
    select: { id: true, name: true },
  });
  return model ?? null;
}



// ── Grade (scoped to a model, optional on the vehicle) ──────────────────────

export async function searchGrades(
  orgId: string,
  modelId: string,
  query: string,
  track?: TrackFilter
): Promise<LookupOption[]> {
  return getPrisma().grade.findMany({
    where: {
      org_id: orgId,
      model_id: modelId,
      name: { contains: query, mode: "insensitive" },
      ...(track && { vehicles: usedByVehiclesIn(orgId, track) }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

/** Resolves a single grade's label for the vehicle filter panel. */
export async function getGradeById(orgId: string, id: string): Promise<LookupOption | null> {
  const grade = await getPrisma().grade.findFirst({ where: { id, org_id: orgId }, select: { id: true, name: true } });
  return grade ?? null;
}



// ── Auction Hall ──────────────────────────────────────────────────────────

export async function searchAuctionHalls(
  orgId: string,
  query: string,
  track?: TrackFilter
): Promise<LookupOption[]> {
  return getPrisma().auctionHall.findMany({
    where: {
      org_id: orgId,
      name: { contains: query, mode: "insensitive" },
      ...(track && { vehicles: usedByVehiclesIn(orgId, track) }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

/** Resolves a single auction hall's label for the vehicle filter panel. */
export async function getAuctionHallById(orgId: string, id: string): Promise<LookupOption | null> {
  const hall = await getPrisma().auctionHall.findFirst({ where: { id, org_id: orgId }, select: { id: true, name: true } });
  return hall ?? null;
}



// ── Supplier (FL only — alternative to Auction Hall) ────────────────────

export async function searchSuppliers(
  orgId: string,
  query: string,
  track?: TrackFilter
): Promise<LookupOption[]> {
  return getPrisma().supplier.findMany({
    where: {
      org_id: orgId,
      name: { contains: query, mode: "insensitive" },
      ...(track && { vehicles: usedByVehiclesIn(orgId, track) }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

export async function getSupplierById(orgId: string, id: string): Promise<LookupOption | null> {
  const supplier = await getPrisma().supplier.findFirst({ where: { id, org_id: orgId }, select: { id: true, name: true } });
  return supplier ?? null;
}



// ── Transport Company ────────────────────────────────────────────────────

export async function searchTransportCompanies(
  orgId: string,
  query: string,
  track?: TrackFilter
): Promise<LookupOption[]> {
  return getPrisma().transportCompany.findMany({
    where: {
      org_id: orgId,
      name: { contains: query, mode: "insensitive" },
      ...(track && { vehicles: usedByVehiclesIn(orgId, track) }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

/** Resolves a single transport company's label for the vehicle filter panel. */
export async function getTransportCompanyById(orgId: string, id: string): Promise<LookupOption | null> {
  const company = await getPrisma().transportCompany.findFirst({
    where: { id, org_id: orgId },
    select: { id: true, name: true },
  });
  return company ?? null;
}



// ── Inspection Company (FC only) ────────────────────────────────────────

export async function searchInspectionCompanies(orgId: string, query: string): Promise<LookupOption[]> {
  return getPrisma().inspectionCompany.findMany({
    where: { org_id: orgId, name: { contains: query, mode: "insensitive" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

/** Resolves a single inspection company's label for the vehicle filter panel. */
export async function getInspectionCompanyById(orgId: string, id: string): Promise<LookupOption | null> {
  const company = await getPrisma().inspectionCompany.findFirst({
    where: { id, org_id: orgId },
    select: { id: true, name: true },
  });
  return company ?? null;
}



// ── Inspection By (FC only) ──────────────────────────────────────────────

export async function searchInspectionBy(orgId: string, query: string): Promise<LookupOption[]> {
  return getPrisma().inspectionBy.findMany({
    where: { org_id: orgId, name: { contains: query, mode: "insensitive" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

/** Resolves a single "inspection by" label for the vehicle filter panel. */
export async function getInspectionByById(orgId: string, id: string): Promise<LookupOption | null> {
  const inspectionBy = await getPrisma().inspectionBy.findFirst({
    where: { id, org_id: orgId },
    select: { id: true, name: true },
  });
  return inspectionBy ?? null;
}



// ── Packing Agent (only relevant when shippingMethod = CONTAINER) ─────────

export async function searchPackingAgents(
  orgId: string,
  query: string,
  track?: TrackFilter
): Promise<LookupOption[]> {
  return getPrisma().packingAgent.findMany({
    where: {
      org_id: orgId,
      name: { contains: query, mode: "insensitive" },
      ...(track && { vehicles: usedByVehiclesIn(orgId, track) }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

/** Resolves a single packing agent's label for the vehicle filter panel. */
export async function getPackingAgentById(orgId: string, id: string): Promise<LookupOption | null> {
  const agent = await getPrisma().packingAgent.findFirst({
    where: { id, org_id: orgId },
    select: { id: true, name: true },
  });
  return agent ?? null;
}



// ── Vehicle Location ──────────────────────────────────────────────────────

export async function searchVehicleLocations(
  orgId: string,
  query: string,
  track?: TrackFilter
): Promise<LookupOption[]> {
  return getPrisma().vehicleLocation.findMany({
    where: {
      org_id: orgId,
      name: { contains: query, mode: "insensitive" },
      ...(track && { vehicles: usedByVehiclesIn(orgId, track) }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

/** Resolves a single vehicle location's label for the vehicle filter panel. */
export async function getVehicleLocationById(orgId: string, id: string): Promise<LookupOption | null> {
  const location = await getPrisma().vehicleLocation.findFirst({
    where: { id, org_id: orgId },
    select: { id: true, name: true },
  });
  return location ?? null;
}



// ── Freight Agent (inline-create, but RORO/Container capability is set
// explicitly at creation time — never defaulted blind, since those flags
// gate which shipping method can later be picked for that agent) ──────────

export interface FreightAgentOption extends LookupOption {
  offersRoro: boolean;
  offersContainer: boolean;
}

const FREIGHT_AGENT_SELECT = { id: true, name: true, offersRoro: true, offersContainer: true } as const;

export async function listFreightAgents(orgId: string): Promise<FreightAgentOption[]> {
  return getPrisma().freightAgent.findMany({
    where: { org_id: orgId },
    select: FREIGHT_AGENT_SELECT,
    orderBy: { name: "asc" },
  });
}

/** Resolves a single freight agent's label for the vehicle filter panel. */
export async function getFreightAgentById(orgId: string, id: string): Promise<LookupOption | null> {
  const agent = await getPrisma().freightAgent.findFirst({
    where: { id, org_id: orgId },
    select: { id: true, name: true },
  });
  return agent ?? null;
}

export async function searchFreightAgents(
  orgId: string,
  query: string,
  method?: "RORO" | "CONTAINER",
  track?: TrackFilter
): Promise<FreightAgentOption[]> {
  return getPrisma().freightAgent.findMany({
    where: {
      org_id: orgId,
      name: { contains: query, mode: "insensitive" },
      ...(track && { vehicles: usedByVehiclesIn(orgId, track) }),
      ...(method === "RORO" && { offersRoro: true }),
      ...(method === "CONTAINER" && { offersContainer: true }),
    },
    select: FREIGHT_AGENT_SELECT,
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });
}

function assertHasCapability(offersRoro: boolean, offersContainer: boolean) {
  if (!offersRoro && !offersContainer) {
    throw new ServiceError("VALIDATION", "Select RORO, Container, or both for this agent.");
  }
}



// ── Read-only lists (Row Colour Status — plain select, admin-managed in
// Settings, not inline-create from the vehicle form) ───────────────────────

/** Row colour statuses at least one vehicle in the given track currently
 * has — for the vehicle list's Row Colour filter, so it doesn't offer
 * colours that would filter the tab down to nothing. */
export async function listRowColourStatusesInUse(
  orgId: string,
  track: TrackFilter
): Promise<(LookupOption & { colour: string; transportCellOnly: boolean })[]> {
  return getPrisma().rowColourStatus.findMany({
    where: { org_id: orgId, vehicles: usedByVehiclesIn(orgId, track) },
    select: { id: true, name: true, colour: true, transportCellOnly: true },
    orderBy: { name: "asc" },
  });
}

export async function listRowColourStatuses(orgId: string): Promise<
  (LookupOption & { colour: string; transportCellOnly: boolean })[]
> {
  return getPrisma().rowColourStatus.findMany({
    where: { org_id: orgId },
    select: { id: true, name: true, colour: true, transportCellOnly: true },
    orderBy: { name: "asc" },
  });
}

// ── Writes ─────────────────────────────────────────────────────────────────
// Every create/rename runs in one transaction with its ActivityLog row
// (CLAUDE.md rule 4), validates the name with zod (rule 3), and takes the org
// from the acting user. Lookup rows are only ever created here (rule 5).

type Db = Prisma.TransactionClient;

const LOOKUP_SELECT = { id: true, name: true } as const;

function parseLookupName(name: string): string {
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) {
    throw new ServiceError("VALIDATION", "Please fix the highlighted fields.", {
      name: parsed.error.issues[0]?.message ?? "Invalid name",
    });
  }
  return parsed.data;
}

function snapshot(row: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

interface FindOrCreateSpec<T extends { id: string }> {
  actor: SessionUser;
  entity: string;
  find: (db: Db) => Promise<T | null>;
  create: (db: Db) => Promise<T>;
}

/** Reuses an existing row (case-insensitive name match); otherwise creates one
 * and logs it. A concurrent create that loses the unique-constraint race
 * returns the winner's row instead of a 500. */
async function findOrCreateRow<T extends { id: string }>(spec: FindOrCreateSpec<T>): Promise<T> {
  const existing = await spec.find(getPrisma());
  if (existing) return existing;

  try {
    return await getPrisma().$transaction(async (tx) => {
      const created = await spec.create(tx);
      await activityLog.record(tx, {
        orgId: spec.actor.orgId,
        actorId: spec.actor.id,
        action: `CREATE_${snakeCase(spec.entity)}`,
        entity: spec.entity,
        entityId: created.id,
        after: snapshot(created),
      });
      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await spec.find(getPrisma());
      if (winner) return winner;
    }
    throw error;
  }
}

function snakeCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

interface RenameSpec<Row extends { org_id: string }, T extends { id: string }> {
  actor: SessionUser;
  entity: string;
  notFoundMessage: string;
  conflictMessage: string;
  load: (db: Db) => Promise<Row | null>;
  hasDuplicate: (db: Db, current: Row) => Promise<boolean>;
  update: (db: Db) => Promise<T>;
  before?: (current: Row) => unknown;
}

/** `update({ where: { id } })` alone cannot filter by org_id (id is already the
 * unique key), so ownership is verified explicitly before anything is written. */
async function renameRow<Row extends { org_id: string; name: string }, T extends { id: string }>(
  spec: RenameSpec<Row, T>
): Promise<T> {
  const current = await spec.load(getPrisma());
  assertBelongsToOrg(spec.actor.orgId, current, spec.notFoundMessage);
  if (await spec.hasDuplicate(getPrisma(), current)) {
    throw new ServiceError("CONFLICT", spec.conflictMessage);
  }

  return getPrisma().$transaction(async (tx) => {
    const updated = await spec.update(tx);
    await activityLog.record(tx, {
      orgId: spec.actor.orgId,
      actorId: spec.actor.id,
      action: `RENAME_${snakeCase(spec.entity)}`,
      entity: spec.entity,
      entityId: updated.id,
      before: spec.before ? spec.before(current) : { name: current.name },
      after: snapshot(updated),
    });
    return updated;
  });
}

// ── Brand ──

export async function findOrCreateBrand(actor: SessionUser, name: string): Promise<LookupOption> {
  const trimmed = parseLookupName(name);
  return findOrCreateRow({
    actor,
    entity: "Brand",
    find: (db) =>
      db.brand.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" } },
        select: LOOKUP_SELECT,
      }),
    create: (db) => db.brand.create({ data: { org_id: actor.orgId, name: trimmed }, select: LOOKUP_SELECT }),
  });
}

export async function renameBrand(actor: SessionUser, id: string, newName: string): Promise<LookupOption> {
  const trimmed = parseLookupName(newName);
  return renameRow({
    actor,
    entity: "Brand",
    notFoundMessage: "Brand not found.",
    conflictMessage: `A brand named "${trimmed}" already exists.`,
    load: (db) => db.brand.findUnique({ where: { id } }),
    hasDuplicate: async (db) =>
      (await db.brand.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" }, id: { not: id } },
        select: { id: true },
      })) !== null,
    update: (db) => db.brand.update({ where: { id }, data: { name: trimmed }, select: LOOKUP_SELECT }),
  });
}

// ── AuctionHall ──

export async function findOrCreateAuctionHall(actor: SessionUser, name: string): Promise<LookupOption> {
  const trimmed = parseLookupName(name);
  return findOrCreateRow({
    actor,
    entity: "AuctionHall",
    find: (db) =>
      db.auctionHall.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" } },
        select: LOOKUP_SELECT,
      }),
    create: (db) => db.auctionHall.create({ data: { org_id: actor.orgId, name: trimmed }, select: LOOKUP_SELECT }),
  });
}

export async function renameAuctionHall(actor: SessionUser, id: string, newName: string): Promise<LookupOption> {
  const trimmed = parseLookupName(newName);
  return renameRow({
    actor,
    entity: "AuctionHall",
    notFoundMessage: "Auction hall not found.",
    conflictMessage: `An auction hall named "${trimmed}" already exists.`,
    load: (db) => db.auctionHall.findUnique({ where: { id } }),
    hasDuplicate: async (db) =>
      (await db.auctionHall.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" }, id: { not: id } },
        select: { id: true },
      })) !== null,
    update: (db) => db.auctionHall.update({ where: { id }, data: { name: trimmed }, select: LOOKUP_SELECT }),
  });
}

// ── Supplier ──

export async function findOrCreateSupplier(actor: SessionUser, name: string): Promise<LookupOption> {
  const trimmed = parseLookupName(name);
  return findOrCreateRow({
    actor,
    entity: "Supplier",
    find: (db) =>
      db.supplier.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" } },
        select: LOOKUP_SELECT,
      }),
    create: (db) => db.supplier.create({ data: { org_id: actor.orgId, name: trimmed }, select: LOOKUP_SELECT }),
  });
}

export async function renameSupplier(actor: SessionUser, id: string, newName: string): Promise<LookupOption> {
  const trimmed = parseLookupName(newName);
  return renameRow({
    actor,
    entity: "Supplier",
    notFoundMessage: "Supplier not found.",
    conflictMessage: `A supplier named "${trimmed}" already exists.`,
    load: (db) => db.supplier.findUnique({ where: { id } }),
    hasDuplicate: async (db) =>
      (await db.supplier.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" }, id: { not: id } },
        select: { id: true },
      })) !== null,
    update: (db) => db.supplier.update({ where: { id }, data: { name: trimmed }, select: LOOKUP_SELECT }),
  });
}

// ── TransportCompany ──

export async function findOrCreateTransportCompany(actor: SessionUser, name: string): Promise<LookupOption> {
  const trimmed = parseLookupName(name);
  return findOrCreateRow({
    actor,
    entity: "TransportCompany",
    find: (db) =>
      db.transportCompany.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" } },
        select: LOOKUP_SELECT,
      }),
    create: (db) => db.transportCompany.create({ data: { org_id: actor.orgId, name: trimmed }, select: LOOKUP_SELECT }),
  });
}

export async function renameTransportCompany(actor: SessionUser, id: string, newName: string): Promise<LookupOption> {
  const trimmed = parseLookupName(newName);
  return renameRow({
    actor,
    entity: "TransportCompany",
    notFoundMessage: "Transport company not found.",
    conflictMessage: `A transport company named "${trimmed}" already exists.`,
    load: (db) => db.transportCompany.findUnique({ where: { id } }),
    hasDuplicate: async (db) =>
      (await db.transportCompany.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" }, id: { not: id } },
        select: { id: true },
      })) !== null,
    update: (db) => db.transportCompany.update({ where: { id }, data: { name: trimmed }, select: LOOKUP_SELECT }),
  });
}

// ── InspectionCompany ──

export async function findOrCreateInspectionCompany(actor: SessionUser, name: string): Promise<LookupOption> {
  const trimmed = parseLookupName(name);
  return findOrCreateRow({
    actor,
    entity: "InspectionCompany",
    find: (db) =>
      db.inspectionCompany.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" } },
        select: LOOKUP_SELECT,
      }),
    create: (db) => db.inspectionCompany.create({ data: { org_id: actor.orgId, name: trimmed }, select: LOOKUP_SELECT }),
  });
}

export async function renameInspectionCompany(actor: SessionUser, id: string, newName: string): Promise<LookupOption> {
  const trimmed = parseLookupName(newName);
  return renameRow({
    actor,
    entity: "InspectionCompany",
    notFoundMessage: "Inspection company not found.",
    conflictMessage: `An inspection company named "${trimmed}" already exists.`,
    load: (db) => db.inspectionCompany.findUnique({ where: { id } }),
    hasDuplicate: async (db) =>
      (await db.inspectionCompany.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" }, id: { not: id } },
        select: { id: true },
      })) !== null,
    update: (db) => db.inspectionCompany.update({ where: { id }, data: { name: trimmed }, select: LOOKUP_SELECT }),
  });
}

// ── InspectionBy ──

export async function findOrCreateInspectionBy(actor: SessionUser, name: string): Promise<LookupOption> {
  const trimmed = parseLookupName(name);
  return findOrCreateRow({
    actor,
    entity: "InspectionBy",
    find: (db) =>
      db.inspectionBy.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" } },
        select: LOOKUP_SELECT,
      }),
    create: (db) => db.inspectionBy.create({ data: { org_id: actor.orgId, name: trimmed }, select: LOOKUP_SELECT }),
  });
}

export async function renameInspectionBy(actor: SessionUser, id: string, newName: string): Promise<LookupOption> {
  const trimmed = parseLookupName(newName);
  return renameRow({
    actor,
    entity: "InspectionBy",
    notFoundMessage: "Inspection by not found.",
    conflictMessage: `An "inspection by" named "${trimmed}" already exists.`,
    load: (db) => db.inspectionBy.findUnique({ where: { id } }),
    hasDuplicate: async (db) =>
      (await db.inspectionBy.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" }, id: { not: id } },
        select: { id: true },
      })) !== null,
    update: (db) => db.inspectionBy.update({ where: { id }, data: { name: trimmed }, select: LOOKUP_SELECT }),
  });
}

// ── PackingAgent ──

export async function findOrCreatePackingAgent(actor: SessionUser, name: string): Promise<LookupOption> {
  const trimmed = parseLookupName(name);
  return findOrCreateRow({
    actor,
    entity: "PackingAgent",
    find: (db) =>
      db.packingAgent.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" } },
        select: LOOKUP_SELECT,
      }),
    create: (db) => db.packingAgent.create({ data: { org_id: actor.orgId, name: trimmed }, select: LOOKUP_SELECT }),
  });
}

export async function renamePackingAgent(actor: SessionUser, id: string, newName: string): Promise<LookupOption> {
  const trimmed = parseLookupName(newName);
  return renameRow({
    actor,
    entity: "PackingAgent",
    notFoundMessage: "Packing agent not found.",
    conflictMessage: `A packing agent named "${trimmed}" already exists.`,
    load: (db) => db.packingAgent.findUnique({ where: { id } }),
    hasDuplicate: async (db) =>
      (await db.packingAgent.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" }, id: { not: id } },
        select: { id: true },
      })) !== null,
    update: (db) => db.packingAgent.update({ where: { id }, data: { name: trimmed }, select: LOOKUP_SELECT }),
  });
}

// ── VehicleLocation ──

export async function findOrCreateVehicleLocation(actor: SessionUser, name: string): Promise<LookupOption> {
  const trimmed = parseLookupName(name);
  return findOrCreateRow({
    actor,
    entity: "VehicleLocation",
    find: (db) =>
      db.vehicleLocation.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" } },
        select: LOOKUP_SELECT,
      }),
    create: (db) => db.vehicleLocation.create({ data: { org_id: actor.orgId, name: trimmed }, select: LOOKUP_SELECT }),
  });
}

export async function renameVehicleLocation(actor: SessionUser, id: string, newName: string): Promise<LookupOption> {
  const trimmed = parseLookupName(newName);
  return renameRow({
    actor,
    entity: "VehicleLocation",
    notFoundMessage: "Vehicle location not found.",
    conflictMessage: `A vehicle location named "${trimmed}" already exists.`,
    load: (db) => db.vehicleLocation.findUnique({ where: { id } }),
    hasDuplicate: async (db) =>
      (await db.vehicleLocation.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" }, id: { not: id } },
        select: { id: true },
      })) !== null,
    update: (db) => db.vehicleLocation.update({ where: { id }, data: { name: trimmed }, select: LOOKUP_SELECT }),
  });
}

// ── Model (scoped to a brand) ──

export async function findOrCreateModel(actor: SessionUser, brandId: string, name: string): Promise<LookupOption> {
  const trimmed = parseLookupName(name);
  // The parent must belong to the caller's org; otherwise a row could be
  // attached to another tenant's brand.
  assertBelongsToOrg(actor.orgId, await getPrisma().brand.findUnique({ where: { id: brandId } }), "Brand not found.");

  return findOrCreateRow({
    actor,
    entity: "VehicleModelRef",
    find: (db) =>
      db.vehicleModelRef.findFirst({
        where: { org_id: actor.orgId, brand_id: brandId, name: { equals: trimmed, mode: "insensitive" } },
        select: LOOKUP_SELECT,
      }),
    create: (db) =>
      db.vehicleModelRef.create({ data: { org_id: actor.orgId, brand_id: brandId, name: trimmed }, select: LOOKUP_SELECT }),
  });
}

export async function renameModel(actor: SessionUser, id: string, newName: string): Promise<LookupOption> {
  const trimmed = parseLookupName(newName);
  return renameRow({
    actor,
    entity: "VehicleModelRef",
    notFoundMessage: "Model not found.",
    conflictMessage: `A model named "${trimmed}" already exists under this brand.`,
    load: (db) => db.vehicleModelRef.findUnique({ where: { id } }),
    hasDuplicate: async (db, current) =>
      (await db.vehicleModelRef.findFirst({
        where: {
          org_id: actor.orgId,
          brand_id: current.brand_id,
          name: { equals: trimmed, mode: "insensitive" },
          id: { not: id },
        },
        select: { id: true },
      })) !== null,
    update: (db) => db.vehicleModelRef.update({ where: { id }, data: { name: trimmed }, select: LOOKUP_SELECT }),
  });
}

// ── Grade (scoped to a model, optional on the vehicle) ──

export async function findOrCreateGrade(actor: SessionUser, modelId: string, name: string): Promise<LookupOption> {
  const trimmed = parseLookupName(name);
  assertBelongsToOrg(
    actor.orgId,
    await getPrisma().vehicleModelRef.findUnique({ where: { id: modelId } }),
    "Model not found."
  );

  return findOrCreateRow({
    actor,
    entity: "Grade",
    find: (db) =>
      db.grade.findFirst({
        where: { org_id: actor.orgId, model_id: modelId, name: { equals: trimmed, mode: "insensitive" } },
        select: LOOKUP_SELECT,
      }),
    create: (db) =>
      db.grade.create({ data: { org_id: actor.orgId, model_id: modelId, name: trimmed }, select: LOOKUP_SELECT }),
  });
}

export async function renameGrade(actor: SessionUser, id: string, newName: string): Promise<LookupOption> {
  const trimmed = parseLookupName(newName);
  return renameRow({
    actor,
    entity: "Grade",
    notFoundMessage: "Grade not found.",
    conflictMessage: `A grade named "${trimmed}" already exists under this model.`,
    load: (db) => db.grade.findUnique({ where: { id } }),
    hasDuplicate: async (db, current) =>
      (await db.grade.findFirst({
        where: {
          org_id: actor.orgId,
          model_id: current.model_id,
          name: { equals: trimmed, mode: "insensitive" },
          id: { not: id },
        },
        select: { id: true },
      })) !== null,
    update: (db) => db.grade.update({ where: { id }, data: { name: trimmed }, select: LOOKUP_SELECT }),
  });
}

// ── Freight Agent (RORO/Container capability is set explicitly, never defaulted) ──

export async function createFreightAgent(
  actor: SessionUser,
  name: string,
  offersRoro: boolean,
  offersContainer: boolean
): Promise<FreightAgentOption> {
  const trimmed = parseLookupName(name);
  assertHasCapability(offersRoro, offersContainer);

  // Same case-insensitive dedupe as the other lookups: an existing name is
  // reused, and the capability flags only apply to a genuinely new agent.
  return findOrCreateRow({
    actor,
    entity: "FreightAgent",
    find: (db) =>
      db.freightAgent.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" } },
        select: FREIGHT_AGENT_SELECT,
      }),
    create: (db) =>
      db.freightAgent.create({
        data: { org_id: actor.orgId, name: trimmed, offersRoro, offersContainer },
        select: FREIGHT_AGENT_SELECT,
      }),
  });
}

export async function updateFreightAgent(
  actor: SessionUser,
  id: string,
  name: string,
  offersRoro: boolean,
  offersContainer: boolean
): Promise<FreightAgentOption> {
  const trimmed = parseLookupName(name);
  assertHasCapability(offersRoro, offersContainer);

  return renameRow({
    actor,
    entity: "FreightAgent",
    notFoundMessage: "Freight agent not found.",
    conflictMessage: `A freight agent named "${trimmed}" already exists.`,
    load: (db) => db.freightAgent.findUnique({ where: { id } }),
    hasDuplicate: async (db) =>
      (await db.freightAgent.findFirst({
        where: { org_id: actor.orgId, name: { equals: trimmed, mode: "insensitive" }, id: { not: id } },
        select: { id: true },
      })) !== null,
    update: (db) =>
      db.freightAgent.update({
        where: { id },
        data: { name: trimmed, offersRoro, offersContainer },
        select: FREIGHT_AGENT_SELECT,
      }),
    before: (current) => ({
      name: current.name,
      offersRoro: current.offersRoro,
      offersContainer: current.offersContainer,
    }),
  });
}
