// Pure ETD-driven shipment status logic (Tech Doc §1) — no Prisma, no
// server-only imports, so both lib/services/vehicle.service.ts (the real
// source of truth on save) and components/vehicles/vehicle-form.tsx (a
// client component, for a live preview *before* saving) can import the
// exact same logic instead of two hand-kept-in-sync copies.

import type { ShipmentStatus, StorableShipmentStatus } from "./constants/shipment-status.js";

/** The row colour statuses that override shipment status to Cancelled (FC
 * only — see computeEffectiveShipmentStatus). Matched by name against the
 * existing seeded row colour statuses — there's no separate flag or DB
 * column for this, same as how "Transport Complete" is its own
 * special-cased name for the transportCellOnly behaviour. "Unit Canceled"
 * is the literal cancellation; "Resold in Auction" means the vehicle never
 * shipped to this customer either, so it reads the same way. */
// Exported (not just the predicate below) so the vehicle list's Prisma
// where-clause filter (vehicle.service.ts's CANCELLED_WHERE) can match the
// same names instead of hand-keeping its own "Unit Canceled" literal in
// sync with this one.
export const CANCEL_SHIPMENT_ROW_COLOUR_NAMES = ["Unit Canceled", "Resold in Auction"] as const;

export function isCancelShipmentRowColour(rowColourStatusName: string | null | undefined): boolean {
  if (!rowColourStatusName) return false;
  return (CANCEL_SHIPMENT_ROW_COLOUR_NAMES as readonly string[]).includes(rowColourStatusName);
}

export function todayAtMidnight(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

/** "Computed guard on read" (Tech Doc §1): the daily cron flips
 * BOOKING_RECEIVED -> SHIPPED once today is after the ETD date, but if the
 * cron hasn't run yet today the UI would show a stale status. This never
 * writes to the DB — it's purely what gets displayed until the cron (or an
 * edit that changes ETD) catches up for real.
 *
 * `cancelled` works the same way: true whenever the vehicle is FC and its
 * current row colour status is one of CANCEL_SHIPMENT_ROW_COLOUR_NAMES —
 * never stored, purely computed, and immediately reactive to changing the
 * row colour away from it (callers pass `false` for FL vehicles, since
 * shipment status isn't tracked for FL at all). */
export function computeEffectiveShipmentStatus(
  status: StorableShipmentStatus,
  etd: Date | null,
  cancelled: boolean
): ShipmentStatus {
  if (cancelled) return "CANCELLED";
  if (status !== "BOOKING_RECEIVED" || !etd) return status;
  return etd.getTime() < todayAtMidnight().getTime() ? "SHIPPED" : status;
}

/** What a fresh FC vehicle's status should actually be, from its ETD alone —
 * used to correct a legacy entry hand-picked as Pending despite an ETD also
 * being entered. That combination is self-contradictory (Pending means "no
 * ETD yet"), and unlike a wrong Booking Received, nothing fixes a wrong
 * Pending later: computeEffectiveShipmentStatus's read-time guard only ever
 * promotes Booking Received -> Shipped, never Pending -> anything, and
 * shipment status can't be edited by hand after creation except at legacy
 * entry. So this has to be corrected at creation time, not on read. */
export function deriveShipmentStatusFromEtd(etd: Date | null): StorableShipmentStatus {
  if (!etd) return "PENDING";
  return etd.getTime() < todayAtMidnight().getTime() ? "SHIPPED" : "BOOKING_RECEIVED";
}

/** ETD-driven status transition on edit (Tech Doc §1): adding an ETD to a
 * Pending FC vehicle moves it to Booking Received; clearing an ETD always
 * reverts to Pending, regardless of current status. Editing ETD to a
 * different (but still present) date doesn't itself transition anything —
 * computeEffectiveShipmentStatus handles the "already in the past" case on
 * top of whatever this returns. Mirrors vehicle.service.ts#updateVehicle's
 * transition exactly, so a live client-side preview and the actual save
 * can never disagree. */
export function computeShipmentStatusAfterEtdChange(
  currentStatus: StorableShipmentStatus,
  hadEtd: boolean,
  hasEtd: boolean
): StorableShipmentStatus {
  if (!hadEtd && hasEtd && currentStatus === "PENDING") return "BOOKING_RECEIVED";
  if (hadEtd && !hasEtd) return "PENDING";
  return currentStatus;
}
