// Activity log — append-only. Every mutation writes a row here (CLAUDE.md
// rule 7); record() is the one function allowed to insert into ActivityLog.
// Takes `tx` so callers can write the log entry in the same transaction as
// the mutation it's recording — a save that "succeeds" without a log entry
// (or vice versa) would defeat the point of an audit trail.
//
// listActivityLog is the read side — Administrator-only viewer screen
// (§6, CD-D3-23), and now also the /api/v1/activity-log mobile endpoint.

import type { Prisma } from "@prisma/client";
import { getPrisma } from "../lib/prisma.js";
import { redactStorageReferences } from "../lib/storage-redaction.js";

type TxClient = Prisma.TransactionClient;

export interface ActivityLogEntry {
  orgId: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export async function record(tx: TxClient, entry: ActivityLogEntry): Promise<void> {
  await tx.activityLog.create({
    data: {
      org_id: entry.orgId,
      actorId: entry.actorId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      ...(entry.before === undefined ? {} : { before: entry.before as Prisma.InputJsonValue }),
      ...(entry.after === undefined ? {} : { after: entry.after as Prisma.InputJsonValue }),
    },
  });
}

/** Several rows in one statement (the retention job writes a batch). Same rules as record(): the caller's transaction, one row per entry. */
export async function recordMany(tx: TxClient, entries: readonly ActivityLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await tx.activityLog.createMany({
    data: entries.map((entry) => ({
      org_id: entry.orgId,
      actorId: entry.actorId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      ...(entry.before === undefined ? {} : { before: entry.before as Prisma.InputJsonValue }),
      ...(entry.after === undefined ? {} : { after: entry.after as Prisma.InputJsonValue }),
    })),
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A DELIBERATE EXCEPTION to "the activity log is append-only" (docs/adr/adr-0010, docs/privacy-checklist.md).
//
// When a customer is anonymised (they deleted their account, or the retention job removed a never-verified sign-up), the personal values
// that staff edits of that customer left in the log (the old and new name, e-mail, phone, address, company name) are replaced by a
// placeholder, in the SAME transaction. ONLY those five fields, ONLY in the `before` and `after` of rows about that customer
// (entity "User" or "Customer", that entityId, that organisation). Every other row, field and customer is untouched, and one new
// summary row per customer records COUNTS only, so the audit trail still shows that a scrub happened and how much it changed.

export const PERSONAL_FIELDS = ["email", "phone", "name", "address", "companyName"] as const;
export const SCRUBBED_PLACEHOLDER = "[removed]";
/** The entities whose rows are about a customer by id: staff edits (`User`) and the customer's own actions (`Customer`). */
export const CUSTOMER_ENTITIES = ["User", "Customer"] as const;
const SCRUB_PAGE = 500;

/** Replaces the five personal fields wherever they appear in a JSON value. Pure. A field that is null or already the placeholder is left alone and not counted. */
export function scrubPersonalFields(value: unknown): { value: unknown; replaced: number } {
  if (Array.isArray(value)) {
    let replaced = 0;
    const out = value.map((item) => {
      const result = scrubPersonalFields(item);
      replaced += result.replaced;
      return result.value;
    });
    return { value: out, replaced };
  }
  if (value !== null && typeof value === "object") {
    let replaced = 0;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((PERSONAL_FIELDS as readonly string[]).includes(key) && item !== null && item !== undefined && item !== SCRUBBED_PLACEHOLDER) {
        out[key] = SCRUBBED_PLACEHOLDER;
        replaced += 1;
      } else {
        const result = scrubPersonalFields(item);
        out[key] = result.value;
        replaced += result.replaced;
      }
    }
    return { value: out, replaced };
  }
  return { value, replaced: 0 };
}

export interface ScrubCounts {
  rowsScrubbed: number;
  fieldsReplaced: number;
}

/**
 * Scrubs the log rows about each of the given customers and writes ONE summary row per customer with the counts (and nothing personal).
 * Runs in the caller's transaction, next to the anonymisation. `actorId` is who the summary row is attributed to (the customer for their
 * own deletion, the organisation's administrator for the retention job).
 */
export async function scrubCustomerActivity(
  tx: TxClient,
  params: { orgId: string; customerIds: readonly string[]; actorId: string }
): Promise<Map<string, ScrubCounts>> {
  const { orgId, customerIds, actorId } = params;
  const counts = new Map<string, ScrubCounts>(customerIds.map((id) => [id, { rowsScrubbed: 0, fieldsReplaced: 0 }]));
  if (customerIds.length === 0) return counts;

  for (let skip = 0; ; skip += SCRUB_PAGE) {
    const page = await tx.activityLog.findMany({
      where: { org_id: orgId, entityId: { in: [...customerIds] }, entity: { in: [...CUSTOMER_ENTITIES] } },
      select: { id: true, entityId: true, before: true, after: true },
      orderBy: { id: "asc" },
      take: SCRUB_PAGE,
      skip,
    });
    for (const row of page) {
      const before = scrubPersonalFields(row.before);
      const after = scrubPersonalFields(row.after);
      if (before.replaced + after.replaced === 0) continue;
      // The write names the organisation, the entity and the customer again: a row that is not about this customer cannot change.
      const written = await tx.activityLog.updateMany({
        where: { id: row.id, org_id: orgId, entityId: row.entityId, entity: { in: [...CUSTOMER_ENTITIES] } },
        data: {
          ...(before.replaced > 0 ? { before: before.value as Prisma.InputJsonValue } : {}),
          ...(after.replaced > 0 ? { after: after.value as Prisma.InputJsonValue } : {}),
        },
      });
      if (written.count === 1) {
        const c = counts.get(row.entityId)!;
        c.rowsScrubbed += 1;
        c.fieldsReplaced += before.replaced + after.replaced;
      }
    }
    if (page.length < SCRUB_PAGE) break;
  }

  await recordMany(
    tx,
    customerIds.map((customerId) => ({
      orgId,
      actorId,
      action: "CUSTOMER_ACTIVITY_SCRUBBED",
      entity: "Customer",
      entityId: customerId,
      after: counts.get(customerId)!, // counts only: { rowsScrubbed, fieldsReplaced }
    }))
  );
  return counts;
}

export interface ActivityLogListParams {
  page: number;
  pageSize: number;
  entity?: string | undefined;
  entityId?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
}

export interface ActivityLogListItem {
  id: string;
  actorId: string;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export interface ActivityLogListResult {
  rows: ActivityLogListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listActivityLog(
  orgId: string,
  params: ActivityLogListParams
): Promise<ActivityLogListResult> {
  const where: Prisma.ActivityLogWhereInput = {
    org_id: orgId,
    // entity is exact, case-insensitive — a client is expected to source the
    // value from listActivityLogFilterOptions below (the real distinct
    // strings in this org's log) and treat entities as fixed, mutually
    // exclusive categories (e.g. "Vehicle" vs "VehiclePhoto"). A substring
    // match would break that: "VehiclePhoto" and "VehicleDocument" both
    // contain "Vehicle", so filtering for just "Vehicle" would leak in
    // photo/document rows too. action stays a partial match — it's used
    // more like free-text search, and action names don't collide as
    // substrings of each other the way the entity names do.
    ...(params.entity ? { entity: { equals: params.entity, mode: "insensitive" } } : {}),
    ...(params.entityId ? { entityId: params.entityId } : {}),
    ...(params.actorId ? { actorId: params.actorId } : {}),
    ...(params.action ? { action: { contains: params.action, mode: "insensitive" } } : {}),
    ...(params.dateFrom || params.dateTo
      ? {
          createdAt: {
            ...(params.dateFrom ? { gte: params.dateFrom } : {}),
            ...(params.dateTo ? { lte: params.dateTo } : {}),
          },
        }
      : {}),
  };

  const skip = (params.page - 1) * params.pageSize;

  const [total, rows] = await Promise.all([
    getPrisma().activityLog.count({ where }),
    getPrisma().activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: params.pageSize,
      select: {
        id: true,
        actorId: true,
        action: true,
        entity: true,
        entityId: true,
        before: true,
        after: true,
        createdAt: true,
        actor: { select: { name: true } },
      },
    }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorName: row.actor.name,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      // Storage references are removed when the row is READ (rows written before the log stopped keeping file addresses too);
      // what is stored is not changed.
      before: redactStorageReferences(row.before),
      after: redactStorageReferences(row.after),
      createdAt: row.createdAt,
    })),
    total,
    page: params.page,
    pageSize: params.pageSize,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}

export interface ActivityLogFilterOptions {
  entities: string[];
  actions: string[];
}

/** Distinct entity/action values that actually appear in this org's log —
 * lets a client build a filter dropdown/chip list without hardcoding the
 * full set (which isn't a fixed enum) or guessing exact strings to pass to
 * listActivityLog's entity/action contains-filters above. Same reasoning
 * reports.service.ts uses for its own dropdown options: derived from real
 * data, not an assumed universe, so a filter never offers a value that
 * would return zero rows. */
export async function listActivityLogFilterOptions(orgId: string): Promise<ActivityLogFilterOptions> {
  const [entityRows, actionRows] = await Promise.all([
    getPrisma().activityLog.findMany({
      where: { org_id: orgId },
      select: { entity: true },
      distinct: ["entity"],
      orderBy: { entity: "asc" },
    }),
    getPrisma().activityLog.findMany({
      where: { org_id: orgId },
      select: { action: true },
      distinct: ["action"],
      orderBy: { action: "asc" },
    }),
  ]);

  return {
    entities: entityRows.map((row) => row.entity),
    actions: actionRows.map((row) => row.action),
  };
}
