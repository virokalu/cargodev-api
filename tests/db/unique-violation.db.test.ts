// Two requests that pass the "does it exist?" check together must end with exactly ONE success and ONE 409 with a field error, never a 500.
// This needs REAL concurrent connections (a Postgres container locally, a service container in CI): a single-session engine serialises
// everything and proves nothing. Fake data only.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { ORG_A, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { ServiceError } from "../../src/lib/errors.js";
import { createCustomerFull, updateCustomer } from "../../src/services/customer.service.js";
import { findOrCreateBrand, renameBrand } from "../../src/services/lookup.service.js";
import { createStaff, updateStaff } from "../../src/services/user.service.js";
import { correctVehicleSerialNumber, createVehicle } from "../../src/services/vehicle.service.js";

const prisma = getTestPrisma();
const actor = { id: "actor", orgId: ORG_A, role: "ADMINISTRATOR" as const, name: "Administrator", email: null };
const PASSWORD = ["a", "long", "example", "phrase"].join("-") + "-123";

beforeEach(async () => {
  expect(Number(process.env["TEST_DATABASE_POOL_MAX"] ?? 10)).toBeGreaterThanOrEqual(2);
  await resetDb(prisma);
  await seedTwoOrgs(prisma);
  await prisma.user.create({ data: { id: "actor", org_id: ORG_A, userType: "STAFF", name: "Administrator", role: "ADMINISTRATOR", loginEnabled: true, email: "admin@example.test" } });
});
afterAll(closeTestPrisma);

/** Runs the jobs at once; returns the fulfilled values and the ServiceErrors (anything else fails the test). */
async function race<T>(jobs: Array<() => Promise<T>>): Promise<{ ok: T[]; conflicts: ServiceError[] }> {
  const settled = await Promise.allSettled(jobs.map((job) => job()));
  const ok: T[] = [];
  const conflicts: ServiceError[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") ok.push(result.value);
    else if (result.reason instanceof ServiceError && result.reason.code === "CONFLICT") conflicts.push(result.reason);
    else throw result.reason;
  }
  return { ok, conflicts };
}

describe("customers", () => {
  it("creating the same email at once: exactly one wins, the others are 409 with fieldErrors.email", async () => {
    const { ok, conflicts } = await race(Array.from({ length: 6 }, (_, i) => () => createCustomerFull(actor, { name: `Buyer ${i}`, email: "same.buyer@example.test" })));
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(5);
    for (const c of conflicts) expect(c.fieldErrors).toHaveProperty("email");
    expect(await prisma.user.count({ where: { org_id: ORG_A, email: "same.buyer@example.test" } })).toBe(1);
  });

  it("updating two customers to the same email at once: one wins, one is 409", async () => {
    await prisma.user.createMany({
      data: [
        { id: "c1", org_id: ORG_A, userType: "CUSTOMER", name: "C1", email: "c1@example.test" },
        { id: "c2", org_id: ORG_A, userType: "CUSTOMER", name: "C2", email: "c2@example.test" },
      ],
    });
    const { ok, conflicts } = await race([
      () => updateCustomer(actor, "c1", { email: "taken@example.test" }),
      () => updateCustomer(actor, "c2", { email: "taken@example.test" }),
    ]);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.fieldErrors).toHaveProperty("email");
  });

  it("the same email in another organisation is allowed", async () => {
    await createCustomerFull(actor, { name: "A", email: "shared@example.test" });
    await prisma.user.create({ data: { id: "other", org_id: "org_db_test_b", userType: "CUSTOMER", name: "B", email: "shared@example.test" } });
    expect(await prisma.user.count({ where: { email: "shared@example.test" } })).toBe(2);
  });
});

describe("staff", () => {
  it("creating the same email at once: exactly one wins, the others are 409 with fieldErrors.email", async () => {
    const { ok, conflicts } = await race(
      Array.from({ length: 4 }, (_, i) => () => createStaff(actor, { name: `Person ${i}`, email: "same.staff@example.test", phone: null, role: "OPERATOR", password: PASSWORD }))
    );
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(3);
    for (const c of conflicts) expect(c.fieldErrors).toHaveProperty("email");
  });

  it("updating two accounts to the same email at once: one wins, one is 409", async () => {
    await prisma.user.createMany({
      data: [
        { id: "s1", org_id: ORG_A, userType: "STAFF", name: "S1", email: "s1@example.test", role: "OPERATOR", loginEnabled: true },
        { id: "s2", org_id: ORG_A, userType: "STAFF", name: "S2", email: "s2@example.test", role: "OPERATOR", loginEnabled: true },
      ],
    });
    const { ok, conflicts } = await race([() => updateStaff(actor, "s1", { email: "taken.staff@example.test" }), () => updateStaff(actor, "s2", { email: "taken.staff@example.test" })]);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.fieldErrors).toHaveProperty("email");
  });
});

