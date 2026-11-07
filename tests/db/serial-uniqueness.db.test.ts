// Serial uniqueness among vehicles that are NOT soft-deleted (ADR 0009), on REAL Postgres. Two states of the database are exercised, in order:
//   STATE 1  migration 1 applied (the test harness builds it): the two PARTIAL unique indexes sit next to the OLD full uniques.
//            Active duplicates are refused, other organisations are independent, and a deleted vehicle's serial is STILL blocked (by the old index).
//   STATE 2  migration 2 applied (prisma/pending-migrations/..., applied here by the test only): only the partial indexes remain. A serial held
//            only by deleted vehicles can be used again; two ACTIVE vehicles still cannot share one, also under concurrency.
// The old indexes are put back at the end, so every other test file sees STATE 1. Needs real concurrent connections. Fake data only.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeTestDatabaseUrl } from "./guard.js";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { ORG_A, ORG_B, minimalVehicle, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { ServiceError } from "../../src/lib/errors.js";
import {
  convertVehicleToExport,
  correctVehicleSerialNumber,
  createVehicleDetail,
  createVehicleWithReuse,
  deleteVehicle,
  getVehicleDetail,
  resolveVehicleIdBySerial,
  revertVehicleToLocal,
} from "../../src/services/vehicle.service.js";

const prisma = getTestPrisma();
const actorA = { id: "actor_a", orgId: ORG_A, role: "ADMINISTRATOR" as const, name: "Administrator", email: null };
type SessionLike = { id: string; orgId: string; role: "ADMINISTRATOR" | "MANAGER"; name: string; email: null };
const managerA: SessionLike = { id: "mgr_a", orgId: ORG_A, role: "MANAGER" as const, name: "Manager", email: null };
const actorB = { id: "actor_b", orgId: ORG_B, role: "ADMINISTRATOR" as const, name: "Administrator", email: null };

const MIGRATION_2 = path.join("prisma", "pending-migrations", readdirSync(path.join("prisma", "pending-migrations")).find((n) => /_vehicle_serial_drop_full_uniques$/.test(n))!, "migration.sql");
const OLD_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "Vehicle_org_id_serial_key" ON "Vehicle"("org_id", "serial")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Vehicle_org_id_serialPrefix_serialNumber_key" ON "Vehicle"("org_id", "serialPrefix", "serialNumber")`,
];

