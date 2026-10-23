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

  return { serialNumber: counter.lastNumber, serial: `${prefix}${counter.lastNumber}` };
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

  const existing = await tx.vehicle.findUnique({
    where: { org_id_serial: { org_id: orgId, serial } },
    select: { id: true },
  });
  if (existing) {
    throw new ServiceError(
      "CONFLICT",
      `Serial ${serial} already exists.`,
      { legacySerialNumber: `Serial ${serial} already exists.` }
    );
  }

  const counter = await tx.serialCounter.findUniqueOrThrow({
    where: { org_id_prefix: { org_id: orgId, prefix } },
  });

  if (manualNumber > counter.lastNumber) {
    await tx.serialCounter.update({
      where: { org_id_prefix: { org_id: orgId, prefix } },
      data: { lastNumber: manualNumber },
    });
  }

  return { serialNumber: manualNumber, serial };
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

  const existing = await tx.vehicle.findUnique({
    where: { org_id_serial: { org_id: orgId, serial } },
    select: { id: true },
  });
  if (existing && existing.id !== excludeVehicleId) {
    throw new ServiceError(
      "CONFLICT",
      `Serial ${serial} already exists.`,
      { serialNumber: `Serial ${serial} already exists.` }
    );
  }

  const counter = await tx.serialCounter.findUniqueOrThrow({
    where: { org_id_prefix: { org_id: orgId, prefix } },
  });

  if (newNumber > counter.lastNumber) {
    await tx.serialCounter.update({
      where: { org_id_prefix: { org_id: orgId, prefix } },
      data: { lastNumber: newNumber },
    });
  }

  return { serialNumber: newNumber, serial };
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
