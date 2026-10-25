// Parallel milestone recording. Needs REAL concurrent connections (a Postgres container locally, the service
// container in CI). A single-session engine serializes everything and would pass without proving anything.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { minimalVehicle } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { recordMilestoneOnce } from "../../src/services/milestone.service.js";
import { runDailyShipmentStatusTransitions } from "../../src/services/vehicle.service.js";

const prisma = getTestPrisma();
const ORG = "org_test_a";

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.organization.create({ data: { id: ORG, name: ORG } });
});
afterAll(closeTestPrisma);

describe("exactly-once under parallel writers", () => {
  it("25 parallel transactions recording the same milestone: one row, exactly one reports creating it", async () => {
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1) });
    const results = await Promise.all(
      Array.from({ length: 25 }, () => prisma.$transaction((tx) => recordMilestoneOnce(tx, { orgId: ORG, vehicleId: v.id, type: "ARRIVED", occurredAt: new Date() })))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.vehicleMilestone.count({ where: { vehicleId: v.id } })).toBe(1);
  });

  it("5 parallel daily runs: one SHIPPED milestone, one history row, one transition in total", async () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 4);
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1, { shipmentStatus: "BOOKING_RECEIVED", etd: d }) });
    const counts = await Promise.all(Array.from({ length: 5 }, () => runDailyShipmentStatusTransitions(ORG)));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await prisma.vehicleMilestone.count({ where: { vehicleId: v.id, type: "SHIPPED" } })).toBe(1);
    expect(await prisma.statusHistory.count({ where: { vehicleId: v.id, toStatus: "SHIPPED" } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// A concurrent set and clear of the ETD. updateVehicle takes a row lock and decides from a fresh read, so however the
// two edits interleave, the status, the ETD and the automatic milestone always agree afterwards.

import { updateVehicle } from "../../src/services/vehicle.service.js";

describe("concurrent set/clear of the ETD", () => {
  const actor = { id: "staff", orgId: ORG, role: "MANAGER" as const, name: "Staff", email: null };
  const base = { chassisNo: "CHASSIS-RACE", brandId: "brand_race", modelId: "model_race" };

  it("20 rounds of parallel set and clear never leave the status and the milestone disagreeing", async () => {
    await prisma.user.create({ data: { id: "staff", org_id: ORG, userType: "STAFF", name: "Staff", role: "MANAGER", loginEnabled: true } });
    await prisma.brand.create({ data: { id: "brand_race", org_id: ORG, name: "Brand" } });
    await prisma.vehicleModelRef.create({ data: { id: "model_race", org_id: ORG, brand_id: "brand_race", name: "Model" } });
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1) });

    for (let round = 0; round < 20; round++) {
      const writes = [
        ...Array.from({ length: 3 }, () => updateVehicle(actor, v.id, { ...base, etd: "2031-01-01" })),
        ...Array.from({ length: 3 }, () => updateVehicle(actor, v.id, base)),
      ];
      const results = await Promise.allSettled(writes);
      expect(results.filter((r) => r.status === "rejected"), `round ${round}`).toHaveLength(0);

      const row = await prisma.vehicle.findUniqueOrThrow({ where: { id: v.id } });
      const milestones = await prisma.vehicleMilestone.findMany({ where: { vehicleId: v.id } });
      // status <-> etd <-> milestone: all three say the same thing
      expect(row.shipmentStatus === "BOOKING_RECEIVED", `round ${round}: status vs etd`).toBe(row.etd !== null);
      expect(milestones.map((m) => m.type), `round ${round}: milestone`).toEqual(row.shipmentStatus === "BOOKING_RECEIVED" ? ["BOOKING_RECEIVED"] : []);
    }
  });
});