/** Runs raw SQL (several statements) through the guarded test URL only. */
async function runSql(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: assertSafeTestDatabaseUrl(process.env["TEST_DATABASE_URL"]).url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
const toState1 = async () => {
  await resetDb(prisma);
  for (const sql of OLD_INDEXES) await runSql(sql);
};
const toState2 = async () => runSql(readFileSync(MIGRATION_2, "utf8"));

async function indexDefs(): Promise<Record<string, string>> {
  const rows = await prisma.$queryRaw<Array<{ name: string; def: string; pred: string | null; uniq: boolean }>>`
    SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def, pg_get_expr(i.indpred, i.indrelid) AS pred, i.indisunique AS uniq
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname = 'Vehicle' AND i.indisunique`;
  return Object.fromEntries(rows.map((r) => [r.name, `${r.def} || predicate: ${r.pred ?? "none"}`]));
}

const body = (n: number, chassis = `CH-${n}-${Math.random().toString(36).slice(2, 8)}`, track: "FC" | "FL" = "FC") => ({
  track, isLegacyEntry: true, legacySerialNumber: n, chassisNo: chassis, brandId: "brand_x", modelId: "model_x",
});
const create = (actor: SessionLike, n: number, track: "FC" | "FL" = "FC") => createVehicleWithReuse(actor, body(n, undefined, track));
const counter = async (org = ORG_A, prefix: "FC" | "FL" = "FC") => (await prisma.serialCounter.findUniqueOrThrow({ where: { org_id_prefix: { org_id: org, prefix } } })).lastNumber;
const conflictOf = async (job: Promise<unknown>) => {
  const error = await job.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
};

beforeEach(async () => {
  expect(Number(process.env["TEST_DATABASE_POOL_MAX"] ?? 10)).toBeGreaterThanOrEqual(2);
  await resetDb(prisma);
  await seedTwoOrgs(prisma);
  // the activity log has a foreign key on the actor
  await prisma.user.createMany({
    data: [
      { id: "actor_a", org_id: ORG_A, userType: "STAFF", name: "Administrator", role: "ADMINISTRATOR", loginEnabled: true },
      { id: "mgr_a", org_id: ORG_A, userType: "STAFF", name: "Manager", role: "MANAGER", loginEnabled: true },
      { id: "actor_b", org_id: ORG_B, userType: "STAFF", name: "Administrator", role: "ADMINISTRATOR", loginEnabled: true },
    ],
  });
  for (const org of [ORG_A, ORG_B]) {
    await prisma.brand.create({ data: { id: `brand_x`.concat(org === ORG_B ? "_b" : ""), org_id: org, name: "Make X" } });
    await prisma.vehicleModelRef.create({ data: { id: `model_x`.concat(org === ORG_B ? "_b" : ""), org_id: org, brand_id: `brand_x`.concat(org === ORG_B ? "_b" : ""), name: "Model X" } });
  }
});
afterAll(async () => {
  await toState1(); // every other file expects the harness state
  await closeTestPrisma();
});

// Organisation B's lookups have their own ids.
const bodyFor = (actor: SessionLike, n: number, track: "FC" | "FL" = "FC") =>
  actor.orgId === ORG_B ? { ...body(n, undefined, track), brandId: "brand_x_b", modelId: "model_x_b" } : body(n, undefined, track);
const createFor = (actor: SessionLike, n: number) => createVehicleWithReuse(actor, bodyFor(actor, n));

describe("STATE 1: migration 1 applied (partial indexes next to the old full ones)", () => {
  beforeAll(toState1);

  it("both PARTIAL unique indexes exist, start with org_id, and are limited to deletedAt IS NULL; the old full ones are still there", async () => {
    const defs = await indexDefs();
    expect(defs["Vehicle_org_serial_active_key"]).toMatch(/\(org_id, serial\)/);
    expect(defs["Vehicle_org_serial_active_key"]).toMatch(/predicate: \("deletedAt" IS NULL\)/);
    expect(defs["Vehicle_org_prefix_number_active_key"]).toMatch(/\(org_id, "serialPrefix", "serialNumber"\)/);
    expect(defs["Vehicle_org_prefix_number_active_key"]).toMatch(/predicate: \("deletedAt" IS NULL\)/);
    for (const name of ["Vehicle_org_serial_active_key", "Vehicle_org_prefix_number_active_key"]) expect(defs[name], name).toMatch(/^CREATE UNIQUE INDEX/);
    expect(defs["Vehicle_org_id_serial_key"]).toMatch(/predicate: none/);
    expect(defs["Vehicle_org_id_serialPrefix_serialNumber_key"]).toMatch(/predicate: none/);
  });

  it("two ACTIVE vehicles with the same serial are refused by the service (409) and by the database", async () => {
    await create(actorA, 300);
    const error = await conflictOf(create(actorA, 300));
    expect(error.code).toBe("CONFLICT");
    expect(error.fieldErrors).toMatchObject({ serial: "already in use", legacySerialNumber: "Serial FC300 already exists." });
    // the database alone, bypassing the service
    await expect(prisma.vehicle.create({ data: minimalVehicle(ORG_A, 300) })).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A, serial: "FC300" } })).toBe(1);
  });

  it("the same serial in ANOTHER organisation is allowed", async () => {
    await createFor(actorA, 301);
    expect((await createFor(actorB, 301)).vehicle.serial).toBe("FC301");
    expect(await prisma.vehicle.count({ where: { serial: "FC301" } })).toBe(2);
  });

  it("a different prefix with the same number is a different serial", async () => {
    await create(actorA, 302, "FC");
    expect((await create(actorA, 302, "FL")).vehicle.serial).toBe("FL302");
  });

  it("WITHOUT migration 2 reuse is still BLOCKED: a deleted vehicle's serial is a 409 (the old full unique index holds it)", async () => {
    const first = await create(actorA, 303);
    await deleteVehicle(ORG_A, actorA.id, first.vehicle.id);
    const error = await conflictOf(create(actorA, 303));
    expect(error.code).toBe("CONFLICT");
    expect(error.fieldErrors).toHaveProperty("serial", "already in use");
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A, serial: "FC303" } })).toBe(1);
  });

  it("the same, for a correction to a deleted vehicle's serial", async () => {
    const holder = await create(actorA, 304);
    await deleteVehicle(ORG_A, actorA.id, holder.vehicle.id);
    const other = await create(actorA, 305);
    const error = await conflictOf(correctVehicleSerialNumber(ORG_A, actorA.id, other.vehicle.id, 304));
    expect(error.code).toBe("CONFLICT");
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: other.vehicle.id } })).serial).toBe("FC305");
  });
});