describe("lookups", () => {
  it("two renames to the same name at once: one wins, one is 409 with fieldErrors.name", async () => {
    await prisma.brand.createMany({ data: [{ id: "b1", org_id: ORG_A, name: "One" }, { id: "b2", org_id: ORG_A, name: "Two" }] });
    const { ok, conflicts } = await race([() => renameBrand(actor, "b1", "Merged"), () => renameBrand(actor, "b2", "Merged")]);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.fieldErrors).toHaveProperty("name");
    expect(await prisma.brand.count({ where: { org_id: ORG_A, name: "Merged" } })).toBe(1);
  });

  it("renaming to a name another row already has (no race) is a 409 with fieldErrors.name, compared without regard to case", async () => {
    await prisma.brand.createMany({ data: [{ id: "b1", org_id: ORG_A, name: "One" }, { id: "b2", org_id: ORG_A, name: "Two" }] });
    const { ok, conflicts } = await race([() => renameBrand(actor, "b1", "tWo")]);
    expect(ok).toHaveLength(0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.fieldErrors).toHaveProperty("name");
  });

  it("creating the same name at once yields one row, and every caller gets that row (find-or-create)", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => findOrCreateBrand(actor, "Fresh Make")));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.brand.count({ where: { org_id: ORG_A, name: "Fresh Make" } })).toBe(1);
  });
});

describe("vehicle serials", () => {
  const body = (legacy: number, chassis: string) => ({ track: "FC", isLegacyEntry: true, legacySerialNumber: legacy, chassisNo: chassis, brandId: "brand_x", modelId: "model_x" });

  async function seedLookups() {
    await prisma.brand.create({ data: { id: "brand_x", org_id: ORG_A, name: "Make X" } });
    await prisma.vehicleModelRef.create({ data: { id: "model_x", org_id: ORG_A, brand_id: "brand_x", name: "Model X" } });
  }

  it("two vehicles created with the same legacy serial at once: one wins, one is 409 with fieldErrors.legacySerialNumber", async () => {
    await seedLookups();
    const { ok, conflicts } = await race([() => createVehicle(actor, body(500, "CH-1")), () => createVehicle(actor, body(500, "CH-2"))]);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.fieldErrors).toHaveProperty("legacySerialNumber");
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A, serial: "FC500" } })).toBe(1);
  });

  it("a deleted vehicle's serial: 409 SERIAL_PREVIOUSLY_USED on create and correction, 403 for a manager's flag, SERIAL_REUSE_NOT_ENABLED for the administrator's", async () => {
    await seedLookups();
    await prisma.vehicle.createMany({
      data: [
        { id: "gone", org_id: ORG_A, serialPrefix: "FC" as const, serialNumber: 300, serial: "FC300", deletedAt: new Date("2026-10-01T00:00:00Z") },
        { id: "live", org_id: ORG_A, serialPrefix: "FC" as const, serialNumber: 301, serial: "FC301" },
      ],
    });
    const reasonOf = async (job: () => Promise<unknown>) => {
      const error = await job().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceError);
      return { code: (error as ServiceError).code, reason: (error as ServiceError).reason };
    };
    const manager = { ...actor, id: "mgr", role: "MANAGER" as const, name: "Manager" };
    expect(await reasonOf(() => createVehicle(actor, body(300, "CH-D1")))).toEqual({ code: "CONFLICT", reason: "SERIAL_PREVIOUSLY_USED" });
    expect(await reasonOf(() => createVehicle(actor, { ...body(300, "CH-D2"), reuseDeletedSerial: true }))).toEqual({ code: "CONFLICT", reason: "SERIAL_REUSE_NOT_ENABLED" });
    expect(await reasonOf(() => createVehicle(manager, { ...body(300, "CH-D3"), reuseDeletedSerial: true }))).toEqual({ code: "FORBIDDEN", reason: undefined });
    expect(await reasonOf(() => createVehicle(actor, body(301, "CH-L1")))).toEqual({ code: "CONFLICT", reason: undefined });
    expect(await reasonOf(() => correctVehicleSerialNumber(ORG_A, "actor", "live", 300))).toEqual({ code: "CONFLICT", reason: "SERIAL_PREVIOUSLY_USED" });
    expect(await reasonOf(() => correctVehicleSerialNumber(ORG_A, "actor", "live", 300, true))).toEqual({ code: "CONFLICT", reason: "SERIAL_REUSE_NOT_ENABLED" });
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A, serial: "FC300" } })).toBe(1); // the deleted one, still the only holder
  });

  it("ten corrections to the same serial at once: one wins, nine are 409 with fieldErrors.serialNumber (most pass the existence check together and are stopped by the database)", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `v${i}`);
    await prisma.vehicle.createMany({ data: ids.map((id, i) => ({ id, org_id: ORG_A, serialPrefix: "FC" as const, serialNumber: i + 1, serial: `FC${i + 1}` })) });
    const { ok, conflicts } = await race(ids.map((id) => () => correctVehicleSerialNumber(ORG_A, "actor", id, 77)));
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    for (const c of conflicts) expect(c.fieldErrors).toHaveProperty("serialNumber");
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A, serial: "FC77" } })).toBe(1);
  });
});
