// Parallel serial assignment. This is the guarantee the unit tests could only mark as a todo:
// two staff saving at the same instant must never get the same serial.
//
// These need REAL concurrent connections (a Postgres container locally, a service container in
// CI). An in-process or single-session engine serializes everything and would pass trivially,
// proving nothing, so do not run them against one. Pool size must be at least 2 (default 10).

import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { ORG_A, ORG_B, minimalVehicle, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { assignLegacySerial, assignNextSerial, correctSerialNumber } from "../../src/services/serial.service.js";

const prisma = getTestPrisma();
const N = 25;
const numeric = (serial: string) => Number(serial.replace(/\D/g, ""));
const counter = async (org: string, prefix: "FC" | "FL") =>
  (await prisma.serialCounter.findUniqueOrThrow({ where: { org_id_prefix: { org_id: org, prefix } } })).lastNumber;

/** What createVehicle does in one transaction. */
const createNext = (org: string, prefix: "FC" | "FL" = "FC") =>
  prisma.$transaction(async (tx) => {
    const { serialNumber, serial } = await assignNextSerial(tx, org, prefix);
    await tx.vehicle.create({ data: minimalVehicle(org, serialNumber, { serialPrefix: prefix }) });
    return serial;
  });

beforeEach(async () => {
  expect(Number(process.env["TEST_DATABASE_POOL_MAX"] ?? 10)).toBeGreaterThanOrEqual(2);
  await resetDb(prisma);
  await seedTwoOrgs(prisma);
});
afterAll(closeTestPrisma);

describe("parallel creates", () => {
  it(`${N} simultaneous creates in separate transactions get ${N} distinct, gap-free serials`, async () => {
    const serials = await Promise.all(Array.from({ length: N }, () => createNext(ORG_A)));

    expect(new Set(serials).size).toBe(N);
    expect(serials.map(numeric).sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(await counter(ORG_A, "FC")).toBe(N);
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A } })).toBe(N);
  });

  it("orgs and prefixes do not interfere under load", async () => {
    const jobs = [
      ...Array.from({ length: 10 }, () => createNext(ORG_A, "FC")),
      ...Array.from({ length: 10 }, () => createNext(ORG_A, "FL")),
      ...Array.from({ length: 10 }, () => createNext(ORG_B, "FC")),
    ];
    await Promise.all(jobs);
    expect([await counter(ORG_A, "FC"), await counter(ORG_A, "FL"), await counter(ORG_B, "FC"), await counter(ORG_B, "FL")]).toEqual([10, 10, 10, 0]);
    expect(await prisma.vehicle.count()).toBe(30);
  });

  it("a failing create among parallel ones leaves no gap and does not disturb the others", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        prisma.$transaction(async (tx) => {
          const { serialNumber, serial } = await assignNextSerial(tx, ORG_A, "FC");
          await tx.vehicle.create({ data: minimalVehicle(ORG_A, serialNumber) });
          if (i % 4 === 0) throw new Error("later step failed"); // rolls back its serial
          return serial;
        })
      )
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value);
    expect(ok).toHaveLength(9);
    expect(new Set(ok).size).toBe(9);
    // A rolled-back create gives its number back (the row lock is held until commit or rollback),
    // so the committed serials are exactly 1..9 with no gap, and the counter agrees.
    const stored = await prisma.vehicle.findMany({ where: { org_id: ORG_A }, select: { serialNumber: true } });
    expect(stored.map((v) => v.serialNumber).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await counter(ORG_A, "FC")).toBe(9);
  });
});

describe("parallel legacy entry and corrections", () => {
  it("the counter ends at the highest entered number, whatever order the writes land in (max, never overwritten)", async () => {
    const numbers = [10, 500, 30, 7, 250, 499, 3, 120, 480, 60];
    await Promise.all(
      numbers.map((n) =>
        prisma.$transaction(async (tx) => {
          await assignLegacySerial(tx, ORG_A, "FC", n);
          await tx.vehicle.create({ data: minimalVehicle(ORG_A, n) });
        })
      )
    );
    expect(await counter(ORG_A, "FC")).toBe(500);
  });

  it("a legacy entry racing normal creates can never leave the counter below a serial that exists", async () => {
    // Normal creates push the counter up while legacy entries bump it to numbers in the middle
    // of that range. Writing an absolute value after reading the counter would let a legacy
    // entry overwrite a higher counter with a lower one; the next create would then be handed
    // a serial that already exists. A legacy number equal to one just auto-assigned is a real,
    // expected collision (the unique constraint rejects it), so rejections are tolerated; the
    // invariant is what matters.
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 30 }, () => createNext(ORG_A)),
      ...[20, 25, 30, 35].map((n) =>
        prisma.$transaction(async (tx) => {
          await assignLegacySerial(tx, ORG_A, "FC", n);
          await tx.vehicle.create({ data: minimalVehicle(ORG_A, n) });
        })
      ),
    ]);
    for (const o of outcomes.filter((x): x is PromiseRejectedResult => x.status === "rejected")) {
      const isConstraint = o.reason instanceof Prisma.PrismaClientKnownRequestError && o.reason.code === "P2002";
      expect(isConstraint || (o.reason as { code?: string }).code === "CONFLICT").toBe(true);
    }

    const stored = await prisma.vehicle.findMany({ where: { org_id: ORG_A }, select: { serialNumber: true } });
    const highest = Math.max(...stored.map((v) => v.serialNumber));
    expect(new Set(stored.map((v) => v.serialNumber)).size).toBe(stored.length);
    expect(await counter(ORG_A, "FC")).toBeGreaterThanOrEqual(highest);
    // And the very next normal create is safe.
    expect(await createNext(ORG_A)).toBe(`FC${(await counter(ORG_A, "FC"))}`);
  });

  it("parallel corrections also only ever raise the counter", async () => {
    const vehicles = await Promise.all([200, 5, 90, 400, 12].map((n) => prisma.vehicle.create({ data: minimalVehicle(ORG_A, n) })));
    await Promise.all(
      vehicles.map((v, i) =>
        prisma.$transaction((tx) => correctSerialNumber(tx, ORG_A, "FC", [210, 6, 95, 410, 13][i]!, v.id))
      )
    );
    expect(await counter(ORG_A, "FC")).toBe(410);
  });
});

describe("two people typing the same legacy serial at the same moment", () => {
  it("exactly one vehicle is created; the database unique constraint rejects the rest", async () => {
    // The application check ("does it exist?") runs before the insert, so several can pass it
    // together. The unique constraint on (org_id, serial) is what makes the outcome safe.
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        prisma.$transaction(async (tx) => {
          await assignLegacySerial(tx, ORG_A, "FC", 77);
          await tx.vehicle.create({ data: minimalVehicle(ORG_A, 77) });
        })
      )
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A, serial: "FC77" } })).toBe(1);

    for (const failed of attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected")) {
      const reason = failed.reason as { code?: string };
      // Either the application check saw the row (CONFLICT) or the database did (P2002).
      // createVehicle must turn a P2002 here into the same CONFLICT field error.
      const dbConstraint = failed.reason instanceof Prisma.PrismaClientKnownRequestError && failed.reason.code === "P2002";
      expect(dbConstraint || reason.code === "CONFLICT").toBe(true);
    }
  });
});
