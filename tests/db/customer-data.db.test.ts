// The customer read API on real Postgres: the derived status filters, sorting with nulls last, the visibility rules
// as SQL (NOT over a relation, boolean and NULL filters), Decimal money, and the link request flow.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { minimalVehicle } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { createLinkRequest } from "../../src/services/customer-link-request.service.js";
import {
  getCustomerHome,
  getCustomerTimeline,
  getCustomerVehicle,
  getPurchaseHistory,
  listCustomerDocuments,
  listCustomerPhotos,
  listCustomerVehicles,
} from "../../src/services/customer-data.service.js";

const prisma = getTestPrisma();
const ORG = "org_test_a";
const OTHER = "org_test_b";
const ME = { id: "cust_1", orgId: ORG };
const day = (offset: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};
const ids = async (query: Record<string, unknown> = {}, who = ME) => (await listCustomerVehicles(who, query)).rows.map((r) => r.serial);

async function seed() {
  for (const id of [ORG, OTHER]) await prisma.organization.create({ data: { id, name: id } });
  await prisma.user.createMany({
    data: [
      { id: "staff", org_id: ORG, userType: "STAFF", name: "Staff", role: "MANAGER", loginEnabled: true },
      { id: "agent", org_id: ORG, userType: "STAFF", name: "Agent", role: "OPERATOR", loginEnabled: true },
      { id: "cust_1", org_id: ORG, userType: "CUSTOMER", name: "C1", email: "c1@example.test", assignedAgentId: "agent" },
      { id: "cust_2", org_id: ORG, userType: "CUSTOMER", name: "C2", email: "c2@example.test" },
      { id: "cust_b", org_id: OTHER, userType: "CUSTOMER", name: "CB", email: "cb@example.test" },
    ],
  });
  await prisma.brand.createMany({
    data: [
      { id: "br_alpha", org_id: ORG, name: "Alpha Motors" },
      { id: "br_beta", org_id: ORG, name: "Beta Autos" },
    ],
  });
  await prisma.vehicleModelRef.createMany({
    data: [
      { id: "mo_alpha", org_id: ORG, brand_id: "br_alpha", name: "Zeta One" },
      { id: "mo_beta", org_id: ORG, brand_id: "br_beta", name: "Eta Two" },
    ],
  });
  await prisma.rowColourStatus.createMany({
    data: [
      { id: "rc_cancel", org_id: ORG, name: "Unit Canceled", colour: "#ff0000" },
      { id: "rc_other", org_id: ORG, name: "Transport Complete", colour: "#00ff00" },
    ],
  });
}

type V = Parameters<typeof minimalVehicle>[2];
const make = (n: number, over: V = {}) =>
  prisma.vehicle.create({ data: minimalVehicle(ORG, n, { customerId: "cust_1", customerVisible: true, modelId: "mo_alpha", ...over }) });
const milestone = (vehicleId: string, type: "BOUGHT" | "ARRIVED" | "DELIVERED" | "SHIPPED") =>
  prisma.vehicleMilestone.create({ data: { org_id: ORG, vehicleId, type, occurredAt: day(-1) } });

beforeEach(async () => {
  await resetDb(prisma);
  await seed();
  identifierLimiterReset();
});
afterAll(closeTestPrisma);

import { identifierLimiter } from "../../src/lib/identifier-limiter.js";
function identifierLimiterReset() {
  identifierLimiter.reset();
}

