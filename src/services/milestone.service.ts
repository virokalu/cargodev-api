// Vehicle milestones: the customer-facing timeline (bought, bill paid, at export yard, ..., delivered).
//
// One row per vehicle and type (unique key), recorded exactly once however many requests race. Automation records
// BOOKING_RECEIVED and SHIPPED inside the SAME transaction as the status change, so a rolled-back change leaves no
// milestone. Automation only ever ADDS: nothing here deletes a milestone except a staff member's explicit undo.

import type { MilestoneType, Prisma } from "@prisma/client";
import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import type { SessionUser } from "../lib/session-user.js";
import { milestoneBodySchema, milestoneTypeSchema } from "../validation/milestone.schema.js";
import * as activityLog from "./activity-log.service.js";
import { getOwnedVehicle } from "./file.service.js";

type TxClient = Prisma.TransactionClient;

export interface MilestoneDto {
  type: MilestoneType;
  occurredAt: string;
  recordedBy: { id: string; name: string } | null;
}

/**
 * Inserts the milestone if it does not exist yet (INSERT ... ON CONFLICT DO NOTHING). Returns true if THIS call
 * created it. Safe to call from any number of concurrent transactions.
 */
export async function recordMilestoneOnce(
  tx: TxClient,
  args: { orgId: string; vehicleId: string; type: MilestoneType; occurredAt: Date; recordedById?: string | null }
): Promise<boolean> {
  const result = await tx.vehicleMilestone.createMany({
    data: [{ org_id: args.orgId, vehicleId: args.vehicleId, type: args.type, occurredAt: args.occurredAt, recordedById: args.recordedById ?? null }],
    skipDuplicates: true,
  });
  return result.count === 1;
}

/** What the status automation records when a vehicle enters `status`. PENDING records nothing and removes nothing. */
export async function recordStatusMilestone(
  tx: TxClient,
  args: { orgId: string; vehicleId: string; status: "PENDING" | "BOOKING_RECEIVED" | "SHIPPED"; occurredAt: Date; recordedById?: string | null }
): Promise<void> {
  if (args.status === "PENDING") return;
  await recordMilestoneOnce(tx, { orgId: args.orgId, vehicleId: args.vehicleId, type: args.status, occurredAt: args.occurredAt, recordedById: args.recordedById ?? null });
}

const RANK = { PENDING: 0, BOOKING_RECEIVED: 1, SHIPPED: 2 } as const;
type StorableStatus = keyof typeof RANK;

/**
 * Keeps the automatic milestones in step with a status change, inside the SAME transaction as the change:
 *  - going UP (to BOOKING_RECEIVED or SHIPPED): records that milestone once;
 *  - going DOWN (the ETD was cleared, or shipped was reverted): removes the automatic milestones for the statuses left,
 *    but ONLY those the system recorded and no person touched (recordedById is empty). A milestone a staff member
 *    recorded, or whose date a staff member moved, is never removed, and later milestones (B/L, arrived, delivered) are
 *    never touched. Every removal writes an ActivityLog row.
 */
export async function syncMilestonesForStatusChange(
  tx: TxClient,
  args: { orgId: string; vehicleId: string; from: StorableStatus; to: StorableStatus; occurredAt: Date; actorId: string }
): Promise<void> {
  if (RANK[args.to] > RANK[args.from]) {
    await recordStatusMilestone(tx, { orgId: args.orgId, vehicleId: args.vehicleId, status: args.to, occurredAt: args.occurredAt, recordedById: null });
    return;
  }
  if (RANK[args.to] === RANK[args.from]) return;

  for (const type of ["BOOKING_RECEIVED", "SHIPPED"] as const) {
    if (RANK[type] <= RANK[args.to] || RANK[type] > RANK[args.from]) continue;
    const removed = await tx.vehicleMilestone.deleteMany({
      where: { org_id: args.orgId, vehicleId: args.vehicleId, type, recordedById: null },
    });
    if (removed.count > 0) {
      await activityLog.record(tx, {
        orgId: args.orgId,
        actorId: args.actorId,
        action: "AUTO_REMOVE_MILESTONE",
        entity: "Vehicle",
        entityId: args.vehicleId,
        before: { type },
        after: { removed: true, because: `status went from ${args.from} to ${args.to}` },
      });
    }
  }
}

const select = { type: true, occurredAt: true, recordedBy: { select: { id: true, name: true } } } as const;

function toDto(row: { type: MilestoneType; occurredAt: Date; recordedBy: { id: string; name: string } | null }): MilestoneDto {
  return { type: row.type, occurredAt: row.occurredAt.toISOString(), recordedBy: row.recordedBy ? { id: row.recordedBy.id, name: row.recordedBy.name } : null };
}

export async function listMilestones(orgId: string, vehicleId: string): Promise<MilestoneDto[]> {
  await getOwnedVehicle(orgId, vehicleId);
  const rows = await getPrisma().vehicleMilestone.findMany({ where: { org_id: orgId, vehicleId }, select, orderBy: { occurredAt: "asc" } });
  return rows.map(toDto);
}

/** Records the milestone, or moves its date if it already exists. */
export async function setMilestone(actor: SessionUser, vehicleId: string, rawType: unknown, rawBody: unknown): Promise<MilestoneDto> {
  const type = parseInput(milestoneTypeSchema, rawType, "Unknown milestone.");
  const { occurredAt = new Date() } = parseInput(milestoneBodySchema, rawBody ?? {}, "Please fix the highlighted fields.");
  await getOwnedVehicle(actor.orgId, vehicleId);

  return getPrisma().$transaction(async (tx) => {
    const before = await tx.vehicleMilestone.findFirst({ where: { org_id: actor.orgId, vehicleId, type }, select: { occurredAt: true } });
    if (before) {
      await tx.vehicleMilestone.updateMany({ where: { org_id: actor.orgId, vehicleId, type }, data: { occurredAt, recordedById: actor.id } });
    } else {
      // If another request created it a moment ago, this does nothing and the update below sets our date.
      await recordMilestoneOnce(tx, { orgId: actor.orgId, vehicleId, type, occurredAt, recordedById: actor.id });
      await tx.vehicleMilestone.updateMany({ where: { org_id: actor.orgId, vehicleId, type }, data: { occurredAt, recordedById: actor.id } });
    }
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "SET_MILESTONE",
      entity: "Vehicle",
      entityId: vehicleId,
      before: before ? { type, occurredAt: before.occurredAt.toISOString() } : { type, occurredAt: null },
      after: { type, occurredAt: occurredAt.toISOString() },
    });
    const row = await tx.vehicleMilestone.findFirstOrThrow({ where: { org_id: actor.orgId, vehicleId, type }, select });
    return toDto(row);
  });
}

/** Staff undo. The only way a milestone is ever removed. */
export async function undoMilestone(actor: SessionUser, vehicleId: string, rawType: unknown): Promise<void> {
  const type = parseInput(milestoneTypeSchema, rawType, "Unknown milestone.");
  await getOwnedVehicle(actor.orgId, vehicleId);

  await getPrisma().$transaction(async (tx) => {
    const existing = await tx.vehicleMilestone.findFirst({ where: { org_id: actor.orgId, vehicleId, type }, select: { occurredAt: true } });
    if (!existing) throw new ServiceError("NOT_FOUND", "Milestone not found.");
    await tx.vehicleMilestone.deleteMany({ where: { org_id: actor.orgId, vehicleId, type } });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "UNDO_MILESTONE",
      entity: "Vehicle",
      entityId: vehicleId,
      before: { type, occurredAt: existing.occurredAt.toISOString() },
    });
  });
}
