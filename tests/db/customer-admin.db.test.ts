// Staff tools for customers on real Postgres: session revocation, claim races on link requests, the arrival
// reminder query and the all-or-nothing bulk photo release. Fake data only.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { minimalVehicle } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { listActiveCustomers, setCustomerLoginAccess } from "../../src/services/customer-admin.service.js";
import { approveLinkRequest, rejectLinkRequest } from "../../src/services/link-request-admin.service.js";
import { runDailyVehicleChecks } from "../../src/services/reminder.service.js";
import { setPhotosRelease } from "../../src/services/vehicle-release.service.js";

const prisma = getTestPrisma();
const ORG = "org_test_a";
const actor = { id: "staff", orgId: ORG, role: "MANAGER" as const, name: "Staff", email: null };
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
      { id: "cust_1", org_id: ORG, userType: "CUSTOMER", name: "C1", email: "c1@example.test", loginEnabled: true },
      { id: "cust_2", org_id: ORG, userType: "CUSTOMER", name: "C2", email: "c2@example.test", loginEnabled: true },
    ],
  });
});
afterAll(closeTestPrisma);

const session = (id: string, userId: string) =>
  prisma.customerSession.create({ data: { id, org_id: ORG, userId, tokenHash: `hash_${id}`, expiresAt: new Date(Date.now() + 86_400_000) } });

describe("disabling customer sign-in", () => {
  it("revokes every live session and device token of that customer only, and writes the log", async () => {
    await session("s1", "cust_1");
    await session("s2", "cust_1");
    await session("s3", "cust_2");
    await prisma.deviceToken.createMany({
      data: [
        { id: "d1", org_id: ORG, userId: "cust_1", expoPushToken: "ExponentPushToken[one]", platform: "ios" },
        { id: "d2", org_id: ORG, userId: "cust_2", expoPushToken: "ExponentPushToken[two]", platform: "ios" },
      ],
    });

    await setCustomerLoginAccess(actor, "cust_1", { loginEnabled: false });

    const sessions = await prisma.customerSession.findMany({ orderBy: { id: "asc" } });
    expect(sessions.map((s) => [s.id, s.revokedAt !== null])).toEqual([["s1", true], ["s2", true], ["s3", false]]);
    expect((await prisma.deviceToken.findMany()).map((d) => d.userId)).toEqual(["cust_2"]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "cust_1" } })).loginEnabled).toBe(false);
    expect(await prisma.activityLog.count({ where: { action: "DISABLE_CUSTOMER_LOGIN", entityId: "cust_1" } })).toBe(1);
  });
});

describe("link request decisions race", () => {
  const vehicle = (n: number, over = {}) => prisma.vehicle.create({ data: minimalVehicle(ORG, n, over) });
  const request = (id: string, customerId: string, serial: string) =>
    prisma.vehicleLinkRequest.create({ data: { id, org_id: ORG, customerId, serialEntered: serial } });

  it("two customers asking for the same vehicle, approved in parallel, 15 rounds: exactly one gets each vehicle, the other is refused", async () => {
    for (let round = 0; round < 15; round++) {
      const v = await vehicle(100 + round);
      await request(`r1_${round}`, "cust_1", v.serial);
      await request(`r2_${round}`, "cust_2", v.serial);
      const results = await Promise.allSettled([approveLinkRequest(actor, `r1_${round}`, {}), approveLinkRequest(actor, `r2_${round}`, {})]);
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason, `round ${round}`).toMatchObject({ code: "CONFLICT" });
      const owner = (await prisma.vehicle.findUniqueOrThrow({ where: { id: v.id } })).customerId;
      const winner = results[0]!.status === "fulfilled" ? "cust_1" : "cust_2";
      expect(owner, `round ${round}`).toBe(winner);
    }
    expect(await prisma.vehicleLinkRequest.count({ where: { status: "APPROVED" } })).toBe(15);
    expect(await prisma.notification.count({ where: { event: "LINK_REQUEST_APPROVED" } })).toBe(15);
    expect(await prisma.activityLog.count({ where: { action: "APPROVE_LINK_REQUEST" } })).toBe(15);
  });

  it("approve and reject of the same request in parallel, 15 rounds: exactly one decision and one notification each", async () => {
    for (let round = 0; round < 15; round++) {
      const v = await vehicle(200 + round);
      const id = `rd_${round}`;
      await request(id, "cust_1", v.serial);
      const results = await Promise.allSettled([
        approveLinkRequest(actor, id, {}),
        rejectLinkRequest(actor, id, {}),
        approveLinkRequest(actor, id, {}),
        rejectLinkRequest(actor, id, {}),
        approveLinkRequest(actor, id, {}),
        rejectLinkRequest(actor, id, {}),
      ]);
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      const row = await prisma.vehicleLinkRequest.findUniqueOrThrow({ where: { id } });
      const linked = (await prisma.vehicle.findUniqueOrThrow({ where: { id: v.id } })).customerId;
      expect(linked === "cust_1", `round ${round}`).toBe(row.status === "APPROVED");
    }
    expect(await prisma.notification.count()).toBe(15);
  });
});

