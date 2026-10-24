// The vehicle read paths and the dashboard, against real Postgres. The unit tests prove the
// logic with a fake database; these prove the SQL Prisma actually generates does the same,
// including NULL handling, relation filters, relation ordering and the DISTINCT queries.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { ORG_A, ORG_B, minimalVehicle, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { getDashboardStats } from "../../src/services/dashboard.service.js";
import {
  getVehicleDetail,
  listDistinctDestinations,
  listVehicles,
  listVehicleStatusHistory,
  type VehicleListParams,
} from "../../src/services/vehicle.service.js";

const prisma = getTestPrisma();

const DEFAULTS: VehicleListParams = {
  page: 1, pageSize: 50, track: "ALL", search: "", shipmentStatus: [], destination: "ALL", partnerName: "ALL",
  customerId: "ALL", rowColourStatusId: "ALL", rowColourStatusIdNot: "ALL", brandId: "ALL", modelId: "ALL",
  gradeId: "ALL", auctionHallId: "ALL", supplierId: "ALL", freightAgentId: "ALL", packingAgentId: "ALL",
  vehicleLocationId: "ALL", transportById: "ALL", shippingMethod: "ALL", auctionBillPaid: "ALL", logBook: "ALL",
  extraKey: "ALL", hasPartnership: "ALL", paidByCustomer: "ALL", sellingPriceCurrency: "ALL",
  convertedToExport: "ALL", convertedToLocal: "ALL", etdFrom: null, etdTo: null, etaFrom: null, etaTo: null,
  sortBy: "serial", sortDir: "asc",
};
const serials = async (over: Partial<VehicleListParams> = {}, orgId = ORG_A) =>
  (await listVehicles(orgId, { ...DEFAULTS, ...over })).rows.map((r) => r.serial);

const day = (offset: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};

let cancelColour: string;
let resoldColour: string;
let otherColour: string;
let completeColour: string;
let transportX: string;
let customer1: string;

