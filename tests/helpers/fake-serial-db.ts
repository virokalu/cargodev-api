// In-memory stand-in for the few Prisma calls serial.service makes. Only for
// unit tests: it proves service logic, not SQL or row-lock behaviour. Fake data
// only. Throws like Prisma does when a required row is missing.

import type { Prisma } from "@prisma/client";

export type Prefix = "FC" | "FL";

interface CounterRow {
  org_id: string;
  prefix: Prefix;
  lastNumber: number;
}
interface VehicleRow {
  id: string;
  org_id: string;
  serial: string;
}

type CounterKey = { org_id_prefix: { org_id: string; prefix: Prefix } };
type VehicleKey = { org_id_serial: { org_id: string; serial: string } };

export function createFakeSerialDb() {
  const counters: CounterRow[] = [];
  const vehicles: VehicleRow[] = [];

  const findCounter = ({ org_id_prefix: k }: CounterKey) =>
    counters.find((c) => c.org_id === k.org_id && c.prefix === k.prefix);

  const serialCounter = {
    async update(args: {
      where: CounterKey;
      data: { lastNumber: number | { increment: number } };
    }) {
      const row = findCounter(args.where);
      if (!row) throw new Error("Record to update not found.");
      const next = args.data.lastNumber;
      row.lastNumber = typeof next === "number" ? next : row.lastNumber + next.increment;
      return { ...row };
    },
    async findUniqueOrThrow(args: { where: CounterKey }) {
      const row = findCounter(args.where);
      if (!row) throw new Error("No SerialCounter found");
      return { ...row };
    },
    async findUnique(args: { where: CounterKey }) {
      const row = findCounter(args.where);
      return row ? { ...row } : null;
    },
  };

  const vehicle = {
    async findUnique(args: { where: VehicleKey; select?: { id: true } }) {
      const k = args.where.org_id_serial;
      const row = vehicles.find((v) => v.org_id === k.org_id && v.serial === k.serial);
      return row ? { id: row.id } : null;
    },
  };

  return {
    tx: { serialCounter, vehicle } as unknown as Prisma.TransactionClient,
    /** What getPrisma() returns in tests: same counter table, outside a transaction. */
    client: { serialCounter },
    seedCounter(org_id: string, prefix: Prefix, lastNumber: number) {
      counters.push({ org_id, prefix, lastNumber });
    },
    seedVehicle(org_id: string, id: string, serial: string) {
      vehicles.push({ id, org_id, serial });
    },
    lastNumber(org_id: string, prefix: Prefix): number | undefined {
      return counters.find((c) => c.org_id === org_id && c.prefix === prefix)?.lastNumber;
    },
  };
}
