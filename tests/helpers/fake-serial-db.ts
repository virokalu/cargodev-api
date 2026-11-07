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
  /** Like the real column: null for a live vehicle, a date for a deleted one. */
  deletedAt: Date | null;
}

type CounterKey = { org_id_prefix: { org_id: string; prefix: Prefix } };
/** The only vehicle query the serial engine makes: by organisation and serial, active (deletedAt null), deleted (not null) or either. */
type VehicleWhere = { org_id: string; serial: string; deletedAt?: null | { not: null }; id?: { not: string } };

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
    async updateMany(args: {
      where: { org_id: string; prefix: Prefix; lastNumber: { lt: number } };
      data: { lastNumber: number };
    }) {
      const rows = counters.filter(
        (c) => c.org_id === args.where.org_id && c.prefix === args.where.prefix && c.lastNumber < args.where.lastNumber.lt
      );
      for (const row of rows) row.lastNumber = args.data.lastNumber;
      return { count: rows.length };
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
    async findFirst(args: { where: VehicleWhere; orderBy?: { deletedAt: "desc" }; select?: { id: true } }) {
      const w = args.where;
      const matches = vehicles.filter(
        (v) =>
          v.org_id === w.org_id &&
          v.serial === w.serial &&
          (w.deletedAt === undefined || (w.deletedAt === null ? v.deletedAt === null : v.deletedAt !== null)) &&
          (w.id === undefined || v.id !== w.id.not)
      );
      if (args.orderBy?.deletedAt === "desc") matches.sort((a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0));
      const row = matches[0];
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
    seedVehicle(org_id: string, id: string, serial: string, deletedAt: Date | null = null) {
      vehicles.push({ id, org_id, serial, deletedAt });
    },
    lastNumber(org_id: string, prefix: Prefix): number | undefined {
      return counters.find((c) => c.org_id === org_id && c.prefix === prefix)?.lastNumber;
    },
  };
}