beforeEach(async () => {
  await resetDb(prisma);
  await seedTwoOrgs(prisma);

  const brandA = await prisma.brand.create({ data: { org_id: ORG_A, name: "Alpha Motors" } });
  const brandB = await prisma.brand.create({ data: { org_id: ORG_A, name: "Beta Autos" } });
  const brandOther = await prisma.brand.create({ data: { org_id: ORG_B, name: "Gamma Cars" } });
  const modelA = await prisma.vehicleModelRef.create({ data: { org_id: ORG_A, brand_id: brandA.id, name: "Zeta One" } });
  const modelB = await prisma.vehicleModelRef.create({ data: { org_id: ORG_A, brand_id: brandB.id, name: "Eta Two" } });
  const modelOther = await prisma.vehicleModelRef.create({ data: { org_id: ORG_B, brand_id: brandOther.id, name: "Theta Three" } });
  customer1 = (await prisma.user.create({ data: { org_id: ORG_A, userType: "CUSTOMER", name: "Iota Buyer" } })).id;
  const staff = await prisma.user.create({ data: { org_id: ORG_A, userType: "STAFF", role: "MANAGER", name: "Staff Actor A" } });
  transportX = (await prisma.transportCompany.create({ data: { org_id: ORG_A, name: "Transport X" } })).id;

  cancelColour = (await prisma.rowColourStatus.create({ data: { org_id: ORG_A, name: "Unit Canceled", colour: "#f00" } })).id;
  resoldColour = (await prisma.rowColourStatus.create({ data: { org_id: ORG_A, name: "Resold in Auction", colour: "#f80" } })).id;
  otherColour = (await prisma.rowColourStatus.create({ data: { org_id: ORG_A, name: "Some Other Colour", colour: "#0f0" } })).id;
  completeColour = (
    await prisma.rowColourStatus.create({ data: { org_id: ORG_A, name: "Transport Complete", colour: "#00f", transportCellOnly: true } })
  ).id;

  await prisma.vehicle.createMany({
    data: [
      // Stored status x row colour, mostly with NO colour (NULL): the common real-world case.
      minimalVehicle(ORG_A, 1, { shipmentStatus: "PENDING", modelId: modelA.id, customerId: customer1, destination: "Country One", purchaseDate: day(-30), auctionBillPaid: null }),
      minimalVehicle(ORG_A, 2, { shipmentStatus: "BOOKING_RECEIVED", etd: day(10), modelId: modelB.id, destination: "Country Two", purchaseDate: day(-20), auctionBillPaid: true }),
      minimalVehicle(ORG_A, 3, { shipmentStatus: "BOOKING_RECEIVED", etd: day(-5), modelId: modelA.id, destination: "Country One", auctionBillPaid: false }),
      minimalVehicle(ORG_A, 4, { shipmentStatus: "SHIPPED", etd: day(-40), modelId: modelA.id, rowColourStatusId: otherColour }),
      minimalVehicle(ORG_A, 5, { shipmentStatus: "BOOKING_RECEIVED", etd: day(10), modelId: modelA.id, rowColourStatusId: cancelColour }),
      minimalVehicle(ORG_A, 6, { shipmentStatus: "PENDING", modelId: modelA.id, rowColourStatusId: resoldColour }), // cancelled, stored PENDING
      minimalVehicle(ORG_A, 7, { shipmentStatus: "SHIPPED", etd: day(-30), modelId: modelA.id, rowColourStatusId: cancelColour }), // cancelled, stored SHIPPED
      minimalVehicle(ORG_A, 8, { modelId: modelA.id, destination: "Deleted Place", deletedAt: new Date() }),
      // FL native with a cancelling colour: NOT cancelled (cancellation is FC only).
      minimalVehicle(ORG_A, 9, { serialPrefix: "FL", modelId: modelB.id, rowColourStatusId: cancelColour, hasPartnership: true, partnerName: "Partner One", destination: "Local Town" }),
      // FL converted to export behaves as FC.
      minimalVehicle(ORG_A, 10, { serialPrefix: "FL", convertedToExport: true, shipmentStatus: "BOOKING_RECEIVED", etd: day(7), modelId: modelA.id }),
      // Transport tallies (dashboard): complete / no colour / other colour, all with transport company X.
      minimalVehicle(ORG_A, 11, { transportById: transportX, rowColourStatusId: completeColour }),
      minimalVehicle(ORG_A, 12, { transportById: transportX }),
      minimalVehicle(ORG_A, 13, { transportById: transportX, rowColourStatusId: otherColour }),
      // Other org, same serial as org A's FC1.
      minimalVehicle(ORG_B, 1, { modelId: modelOther.id, destination: "Org B Country", partnerName: "Org B Partner" }),
      minimalVehicle(ORG_B, 900, { modelId: modelOther.id }),
    ],
  });

  const v2 = await prisma.vehicle.findFirstOrThrow({ where: { org_id: ORG_A, serial: "FC2" } });
  await prisma.statusHistory.createMany({
    data: [
      { vehicleId: v2.id, toStatus: "PENDING", trigger: "LEGACY_ENTRY", triggeredBy: staff.id, createdAt: new Date(2026, 0, 1) },
      { vehicleId: v2.id, fromStatus: "PENDING", toStatus: "BOOKING_RECEIVED", trigger: "ETD_SAVED", triggeredBy: staff.id, createdAt: new Date(2026, 0, 2) },
      { vehicleId: v2.id, fromStatus: "BOOKING_RECEIVED", toStatus: "PENDING", trigger: "ETD_CLEARED", triggeredBy: null, createdAt: new Date(2026, 0, 3) },
      { vehicleId: v2.id, fromStatus: "PENDING", toStatus: "BOOKING_RECEIVED", trigger: "ETD_SAVED", triggeredBy: staff.id, createdAt: new Date(2026, 0, 4) },
    ],
  });
});
afterAll(closeTestPrisma);

describe("scoping and soft delete", () => {
  it("returns only the caller's org and never deleted vehicles", async () => {
    const all = await serials();
    expect(all).toEqual(["FC1", "FC2", "FC3", "FC4", "FC5", "FC6", "FC7", "FL9", "FL10", "FC11", "FC12", "FC13"].sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""))));
    expect(all).not.toContain("FC8");
    expect(await serials({}, ORG_B)).toEqual(["FC1", "FC900"]);
  });

  it("the same serial resolves per org", async () => {
    const a = await getVehicleDetail(ORG_A, "FC1");
    const b = await getVehicleDetail(ORG_B, "FC1");
    expect(a?.id).not.toBe(b?.id);
    expect(await getVehicleDetail(ORG_A, "FC900")).toBeNull();
    expect(await getVehicleDetail(ORG_A, "FC8")).toBeNull(); // soft-deleted
  });

  it("a filter id from another org matches nothing", async () => {
    const foreign = await prisma.brand.findFirstOrThrow({ where: { org_id: ORG_B } });
    expect(await serials({ brandId: foreign.id })).toEqual([]);
  });
});