describe("who sees which vehicles", () => {
  it("only the customer's own, released, export-track, not-cancelled, not-deleted vehicles", async () => {
    await make(1);
    await make(2, { customerVisible: false });
    await make(3, { serialPrefix: "FL" });
    await make(4, { rowColourStatusId: "rc_cancel" });
    await make(5, { convertedToLocal: true });
    await make(6, { deletedAt: new Date() });
    await make(7, { customerId: "cust_2" });
    await make(8, { serialPrefix: "FL", convertedToExport: true });
    await make(9, { rowColourStatusId: "rc_other" }); // a row colour that is not a cancel colour
    await prisma.vehicle.create({ data: minimalVehicle(OTHER, 1, { customerId: "cust_b", customerVisible: true }) });

    expect((await ids({ sort: "purchaseDate", dir: "asc" })).sort()).toEqual(["FC1", "FC9", "FL8"]);
    expect(await ids({}, { id: "cust_2", orgId: ORG })).toEqual(["FC7"]);
    expect(await ids({}, { id: "cust_b", orgId: OTHER })).toEqual(["FC1"]);
    // a customer id with the wrong org matches nothing
    expect(await ids({}, { id: "cust_1", orgId: OTHER })).toEqual([]);
  });

  it("detail, timeline and photos are 404 for everything outside that set", async () => {
    const mine = await make(1);
    const others = [await make(2, { customerVisible: false }), await make(3, { serialPrefix: "FL" }), await make(4, { rowColourStatusId: "rc_cancel" }), await make(7, { customerId: "cust_2" })];
    expect((await getCustomerVehicle(ME, mine.id)).serial).toBe("FC1");
    for (const v of others) {
      for (const read of [getCustomerVehicle, getCustomerTimeline, listCustomerPhotos]) {
        await expect(read(ME, v.id), `${v.serial} ${read.name}`).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    }
  });
});

describe("status filters (derived, so they are SQL)", () => {
  it("each vehicle falls under exactly one status", async () => {
    await make(1); // PENDING
    await make(2, { shipmentStatus: "BOOKING_RECEIVED", etd: day(10) }); // BOOKING_RECEIVED
    await make(3, { shipmentStatus: "BOOKING_RECEIVED", etd: day(-3) }); // booking whose ETD has passed: effectively SHIPPED
    await make(4, { shipmentStatus: "SHIPPED", etd: day(-30) }); // SHIPPED
    const arrived = await make(5, { shipmentStatus: "SHIPPED", etd: day(-40) });
    await milestone(arrived.id, "ARRIVED"); // ARRIVED
    const delivered = await make(6, { shipmentStatus: "SHIPPED", etd: day(-60) });
    await milestone(delivered.id, "ARRIVED");
    await milestone(delivered.id, "DELIVERED"); // DELIVERED (also has ARRIVED)
    await make(7, { shipmentStatus: "BOOKING_RECEIVED", etd: null }); // BOOKING_RECEIVED without an ETD

    const by = async (status: string) => (await ids({ status, sort: "purchaseDate", dir: "asc" })).sort();
    expect(await by("PENDING")).toEqual(["FC1"]);
    expect(await by("BOOKING_RECEIVED")).toEqual(["FC2", "FC7"]);
    expect(await by("SHIPPED")).toEqual(["FC3", "FC4"]);
    expect(await by("ARRIVED")).toEqual(["FC5"]);
    expect(await by("DELIVERED")).toEqual(["FC6"]);

    const all = (await listCustomerVehicles(ME, {})).rows;
    expect(Object.fromEntries(all.map((r) => [r.serial, r.status]))).toEqual({
      FC1: "PENDING", FC2: "BOOKING_RECEIVED", FC3: "SHIPPED", FC4: "SHIPPED", FC5: "ARRIVED", FC6: "DELIVERED", FC7: "BOOKING_RECEIVED",
    });
    const counts = (await Promise.all(["PENDING", "BOOKING_RECEIVED", "SHIPPED", "ARRIVED", "DELIVERED"].map(by))).flat();
    expect(counts.sort()).toEqual(all.map((r) => r.serial).sort());
  });

  it("a cancelled vehicle is under no status", async () => {
    await make(1, { rowColourStatusId: "rc_cancel", shipmentStatus: "SHIPPED", etd: day(-5) });
    for (const status of ["PENDING", "BOOKING_RECEIVED", "SHIPPED", "ARRIVED", "DELIVERED"]) expect(await ids({ status })).toEqual([]);
  });
});

describe("sorting and paging", () => {
  beforeEach(async () => {
    await make(1, { purchaseDate: day(-30), eta: day(20), customerAmount: 100, customerAmountCurrency: "USD" });
    await make(2, { purchaseDate: day(-10), eta: day(5), customerAmount: 300, customerAmountCurrency: "USD" });
    await make(3, { purchaseDate: null, eta: null, customerAmount: null });
    await make(4, { purchaseDate: day(-20), eta: day(40), customerAmount: 200, customerAmountCurrency: "USD" });
  });

  it.each([
    ["purchaseDate", "asc", ["FC1", "FC4", "FC2", "FC3"]],
    ["purchaseDate", "desc", ["FC2", "FC4", "FC1", "FC3"]],
    ["arrival", "asc", ["FC2", "FC1", "FC4", "FC3"]],
    ["arrival", "desc", ["FC4", "FC1", "FC2", "FC3"]],
    ["price", "asc", ["FC1", "FC4", "FC2", "FC3"]],
    ["price", "desc", ["FC2", "FC4", "FC1", "FC3"]],
  ])("%s %s puts vehicles without a value last", async (sort, dir, expected) => {
    expect(await ids({ sort, dir })).toEqual(expected);
  });

  it("pages are stable, complete and non-overlapping, and the total is the full count", async () => {
    const pages = [await listCustomerVehicles(ME, { pageSize: 3, page: 1, sort: "price", dir: "asc" }), await listCustomerVehicles(ME, { pageSize: 3, page: 2, sort: "price", dir: "asc" })];
    expect(pages.map((p) => p.rows.map((r) => r.serial))).toEqual([["FC1", "FC4", "FC2"], ["FC3"]]);
    expect(pages.map((p) => p.total)).toEqual([4, 4]);
  });

  it("the brand filter ignores case and matches the brand of the model", async () => {
    await make(5, { modelId: "mo_beta" });
    expect(await ids({ brand: "beta AUTOS" })).toEqual(["FC5"]);
    expect((await ids({ brand: "alpha motors" })).sort()).toEqual(["FC1", "FC2", "FC3", "FC4"]);
  });
});

describe("money is exact", () => {
  it("amounts come back as plain numbers and sum per currency without float drift", async () => {
    await make(1, { customerAmount: "0.10", customerAmountCurrency: "USD" } as V);
    await make(2, { customerAmount: "0.20", customerAmountCurrency: "USD" } as V);
    await make(3, { customerAmount: "5000.50", customerAmountCurrency: "EUR" } as V);
    const history = await getPurchaseHistory(ME);
    expect(history.totalSpent).toBeNull();
    expect(history.totalSpentByCurrency).toEqual([{ amount: 5000.5, currency: "EUR" }, { amount: 0.3, currency: "USD" }]);
    const row = (await listCustomerVehicles(ME, {})).rows.find((r) => r.serial === "FC3")!;
    expect(row.amount).toEqual({ amount: 5000.5, currency: "EUR" });
  });

  it("a vehicle with an amount but no currency has no amount", async () => {
    await make(1, { customerAmount: "10.00", customerAmountCurrency: null } as V);
    expect((await listCustomerVehicles(ME, {})).rows[0]!.amount).toBeNull();
  });
});

describe("photos, documents, home", () => {
  it("only released photos and documents of visible vehicles", async () => {
    const v = await make(1);
    const hiddenVehicle = await make(2, { customerVisible: false });
    const photo = (vehicleId: string, visibleToCustomer: boolean) =>
      prisma.vehiclePhoto.create({ data: { vehicleId, url: `https://files.example.test/org/${ORG}/vehicles/${vehicleId}/photos/${Math.random()}.jpg`, uploadedById: "staff", visibleToCustomer } });
    const doc = (vehicleId: string, visibleToCustomer: boolean) =>
      prisma.vehicleDocument.create({ data: { vehicleId, url: `https://files.example.test/org/${ORG}/vehicles/${vehicleId}/documents/${Math.random()}.pdf`, name: "d.pdf", uploadedById: "staff", visibleToCustomer } });
    await photo(v.id, true);
    await photo(v.id, false);
    await photo(hiddenVehicle.id, true);
    await doc(v.id, true);
    await doc(v.id, false);
    await doc(hiddenVehicle.id, true);

    expect(await listCustomerPhotos(ME, v.id)).toHaveLength(1);
    const docs = await listCustomerDocuments(ME, {});
    expect(docs.total).toBe(1);
    expect(docs.rows[0]!.vehicle).toEqual({ id: v.id, serial: "FC1" });
    expect((await listCustomerVehicles(ME, {})).rows.find((r) => r.serial === "FC1")).toMatchObject({ photoCount: 1 });
  });

  it("home counts and the next departure", async () => {
    await make(1, { purchaseDate: day(-3) });
    await make(2, { shipmentStatus: "BOOKING_RECEIVED", etd: day(9), purchaseDate: day(-2) });
    await make(3, { shipmentStatus: "BOOKING_RECEIVED", etd: day(4), purchaseDate: day(-1) });
    const done = await make(4, { shipmentStatus: "SHIPPED", etd: day(-50) });
    await milestone(done.id, "DELIVERED");
    const home = await getCustomerHome(ME);
    expect(home).toMatchObject({ name: "C1", activeCount: 3, deliveredCount: 1 });
    expect(home.nextDeparture?.serial).toBe("FC3");
    expect(home.recentVehicles.map((r) => r.serial)).toEqual(["FC3", "FC2", "FC1"]);
  });
});

describe("link requests on real SQL", () => {
  it("creates one pending request, ignores a repeat, notifies the right staff, and never reads the vehicle", async () => {
    await make(1);
    await createLinkRequest(ME, { serial: "fc1" });
    await createLinkRequest(ME, { serial: "FC1" });
    await createLinkRequest(ME, { serial: "FC777777" });

    const requests = await prisma.vehicleLinkRequest.findMany({ orderBy: { serialEntered: "asc" } });
    expect(requests.map((r) => [r.serialEntered, r.status, r.customerId, r.org_id, r.vehicleId])).toEqual([
      ["FC1", "PENDING", "cust_1", ORG, null],
      ["FC777777", "PENDING", "cust_1", ORG, null],
    ]);
    const notified = await prisma.notification.findMany({ where: { event: "VEHICLE_LINK_REQUESTED" } });
    expect([...new Set(notified.map((n) => n.userId))].sort()).toEqual(["agent", "staff"]);
    expect(notified).toHaveLength(4);
    expect(await prisma.activityLog.count({ where: { action: "CREATE_LINK_REQUEST", actorId: "cust_1" } })).toBe(2);
  });

  it("two parallel identical requests leave one pending row at most... or two, never more (no unique key is claimed)", async () => {
    const results = await Promise.allSettled([createLinkRequest(ME, { serial: "FC5" }), createLinkRequest(ME, { serial: "FC5" })]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.vehicleLinkRequest.count()).toBeLessThanOrEqual(2);
  });
});
