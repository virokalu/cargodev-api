// Slice 5 on real Postgres: the SQL parts the fake cannot prove (JSON preferences, unique indexes under parallel
// writers, the advisory lock around the daily job, timestamp ordering). Fake data only.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { minimalVehicle } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});
vi.mock("../../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import {
  getPreferences,
  listAlerts,
  markAlertsRead,
  recordHeartbeat,
  registerCustomerDevice,
  updatePreferences,
} from "../../src/services/customer-alerts.service.js";
import { withAdvisoryLock } from "../../src/scheduler/lock.js";
import { emit } from "../../src/services/notification.service.js";
import { runDailyVehicleChecks } from "../../src/services/reminder.service.js";

const prisma = getTestPrisma();
const ORG = "org_test_a";
const ME = { id: "cust_1", orgId: ORG };
const OTHER = { id: "cust_2", orgId: ORG };
const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const day = (offset: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.organization.create({ data: { id: ORG, name: ORG } });
  await prisma.user.createMany({
    data: [
      { id: "staff", org_id: ORG, userType: "STAFF", name: "Staff", role: "MANAGER", loginEnabled: true },
      { id: "cust_1", org_id: ORG, userType: "CUSTOMER", name: "C1", email: "c1@example.test", loginEnabled: true, emailVerifiedAt: new Date() },
      { id: "cust_2", org_id: ORG, userType: "CUSTOMER", name: "C2", email: "c2@example.test", loginEnabled: true, emailVerifiedAt: new Date() },
    ],
  });
});
afterAll(closeTestPrisma);

describe("alerts", () => {
  it("are grouped by day newest first, with a stable order inside a day, scoped to the customer", async () => {
    const at = (iso: string) => new Date(iso);
    await prisma.notification.createMany({
      data: [
        { id: "a1", org_id: ORG, userId: ME.id, event: "PHOTOS_ADDED", title: "t", body: "b", createdAt: at("2026-10-27T09:00:00Z") },
        { id: "a2", org_id: ORG, userId: ME.id, event: "PHOTOS_ADDED", title: "t", body: "b", createdAt: at("2026-10-27T09:00:00Z") },
        { id: "a3", org_id: ORG, userId: ME.id, event: "PHOTOS_ADDED", title: "t", body: "b", createdAt: at("2026-10-26T23:59:59Z"), isRead: true },
        { id: "x1", org_id: ORG, userId: OTHER.id, event: "PHOTOS_ADDED", title: "t", body: "b", createdAt: at("2026-10-27T10:00:00Z") },
      ],
    });
    const page = await listAlerts(ME, {});
    expect(page.days.map((d) => [d.date, d.alerts.map((a) => a.id)])).toEqual([["2026-10-27", ["a2", "a1"]], ["2026-10-26", ["a3"]]]);
    expect(page.unreadCount).toBe(2);
    expect(page.total).toBe(3);

    expect(await markAlertsRead(ME, { ids: ["a1", "x1"] })).toEqual({ updated: 1 });
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: "x1" } })).isRead).toBe(false);
    expect(await markAlertsRead(ME, { all: true })).toEqual({ updated: 1 });
  });
});

describe("preferences on real JSON and a unique index", () => {
  it("stores and reads the event toggles, and a switched-off event creates no alert", async () => {
    await updatePreferences(ME, { events: { PHOTOS_ADDED: false }, departureLeadDays: 3 });
    expect((await getPreferences(ME)).events["PHOTOS_ADDED"]).toBe(false);
    expect((await getPreferences(ME)).events["BOOKING_RECEIVED"]).toBe(true);
    expect((await getPreferences(ME)).departureLeadDays).toBe(3);

    await prisma.$transaction((tx) => emit(tx, { orgId: ORG, event: "PHOTOS_ADDED", title: "t", body: "b", recipientUserIds: [ME.id, OTHER.id] }));
    expect((await prisma.notification.findMany()).map((n) => n.userId)).toEqual([OTHER.id]);
  });

  it("10 parallel first-time saves leave exactly one row, and none fail", async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => updatePreferences(ME, { events: { NEW_STOCK: i % 2 === 0 } })));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await prisma.notificationPreference.count({ where: { userId: ME.id } })).toBe(1);
  });
});