describe("effective shipment status filters (NOT over a relation filter, with NULL row colours)", () => {
  const fc = (shipmentStatus: VehicleListParams["shipmentStatus"]) => serials({ track: "FC", shipmentStatus });

  it("PENDING includes pending vehicles with NO row colour and excludes cancelled ones", async () => {
    expect(await fc(["PENDING"])).toEqual(["FC1", "FC11", "FC12", "FC13"]); // FC6 is stored PENDING but cancelled
  });
  it("BOOKING_RECEIVED means not yet past its ETD, includes no-colour vehicles, excludes cancelled", async () => {
    expect(await fc(["BOOKING_RECEIVED"])).toEqual(["FC2", "FL10"]);
  });
  it("SHIPPED includes stored SHIPPED and BOOKING_RECEIVED whose ETD passed, excludes cancelled", async () => {
    expect(await fc(["SHIPPED"])).toEqual(["FC3", "FC4"]);
  });
  it("CANCELLED is FC only, so the FL vehicle with a cancelling colour is not cancelled", async () => {
    expect(await fc(["CANCELLED"])).toEqual(["FC5", "FC6", "FC7"]);
    expect(await serials({ track: "ALL", shipmentStatus: ["CANCELLED"] })).toEqual(["FC5", "FC6", "FC7"]);
  });
  it("several statuses are OR-ed", async () => {
    expect(await fc(["PENDING", "SHIPPED"])).toEqual(["FC1", "FC3", "FC4", "FC11", "FC12", "FC13"]);
  });
  it("the filter agrees with the effective status shown on every row", async () => {
    const { rows } = await listVehicles(ORG_A, { ...DEFAULTS, track: "FC" });
    for (const status of ["PENDING", "BOOKING_RECEIVED", "SHIPPED", "CANCELLED"] as const) {
      expect(await fc([status])).toEqual(rows.filter((r) => r.effectiveShipmentStatus === status).map((r) => r.serial));
    }
  });
});

describe("row colour filters", () => {
  it("equals filters to that colour", async () => {
    expect(await serials({ rowColourStatusId: cancelColour })).toEqual(["FC5", "FC7", "FL9"]);
  });

  it("'everything except X' INCLUDES vehicles with no colour (regression: a plain not drops NULL rows)", async () => {
    const result = await serials({ rowColourStatusIdNot: completeColour });
    expect(result).not.toContain("FC11"); // the one with the excluded colour
    expect(result).toContain("FC12"); // no colour at all
    expect(result).toContain("FC1"); // no colour at all
    expect(result).toContain("FC13"); // a different colour
    expect(result).toHaveLength(11); // every live vehicle but FC11
  });
});

describe("dashboard agrees with the list it links to", () => {
  it("each transport company's In Progress count equals the list behind its bar", async () => {
    const stats = await getDashboardStats(ORG_A);
    const x = stats.transportByCompany.find((c) => c.id === transportX)!;
    expect(x).toMatchObject({ complete: 1, inProgress: 2 }); // FC11 complete; FC12 (no colour) and FC13 in progress
    expect(stats.transportCompleteStatusId).toBe(completeColour);

    const inProgress = await listVehicles(ORG_A, {
      ...DEFAULTS,
      transportById: transportX,
      rowColourStatusIdNot: stats.transportCompleteStatusId!,
    });
    expect(inProgress.total).toBe(x.inProgress);
    expect(inProgress.rows.map((r) => r.serial).sort()).toEqual(["FC12", "FC13"]);

    const complete = await listVehicles(ORG_A, { ...DEFAULTS, transportById: transportX, rowColourStatusId: completeColour });
    expect(complete.total).toBe(x.complete);
  });

  it("the unpaid-bills KPI keeps vehicles that have no row colour, and drops cancelled ones", async () => {
    const stats = await getDashboardStats(ORG_A);
    const unpaid = stats.unpaidAuctionBills.map((v) => v.serial);
    expect(unpaid).toContain("FC1"); // null bill status, no colour
    expect(unpaid).toContain("FC3"); // false, no colour
    expect(unpaid).not.toContain("FC2"); // paid
    expect(unpaid).not.toContain("FC5"); // cancelled
    expect(unpaid).not.toContain("FC7"); // cancelled
    expect(unpaid).not.toContain("FC8"); // deleted
  });

  it("totals and the FC/FL split count only this org's live vehicles", async () => {
    const stats = await getDashboardStats(ORG_A);
    expect(stats.totalVehicles).toBe(12);
    expect(stats.trackSplit).toEqual({ fc: 11, fl: 1 }); // FL10 (converted) counts as FC
  });
});

