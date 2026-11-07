// Serial number engine (Tech Doc §3).
//
// Two ways a vehicle gets a serial:
//   1. Normal entry: transactionally increment the org+prefix counter and
//      assign the next number. Two staff saving at the same instant can never
//      get the same serial because the increment happens inside the same
//      Prisma transaction as the vehicle insert (see vehicle.service.ts) —
//      the row lock on SerialCounter serializes concurrent saves.
//   2. Legacy entry: staff types the original serial from the old sheets.
//      If it's higher than the counter, the counter bumps up to match so the
//      next *new* serial continues correctly; if lower, it just back-fills
//      without touching the counter.
//
// A serial is unique among vehicles that are NOT soft-deleted (docs/adr/adr-0009-serial-uniqueness-among-active-vehicles.md): the
// serial of a deleted vehicle is free again. Every check below therefore looks at ACTIVE vehicles only (deletedAt null), and when a
// serial is taken that a deleted vehicle used to hold, the id of the most recent such vehicle is returned (reusedFromVehicleId) so
// the activity log can say which vehicle it came from. The database enforces the same rule with two partial unique indexes
// (migration 20261105120000), so two requests passing these checks together still end with exactly one winner. Auto-generated
// serials never reuse a number: the counter only goes up.
//
// All functions take `tx` (a Prisma transaction client) — callers are
// responsible for wrapping the counter update and the vehicle insert in the
// same $transaction so the two never disagree.

import type { Prisma, SerialPrefix } from "@prisma/client";
import { getPrisma } from "../lib/prisma.js";
import { ServiceError } from "../lib/errors.js";

type TxClient = Prisma.TransactionClient;

export interface AssignedSerial {
  serialNumber: number;
  serial: string;
  /** The id of the most recent DELETED vehicle that held this serial, or null (always null for an auto-generated serial). */
  reusedFromVehicleId: string | null;
}

const SERIAL_IN_USE = "already in use";

/**
 * The 409 for a serial that an ACTIVE vehicle holds. `inputField` is the body field the client sent (legacySerialNumber on create,
 * serialNumber on correction, kept so existing clients keep working); `serial` is the field error named by the contract.
 */
export function serialInUse(serial: string, inputField: string): ServiceError {
  const message = `Serial ${serial} already exists.`;
  return new ServiceError("CONFLICT", message, { [inputField]: message, serial: SERIAL_IN_USE });
}

/** The most recent DELETED vehicle of this org that held the serial (traceability only; it never blocks anything). */
async function findDeletedHolder(tx: TxClient, orgId: string, serial: string): Promise<string | null> {
  const row = await tx.vehicle.findFirst({
    where: { org_id: orgId, serial, deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * lastNumber = max(lastNumber, n), as ONE atomic statement. The conditional WHERE is
 * re-checked by Postgres after it takes the row lock, so a concurrent create or another
 * bump can never be overwritten with a lower value. (Reading the counter and then writing
 * an absolute value lets two concurrent calls move the counter backwards, after which the
 * next normal create would be handed a serial that already exists.)
 */
async function bumpCounterTo(tx: TxClient, orgId: string, prefix: SerialPrefix, n: number): Promise<void> {
  await tx.serialCounter.updateMany({
    where: { org_id: orgId, prefix, lastNumber: { lt: n } },
    data: { lastNumber: n },
  });
}

/** Normal entry: atomically increment the counter and assign the next number. */
export async function assignNextSerial(
  tx: TxClient,
  orgId: string,
  prefix: SerialPrefix
): Promise<AssignedSerial> {
  const counter = await tx.serialCounter.update({
    where: { org_id_prefix: { org_id: orgId, prefix } },
    data: { lastNumber: { increment: 1 } },
  });

  return { serialNumber: counter.lastNumber, serial: `${prefix}${counter.lastNumber}`, reusedFromVehicleId: null };
}

/**
 * Legacy entry: validate the manually typed number is unique, then bump the
 * counter up if needed (never down — a lower legacy number just back-fills a
 * gap without affecting what the next auto-assigned serial will be).
 */
export async function assignLegacySerial(
  tx: TxClient,
  orgId: string,
  prefix: SerialPrefix,
  manualNumber: number
): Promise<AssignedSerial> {
  const serial = `${prefix}${manualNumber}`;

  // Only an ACTIVE vehicle blocks the number; a deleted one has given it up.
  const holder = await tx.vehicle.findFirst({
    where: { org_id: orgId, serial, deletedAt: null },
    select: { id: true },
  });
  if (holder) throw serialInUse(serial, "legacySerialNumber");
  const reusedFromVehicleId = await findDeletedHolder(tx, orgId, serial);

  const counter = await tx.serialCounter.findUniqueOrThrow({
    where: { org_id_prefix: { org_id: orgId, prefix } },
  });

  // lastNumber = max(lastNumber, entered): a reused LOWER number leaves the counter where it is.
  await bumpCounterTo(tx, orgId, prefix, manualNumber);

  return { serialNumber: manualNumber, serial, reusedFromVehicleId };
}

/**
 * Corrects a typo in a vehicle's already-assigned number — the one
 * documented exception to "serial is read-only after creation" (see
 * vehicle.service.ts's correctVehicleSerialNumber, which calls this from
 * inside its own $transaction so the uniqueness check and counter bump
 * never race another save). The prefix/track never changes, only the
 * number. Same "bump the counter up, never down" rule as legacy entry:
 * correcting to a lower number just back-fills without affecting the next
 * auto-assigned serial. `excludeVehicleId` keeps this vehicle's own
 * current row from tripping the uniqueness check against itself.
 */
export async function correctSerialNumber(
  tx: TxClient,
  orgId: string,
  prefix: SerialPrefix,
  newNumber: number,
  excludeVehicleId: string
): Promise<AssignedSerial> {
  const serial = `${prefix}${newNumber}`;

  // Only ANOTHER ACTIVE vehicle blocks the number.
  const holder = await tx.vehicle.findFirst({
    where: { org_id: orgId, serial, deletedAt: null, id: { not: excludeVehicleId } },
    select: { id: true },
  });
  if (holder) throw serialInUse(serial, "serialNumber");
  const reusedFromVehicleId = await findDeletedHolder(tx, orgId, serial);

  const counter = await tx.serialCounter.findUniqueOrThrow({
    where: { org_id_prefix: { org_id: orgId, prefix } },
  });

  await bumpCounterTo(tx, orgId, prefix, newNumber);

  return { serialNumber: newNumber, serial, reusedFromVehicleId };
}

/** Read-only preview of the next auto-assigned serial — no increment. Used by
 * the Add Vehicle form to show "Next serial: FC1024" as staff pick a track.
 * Staleness is acceptable: the real assignment at save time is still
 * transactional and can never collide, this is just a hint. */
export async function previewNextSerial(
  orgId: string,
  prefix: SerialPrefix
): Promise<string> {
  const counter = await getPrisma().serialCounter.findUnique({
    where: { org_id_prefix: { org_id: orgId, prefix } },
  });
  const nextNumber = (counter?.lastNumber ?? 0) + 1;
  return `${prefix}${nextNumber}`;
}