describe("STATE 2: migration 2 applied (only the partial indexes remain)", () => {
  beforeAll(async () => {
    await toState1();
    await toState2();
  });
  afterAll(toState1);

  it("the old full indexes are gone and both partial ones are still there", async () => {
    const defs = await indexDefs();
    expect(Object.keys(defs).filter((n) => /^Vehicle_org_id_serial/.test(n))).toEqual([]);
    expect(Object.keys(defs)).toEqual(expect.arrayContaining(["Vehicle_org_serial_active_key", "Vehicle_org_prefix_number_active_key"]));
  });

  it("migration 2 can be run twice (idempotent)", async () => {
    await expect(toState2()).resolves.toBeUndefined();
  });

  it("the same serial after a soft delete is allowed: a new vehicle with serialReused true, and the log names the deleted one", async () => {
    const first = await create(actorA, 310);
    await deleteVehicle(ORG_A, actorA.id, first.vehicle.id);
    const second = await create(managerA, 310); // a MANAGER may create too
    expect(second.vehicle.serial).toBe("FC310");
    expect(second.vehicle.id).not.toBe(first.vehicle.id);
    expect(second.reusedFromVehicleId).toBe(first.vehicle.id);
    const log = await prisma.activityLog.findFirstOrThrow({ where: { org_id: ORG_A, action: "CREATE_VEHICLE", entityId: second.vehicle.id } });
    expect((log.after as { reusedFromVehicleId?: string }).reusedFromVehicleId).toBe(first.vehicle.id);
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A, serial: "FC310" } })).toBe(2);
  });

  it("a serial nobody had is not 'reused': reusedFromVehicleId is null and the log has no such key", async () => {
    const fresh = await create(actorA, 311);
    expect(fresh.reusedFromVehicleId).toBeNull();
    const log = await prisma.activityLog.findFirstOrThrow({ where: { org_id: ORG_A, action: "CREATE_VEHICLE", entityId: fresh.vehicle.id } });
    expect(log.after).not.toHaveProperty("reusedFromVehicleId");
  });

  it("another organisation's DELETED vehicle with the same serial is never named as the source", async () => {
    const theirs = await createFor(actorB, 313);
    await deleteVehicle(ORG_B, actorB.id, theirs.vehicle.id);
    const mine = await create(actorA, 313);
    expect(mine.reusedFromVehicleId).toBeNull();
    const log = await prisma.activityLog.findFirstOrThrow({ where: { org_id: ORG_A, action: "CREATE_VEHICLE", entityId: mine.vehicle.id } });
    expect(log.after).not.toHaveProperty("reusedFromVehicleId");
  });

  it("the answer of POST /vehicles (createVehicleDetail) says serialReused true for a taken-over serial and false otherwise", async () => {
    const first = await createVehicleDetail(actorA, body(314));
    expect(first.serialReused).toBe(false);
    await deleteVehicle(ORG_A, actorA.id, first.id);
    const second = await createVehicleDetail(actorA, body(314));
    expect([second.serial, second.serialReused]).toEqual(["FC314", true]);
    expect(second.id).not.toBe(first.id);
    const fresh = await createVehicleDetail(actorA, body(315));
    expect(fresh.serialReused).toBe(false);
  });

  it("with several deleted holders the MOST RECENTLY deleted one is named", async () => {
    const a = await create(actorA, 312);
    await deleteVehicle(ORG_A, actorA.id, a.vehicle.id);
    const b = await create(actorA, 312);
    await deleteVehicle(ORG_A, actorA.id, b.vehicle.id);
    const c = await create(actorA, 312);
    expect(c.reusedFromVehicleId).toBe(b.vehicle.id);
  });

  it("two ACTIVE vehicles with the same serial are still refused (the partial index holds)", async () => {
    await create(actorA, 313);
    expect((await conflictOf(create(actorA, 313))).code).toBe("CONFLICT");
    await expect(prisma.vehicle.create({ data: minimalVehicle(ORG_A, 313) })).rejects.toMatchObject({ code: "P2002" });
  });

  it("delete, recreate, then correct ANOTHER vehicle to the recreated serial: 409", async () => {
    const old = await create(actorA, 314);
    await deleteVehicle(ORG_A, actorA.id, old.vehicle.id);
    await create(actorA, 314);
    const other = await create(actorA, 315);
    const error = await conflictOf(correctVehicleSerialNumber(ORG_A, actorA.id, other.vehicle.id, 314));
    expect(error.code).toBe("CONFLICT");
    expect(error.fieldErrors).toHaveProperty("serial", "already in use");
  });

  it("a correction to a serial held only by a deleted vehicle succeeds: serialReused true, the log names it, the counter is untouched", async () => {
    const gone = await create(actorA, 316);
    await deleteVehicle(ORG_A, actorA.id, gone.vehicle.id);
    const target = await create(actorA, 330);
    const before = await counter();
    const result = await correctVehicleSerialNumber(ORG_A, actorA.id, target.vehicle.id, 316);
    expect(result).toEqual({ serial: "FC316", serialReused: true });
    const log = await prisma.activityLog.findFirstOrThrow({ where: { org_id: ORG_A, action: "CORRECT_VEHICLE_SERIAL", entityId: target.vehicle.id } });
    expect(log.after).toEqual({ serial: "FC316", reusedFromVehicleId: gone.vehicle.id });
    expect(await counter()).toBe(before); // a reused LOWER number never moves the counter
  });

  it("a correction to a free serial: serialReused false", async () => {
    const v = await create(actorA, 317);
    expect(await correctVehicleSerialNumber(ORG_A, actorA.id, v.vehicle.id, 399)).toEqual({ serial: "FC399", serialReused: false });
  });

  it("the same serial in another organisation, and in the same organisation under another prefix, are independent", async () => {
    await createFor(actorA, 318);
    await createFor(actorB, 318);
    await create(actorA, 318, "FL");
    expect(await prisma.vehicle.count({ where: { serial: { in: ["FC318", "FL318"] } } })).toBe(3);
  });

  it("the lookup by serial returns the ACTIVE vehicle when a deleted one shares the serial, for every serial route", async () => {
    const old = await create(actorA, 319);
    await deleteVehicle(ORG_A, actorA.id, old.vehicle.id);
    const current = await create(actorA, 319);
    expect((await getVehicleDetail(ORG_A, "FC319"))?.id).toBe(current.vehicle.id);
    expect(await resolveVehicleIdBySerial(ORG_A, "FC319")).toBe(current.vehicle.id);
    await deleteVehicle(ORG_A, actorA.id, current.vehicle.id);
    expect(await getVehicleDetail(ORG_A, "FC319")).toBeNull(); // both deleted: nothing to find
    await expect(resolveVehicleIdBySerial(ORG_A, "FC319")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an automatic serial never reuses a number: the counter only goes up, also after deleting the newest vehicle", async () => {
    const auto = async () => (await createVehicleWithReuse(actorA, { track: "FC", isLegacyEntry: false, chassisNo: `AUTO-${Math.random()}`, brandId: "brand_x", modelId: "model_x" }));
    const first = await auto();
    expect(first.reusedFromVehicleId).toBeNull();
    await deleteVehicle(ORG_A, actorA.id, first.vehicle.id);
    const second = await auto();
    expect(second.vehicle.serialNumber).toBe(first.vehicle.serialNumber + 1);
    expect(second.reusedFromVehicleId).toBeNull();
  });

  it("entering a legacy serial still bumps the counter with max(): higher raises it, a reused lower one leaves it", async () => {
    const low = await create(actorA, 320);
    await deleteVehicle(ORG_A, actorA.id, low.vehicle.id);
    await create(actorA, 500);
    expect(await counter()).toBe(500);
    await create(actorA, 320); // reuse of a LOWER number
    expect(await counter()).toBe(500);
    await create(actorA, 600);
    expect(await counter()).toBe(600);
  });

  it("FC and FL conversions keep working, and do not touch the serial, while a deleted vehicle shares it", async () => {
    const fl = await create(actorA, 321, "FL");
    await deleteVehicle(ORG_A, actorA.id, fl.vehicle.id);
    const live = await create(actorA, 321, "FL"); // reuses FL321
    await convertVehicleToExport(ORG_A, actorA.id, live.vehicle.id, "Example Country");
    let row = await prisma.vehicle.findUniqueOrThrow({ where: { id: live.vehicle.id } });
    expect([row.serial, row.convertedToExport]).toEqual(["FL321", true]);
    await revertVehicleToLocal(ORG_A, actorA.id, live.vehicle.id);
    row = await prisma.vehicle.findUniqueOrThrow({ where: { id: live.vehicle.id } });
    expect([row.serial, row.convertedToExport]).toEqual(["FL321", false]);
  });

  it("CONCURRENT creates of the same FREE serial: exactly one 201, every other is a 409", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => create(actorA, 340)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      expect(r.reason).toBeInstanceOf(ServiceError);
      expect((r.reason as ServiceError).code).toBe("CONFLICT");
      expect((r.reason as ServiceError).fieldErrors).toHaveProperty("serial", "already in use");
    }
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A, serial: "FC340", deletedAt: null } })).toBe(1);
  });

  it("CONCURRENT creates of a serial held only by a DELETED vehicle: exactly one 201 (serialReused), the rest 409", async () => {
    const gone = await create(actorA, 341);
    await deleteVehicle(ORG_A, actorA.id, gone.vehicle.id);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => create(actorA, 341)));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof create>>> => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect(ok[0]!.value.reusedFromVehicleId).toBe(gone.vehicle.id);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
    for (const r of results) if (r.status === "rejected") expect((r.reason as ServiceError).code).toBe("CONFLICT");
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A, serial: "FC341", deletedAt: null } })).toBe(1);
  });

  it("CONCURRENT corrections of several vehicles to one free serial: exactly one wins, the rest are 409", async () => {
    const ids = [];
    for (let n = 0; n < 6; n += 1) ids.push((await create(actorA, 350 + n)).vehicle.id);
    const results = await Promise.allSettled(ids.map((id) => correctVehicleSerialNumber(ORG_A, actorA.id, id, 360)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as ServiceError).code).toBe("CONFLICT");
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A, serial: "FC360" } })).toBe(1);
  });
});