describe("devices", () => {
  it("the same phone registered by two customers in parallel ends as one row with one owner, and no errors", async () => {
    const results = await Promise.allSettled([
      registerCustomerDevice(ME, { expoPushToken: TOKEN, platform: "ios" }),
      registerCustomerDevice(OTHER, { expoPushToken: TOKEN, platform: "ios" }),
      registerCustomerDevice(ME, { expoPushToken: TOKEN, platform: "ios" }),
      registerCustomerDevice(OTHER, { expoPushToken: TOKEN, platform: "ios" }),
    ]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await prisma.deviceToken.count({ where: { expoPushToken: TOKEN } })).toBe(1);
  });

  it("a staff member's device is never taken over", async () => {
    await prisma.deviceToken.create({ data: { org_id: ORG, userId: "staff", expoPushToken: TOKEN, platform: "ios" } });
    await expect(registerCustomerDevice(ME, { expoPushToken: TOKEN, platform: "ios" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await prisma.deviceToken.findFirstOrThrow({ where: { expoPushToken: TOKEN } })).userId).toBe("staff");
  });
});

describe("presence", () => {
  it("writes only when the stored value is older than 60 seconds (real timestamps)", async () => {
    const t0 = new Date("2026-10-27T10:00:00Z");
    await recordHeartbeat(ME, t0);
    await recordHeartbeat(ME, new Date(t0.getTime() + 59_000));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ME.id } })).lastActiveAt).toEqual(t0);
    await recordHeartbeat(ME, new Date(t0.getTime() + 61_000));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ME.id } })).lastActiveAt).toEqual(new Date(t0.getTime() + 61_000));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: OTHER.id } })).lastActiveAt).toBeNull();
  });

  it("never writes a staff row, even with a staff id", async () => {
    await recordHeartbeat({ id: "staff", orgId: ORG });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "staff" } })).lastActiveAt).toBeNull();
  });
});

describe("departure reminders on real SQL", () => {
  const vehicle = (n: number, over = {}) =>
    prisma.vehicle.create({ data: minimalVehicle(ORG, n, { customerId: ME.id, customerVisible: true, etd: day(7), ...over }) });

  it("fires on the chosen day only, once per vehicle per day, for visible export vehicles only", async () => {
    const due = await vehicle(1);
    await vehicle(2, { etd: day(8) });
    await vehicle(3, { customerVisible: false });
    await vehicle(4, { deletedAt: new Date() });
    await vehicle(5, { serialPrefix: "FL" });
    await vehicle(6, { customerId: null });

    const first = await runDailyVehicleChecks(ORG);
    expect(first.errors).toEqual([]);
    expect(first.departureReminders).toBe(1);
    const rows = await prisma.notification.findMany({ where: { event: "DEPARTURE_REMINDER" } });
    expect(rows).toMatchObject([{ userId: ME.id, vehicleId: due.id, title: "Departure reminder" }]);

    expect((await runDailyVehicleChecks(ORG)).departureReminders).toBe(0);
    expect(await prisma.notification.count({ where: { event: "DEPARTURE_REMINDER" } })).toBe(1);
  });

  it("the customer's own lead time decides: a customer who chose 3 days is not reminded at 7", async () => {
    await vehicle(1);
    await prisma.notificationPreference.create({ data: { org_id: ORG, userId: ME.id, departureLeadDays: 3 } });
    expect((await runDailyVehicleChecks(ORG)).departureReminders).toBe(0);
  });

  it("six parallel runs of the job through the advisory lock produce exactly one reminder", async () => {
    await vehicle(1);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => withAdvisoryLock("daily-checks", () => runDailyVehicleChecks(ORG))));
    expect(outcomes.filter((o) => o.acquired).length).toBeGreaterThanOrEqual(1);
    expect(await prisma.notification.count({ where: { event: "DEPARTURE_REMINDER" } })).toBe(1);
  });
});
