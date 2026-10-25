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
