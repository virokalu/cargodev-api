// Planning for the one-off milestone backfill (scripts/backfill-milestones.ts). Pure: no database, so it is tested
// with fake data and the script only has to read rows, call this, and (when told to) write the result.
//
// Only milestones whose date is genuinely known are planned: BOUGHT from the purchase date, BOOKING_RECEIVED and
// SHIPPED from the first time the vehicle entered that status in StatusHistory. Everything else (bill paid, export
// yard, certificate, B/L, arrived, delivered) has no recorded date, so staff record those; inventing a date would put
// a false fact in front of customers.

import type { MilestoneType } from "@prisma/client";

export interface BackfillVehicle {
  id: string;
  org_id: string;
  purchaseDate: Date | null;
}

export interface BackfillHistory {
  vehicleId: string;
  toStatus: "PENDING" | "BOOKING_RECEIVED" | "SHIPPED";
  createdAt: Date;
}

export interface PlannedMilestone {
  org_id: string;
  vehicleId: string;
  type: MilestoneType;
  occurredAt: Date;
}

export function planMilestoneBackfill(
  vehicles: readonly BackfillVehicle[],
  histories: readonly BackfillHistory[],
  existing: ReadonlySet<string> // "vehicleId:TYPE"
): PlannedMilestone[] {
  const firstEntry = new Map<string, Date>(); // "vehicleId:STATUS" -> earliest time
  for (const h of histories) {
    if (h.toStatus === "PENDING") continue;
    const key = `${h.vehicleId}:${h.toStatus}`;
    const known = firstEntry.get(key);
    if (!known || h.createdAt < known) firstEntry.set(key, h.createdAt);
  }

  const planned: PlannedMilestone[] = [];
  const add = (v: BackfillVehicle, type: MilestoneType, occurredAt: Date | null | undefined) => {
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) return;
    if (existing.has(`${v.id}:${type}`)) return;
    planned.push({ org_id: v.org_id, vehicleId: v.id, type, occurredAt });
  };

  for (const v of vehicles) {
    add(v, "BOUGHT", v.purchaseDate);
    add(v, "BOOKING_RECEIVED", firstEntry.get(`${v.id}:BOOKING_RECEIVED`));
    add(v, "SHIPPED", firstEntry.get(`${v.id}:SHIPPED`));
  }
  return planned;
}

/** Counts per type: all the backfill ever prints. */
export function countByType(planned: readonly PlannedMilestone[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of planned) counts[p.type] = (counts[p.type] ?? 0) + 1;
  return counts;
}
