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
