// The daily checks against real Postgres: running them twice in one day must change nothing the
// second time (no second StatusHistory row, no second Notification), and must only touch this org.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { ORG_A, ORG_B, minimalVehicle, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { runDailyVehicleChecks } from "../../src/services/reminder.service.js";

const prisma = getTestPrisma();

const day = (offset: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};

beforeEach(async () => {
  await resetDb(prisma);
  await seedTwoOrgs(prisma);
  for (const [org, id] of [[ORG_A, "staff_a"], [ORG_B, "staff_b"]] as const) {
    await prisma.user.create({
      data: { id, org_id: org, userType: "STAFF", name: "Test Staff", role: "MANAGER", loginEnabled: true },
    });
  }
  // A: booked and past its ETD -> flips to SHIPPED. Bill unpaid 8 days -> payment reminder.
  await prisma.vehicle.create({
    data: minimalVehicle(ORG_A, 1, {
      shipmentStatus: "BOOKING_RECEIVED", etd: day(-3), purchaseDate: day(-8), auctionBillPaid: false,
    }),
  });
  // A: bill paid, no transport company -> rikso reminder.
  await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 2, { auctionBillPaid: true }) });
  // A: soft-deleted with the same conditions -> must be ignored.
  await prisma.vehicle.create({
    data: minimalVehicle(ORG_A, 3, { auctionBillPaid: true, deletedAt: new Date() }),
  });
  // B: same shape as the first -> must not be touched by a run for A.
  await prisma.vehicle.create({
    data: minimalVehicle(ORG_B, 1, {
      shipmentStatus: "BOOKING_RECEIVED", etd: day(-3), purchaseDate: day(-8), auctionBillPaid: false,
    }),
  });
});
afterAll(closeTestPrisma);

const counts = async () => ({
  history: await prisma.statusHistory.count(),
  notifications: await prisma.notification.count(),
});

describe("runDailyVehicleChecks", () => {
  it("does the work on the first run", async () => {
    const summary = await runDailyVehicleChecks(ORG_A);
    expect(summary.errors).toEqual([]);
    expect(summary.shippedTransitions).toBe(1);
    expect(summary.paymentReminders).toBe(1);
    expect(summary.riksoReminders).toBe(1);

    const shipped = await prisma.vehicle.findFirstOrThrow({ where: { org_id: ORG_A, serial: "FC1" } });
    expect(shipped.shipmentStatus).toBe("SHIPPED");
    expect((await counts()).history).toBe(1);
  });

  it("a second run the same day creates no duplicate StatusHistory or Notification rows", async () => {
    await runDailyVehicleChecks(ORG_A);
    const afterFirst = await counts();
    expect(afterFirst.notifications).toBeGreaterThan(0);

    const again = await runDailyVehicleChecks(ORG_A);
    expect(again.errors).toEqual([]);
    expect(again).toMatchObject({ shippedTransitions: 0, paymentReminders: 0, riksoReminders: 0 });
    expect(await counts()).toEqual(afterFirst);
  });

  it("a run for one org leaves the other org's vehicles and rows alone", async () => {
    await runDailyVehicleChecks(ORG_A);
    const other = await prisma.vehicle.findFirstOrThrow({ where: { org_id: ORG_B, serial: "FC1" } });
    expect(other.shipmentStatus).toBe("BOOKING_RECEIVED");
    expect(await prisma.notification.count({ where: { org_id: ORG_B } })).toBe(0);
  });

  it("never touches a soft-deleted vehicle", async () => {
    await runDailyVehicleChecks(ORG_A);
    const deleted = await prisma.vehicle.findFirstOrThrow({ where: { org_id: ORG_A, serial: "FC3" } });
    const notes = await prisma.notification.count({ where: { vehicleId: deleted.id } });
    expect(notes).toBe(0);
  });
});