describe("bulk photo release is all or nothing", () => {
  it("one id from another vehicle changes nothing, in SQL", async () => {
    const a = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1, { customerId: "cust_1" }) });
    const b = await prisma.vehicle.create({ data: minimalVehicle(ORG, 2) });
    const mk = (id: string, vehicleId: string) =>
      prisma.vehiclePhoto.create({ data: { id, vehicleId, url: `https://files.example.test/${id}.jpg`, uploadedById: "staff" } });
    await mk("p1", a.id);
    await mk("p2", a.id);
    await mk("p3", b.id);
    expect((await prisma.vehiclePhoto.findUniqueOrThrow({ where: { id: "p1" } })).visibleToCustomer).toBe(false);
    await expect(setPhotosRelease(actor, a.id, { visibleToCustomer: true, photoIds: ["p1", "p3"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.vehiclePhoto.count({ where: { visibleToCustomer: true } })).toBe(0);
    await setPhotosRelease(actor, a.id, { visibleToCustomer: true, photoIds: ["p1", "p2"] });
    expect(await prisma.vehiclePhoto.count({ where: { visibleToCustomer: true } })).toBe(2);
  });
});

describe("who is online", () => {
  it("uses the 5 minute window on real timestamps", async () => {
    await prisma.user.update({ where: { id: "cust_1" }, data: { lastActiveAt: new Date(Date.now() - 4 * 60_000) } });
    await prisma.user.update({ where: { id: "cust_2" }, data: { lastActiveAt: new Date(Date.now() - 6 * 60_000) } });
    expect((await listActiveCustomers(ORG)).map((c) => c.id)).toEqual(["cust_1"]);
  });
});

describe("arrival reminder on real SQL", () => {
  const ship = async (n: number, daysAgo: number, over = {}) => {
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, n, over) });
    await prisma.vehicleMilestone.create({ data: { org_id: ORG, vehicleId: v.id, type: "SHIPPED", occurredAt: day(-daysAgo) } });
    return v;
  };

  it("fires on day 45 and every 7th day after, once per day, and skips arrived, delivered and deleted vehicles", async () => {
    await prisma.user.create({ data: { id: "mgr", org_id: ORG, userType: "STAFF", name: "M", role: "ADMINISTRATOR", loginEnabled: true } });
    const due = await ship(1, 45);
    const arrived = await ship(2, 45);
    await prisma.vehicleMilestone.create({ data: { org_id: ORG, vehicleId: arrived.id, type: "ARRIVED", occurredAt: day(-1) } });
    const delivered = await ship(3, 52);
    await prisma.vehicleMilestone.create({ data: { org_id: ORG, vehicleId: delivered.id, type: "DELIVERED", occurredAt: day(-1) } });
    await ship(4, 45, { deletedAt: new Date() });
    await ship(5, 46);
    const weekly = await ship(6, 52);

    const first = await runDailyVehicleChecks(ORG);
    expect(first.errors).toEqual([]);
    expect(first.arrivalReminders).toBe(2);
    const sent = await prisma.notification.findMany({ where: { event: "ARRIVAL_NOT_RECORDED" } });
    expect([...new Set(sent.map((n) => n.vehicleId))].sort()).toEqual([due.id, weekly.id].sort());
    const again = await runDailyVehicleChecks(ORG);
    expect(again.arrivalReminders).toBe(0);
    expect(await prisma.notification.count({ where: { event: "ARRIVAL_NOT_RECORDED" } })).toBe(sent.length);
  });
});
