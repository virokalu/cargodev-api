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