describe("search, sort and tri-state against real SQL", () => {
  it("search matches across related tables, case-insensitively", async () => {
    expect(await serials({ search: "ALPHA MOTORS" })).toEqual(["FC1", "FC3", "FC4", "FC5", "FC6", "FC7", "FL10"].sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""))));
    expect(await serials({ search: "iota" })).toEqual(["FC1"]);
    expect(await serials({ search: "partner one" })).toEqual(["FL9"]);
    expect(await serials({ search: "Org B Partner" })).toEqual([]); // other org's data
  });

  it("sorts serial numerically and by a related column", async () => {
    const asc = await serials({ sortBy: "serial", sortDir: "asc" });
    expect(asc.slice(0, 3)).toEqual(["FC1", "FC2", "FC3"]);
    expect((await serials({ sortBy: "serial", sortDir: "desc" }))[0]).toBe("FC13");
    const byModel = await serials({ sortBy: "model", sortDir: "asc" });
    expect(byModel.slice(0, 2).sort()).toEqual(["FC2", "FL9"]); // model "Eta Two" sorts first
  });

  it("puts NULLs first when sorting descending and last ascending (PostgreSQL default)", async () => {
    const desc = await serials({ track: "FC", shipmentStatus: [], sortBy: "purchaseDate", sortDir: "desc" });
    const asc = await serials({ track: "FC", sortBy: "purchaseDate", sortDir: "asc" });
    // FC1 (-30) and FC2 (-20) are the only dated FC vehicles: ascending, FC1 then FC2 come before every NULL.
    expect(asc.slice(0, 2)).toEqual(["FC1", "FC2"]);
    // descending: every NULL comes before the dated ones, which end the list as FC2 then FC1.
    expect(desc.slice(-2)).toEqual(["FC2", "FC1"]);
  });

  it("orders by effective status and pages in memory", async () => {
    const all = await serials({ track: "FC", sortBy: "shipmentStatus", sortDir: "asc" });
    const rows = (await listVehicles(ORG_A, { ...DEFAULTS, track: "FC", sortBy: "shipmentStatus", sortDir: "asc" })).rows;
    const order = ["PENDING", "BOOKING_RECEIVED", "SHIPPED", "CANCELLED"];
    const ranks = rows.map((r) => order.indexOf(r.effectiveShipmentStatus));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const page2 = await listVehicles(ORG_A, { ...DEFAULTS, track: "FC", sortBy: "shipmentStatus", sortDir: "asc", page: 2, pageSize: 3 });
    expect(page2.rows.map((r) => r.serial)).toEqual(all.slice(3, 6));
    expect(page2.total).toBe(all.length);
  });

  it("tri-state filters keep NULL ('not entered') distinct from false", async () => {
    expect(await serials({ auctionBillPaid: "YES" })).toEqual(["FC2"]);
    expect(await serials({ auctionBillPaid: "NO" })).toEqual(["FC3"]);
    const blank = await serials({ auctionBillPaid: "BLANK" });
    expect(blank).toContain("FC1");
    expect(blank).not.toContain("FC2");
    expect(blank).not.toContain("FC3");
  });

  it("etd range is inclusive", async () => {
    expect(await serials({ etdFrom: day(5), etdTo: day(12) })).toEqual(["FC2", "FC5", "FL10"]);
  });
});

describe("distinct lookups and status history", () => {
  it("destinations: distinct, non-null, sorted, org-scoped, no deleted vehicles", async () => {
    expect(await listDistinctDestinations(ORG_A)).toEqual(["Country One", "Country Two", "Local Town"]);
    expect(await listDistinctDestinations(ORG_B)).toEqual(["Org B Country"]);
    expect(await listDistinctDestinations(ORG_A, "FL")).toEqual(["Local Town"]);
  });

  it("status history is oldest first, and unreachable through another org or a deleted vehicle", async () => {
    const v2 = await prisma.vehicle.findFirstOrThrow({ where: { org_id: ORG_A, serial: "FC2" } });
    const history = await listVehicleStatusHistory(ORG_A, v2.id);
    expect(history.map((h) => h.triggerLabel)).toEqual(["Entered manually (legacy)", "ETD saved", "ETD cleared", "ETD saved"]);
    expect(history[0]?.triggeredByName).toBe("Staff Actor A");
    expect(history[2]?.triggeredByName).toBeNull();
    expect(await listVehicleStatusHistory(ORG_B, v2.id)).toEqual([]);

    await prisma.vehicle.update({ where: { id: v2.id }, data: { deletedAt: new Date() } });
    expect(await listVehicleStatusHistory(ORG_A, v2.id)).toEqual([]);
  });

  it("booking-received date comes from the latest ETD_SAVED row", async () => {
    expect((await getVehicleDetail(ORG_A, "FC2"))?.bookingReceivedAt).toEqual(new Date(2026, 0, 4));
  });
});
