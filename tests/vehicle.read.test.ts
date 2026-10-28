import { beforeEach, describe, expect, it, vi } from "vitest";
import { mentionsOrg, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { dayOffset, newVehicleFake } from "./helpers/vehicle-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import {
  getVehicleDetail,
  getVehicleFilterOptions,
  listDistinctDestinations,
  listDistinctPartnerNames,
  listVehicles,
  listVehicleStatusHistory,
  resolveVehicleIdBySerial,
  type VehicleListParams,
} from "../src/services/vehicle.service.js";

let fake: FakePrisma;

beforeEach(() => {
  fake = newVehicleFake();
  state.fake = fake;
});

const DEFAULTS: VehicleListParams = {
  page: 1, pageSize: 50, track: "ALL", search: "", shipmentStatus: [], destination: "ALL", partnerName: "ALL",
  customerId: "ALL", rowColourStatusId: "ALL", rowColourStatusIdNot: "ALL", brandId: "ALL", modelId: "ALL",
  gradeId: "ALL", auctionHallId: "ALL", supplierId: "ALL", freightAgentId: "ALL", packingAgentId: "ALL",
  vehicleLocationId: "ALL", transportById: "ALL", shippingMethod: "ALL", auctionBillPaid: "ALL", logBook: "ALL",
  extraKey: "ALL", hasPartnership: "ALL", paidByCustomer: "ALL", sellingPriceCurrency: "ALL",
  convertedToExport: "ALL", convertedToLocal: "ALL", etdFrom: null, etdTo: null, etaFrom: null, etaTo: null,
  sortBy: "serial", sortDir: "asc",
};

const list = (over: Partial<VehicleListParams> = {}, orgId = ORG_A) => listVehicles(orgId, { ...DEFAULTS, ...over });
const serials = async (over: Partial<VehicleListParams> = {}, orgId = ORG_A) =>
  (await list(over, orgId)).rows.map((r) => r.serial);

describe("getVehicleDetail", () => {
  it("returns the vehicle for its own org, with brand resolved through the model", async () => {
    const v = await getVehicleDetail(ORG_A, "FC101");
    expect(v).toMatchObject({
      id: "v_fc_pending", serial: "FC101", track: "FC",
      brand: { id: "brand_a1", name: "Alpha Motors" }, model: { id: "model_a1", name: "Zeta One" },
      customer: { id: "cust_a1", name: "Iota Buyer" },
    });
  });

  it("is looked up per org: the same serial in two orgs resolves to each org's own vehicle", async () => {
    expect((await getVehicleDetail(ORG_A, "FC101"))?.id).toBe("v_fc_pending");
    expect((await getVehicleDetail(ORG_B, "FC101"))?.id).toBe("v_b_fc");
  });

  it("returns null for another org's serial, an unknown serial, and a soft-deleted vehicle", async () => {
    expect(await getVehicleDetail(ORG_A, "FC900")).toBeNull();
    expect(await getVehicleDetail(ORG_A, "FC999")).toBeNull();
    expect(await getVehicleDetail(ORG_A, "FC106")).toBeNull();
  });

  it("uses the effective track, not the serial prefix", async () => {
    expect(await getVehicleDetail(ORG_A, "FL202")).toMatchObject({ track: "FC", convertedToExport: true });
    expect(await getVehicleDetail(ORG_A, "FC107")).toMatchObject({ track: "FL", convertedToLocal: true });
    expect(await getVehicleDetail(ORG_A, "FL201")).toMatchObject({ track: "FL" });
  });

  it("computes the effective shipment status on read", async () => {
    expect((await getVehicleDetail(ORG_A, "FC101"))?.shipmentStatus).toBe("PENDING");
    expect((await getVehicleDetail(ORG_A, "FC102"))?.shipmentStatus).toBe("BOOKING_RECEIVED");
    expect((await getVehicleDetail(ORG_A, "FC103"))?.shipmentStatus).toBe("SHIPPED"); // stored BOOKING_RECEIVED, ETD passed
    expect((await getVehicleDetail(ORG_A, "FC105"))?.shipmentStatus).toBe("CANCELLED");
  });

  it("only cancels FC: an FL vehicle with a cancelling row colour is not CANCELLED", async () => {
    const fl = await getVehicleDetail(ORG_A, "FL201");
    expect(fl?.rowColourStatus?.name).toBe("Unit Canceled");
    expect(fl?.shipmentStatus).toBe("PENDING");
  });

  it("preserves tri-state flags: null stays null, false stays false", async () => {
    expect((await getVehicleDetail(ORG_A, "FC101"))?.auctionBillPaid).toBeNull();
    expect((await getVehicleDetail(ORG_A, "FC103"))?.auctionBillPaid).toBe(false);
    expect((await getVehicleDetail(ORG_A, "FC102"))?.auctionBillPaid).toBe(true);
    expect((await getVehicleDetail(ORG_A, "FC101"))?.logBook).toBeNull();
  });

  it("hands money back as a plain number", async () => {
    expect((await getVehicleDetail(ORG_A, "FL201"))?.sellingPrice).toBe(12345);
    expect((await getVehicleDetail(ORG_A, "FC101"))?.sellingPrice).toBeNull();
  });

  it("dates Booking Received from the latest ETD_SAVED history row, ignoring legacy entries", async () => {
    const v = await getVehicleDetail(ORG_A, "FC102");
    expect(v?.bookingReceivedAt).toEqual(new Date(2026, 0, 4));
    expect((await getVehicleDetail(ORG_A, "FC101"))?.bookingReceivedAt).toBeNull(); // no ETD, no lookup
  });

  it("every vehicle query includes org_id", async () => {
    await getVehicleDetail(ORG_A, "FC102");
    const calls = fake.calls.filter((c) => c.model === "vehicle");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => mentionsOrg(c.args, ORG_A))).toBe(true);
  });
});

describe("resolveVehicleIdBySerial", () => {
  it("returns the id for the caller's org", async () => {
    expect(await resolveVehicleIdBySerial(ORG_A, "FC102")).toBe("v_fc_booked_future");
  });
  it("is NOT_FOUND for another org's, an unknown, or a deleted vehicle", async () => {
    for (const serial of ["FC900", "FC999", "FC106"]) {
      await expect(resolveVehicleIdBySerial(ORG_A, serial)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
});

describe("listVehicleStatusHistory", () => {
  it("returns the vehicle's history oldest first with readable labels and actor names", async () => {
    const history = await listVehicleStatusHistory(ORG_A, "v_fc_booked_future");
    expect(history.map((h) => h.id)).toEqual(["sh1", "sh2", "sh3", "sh4", "sh5"]);
    expect(history.map((h) => h.triggerLabel)).toEqual([
      "Entered manually (legacy)", "ETD saved", "ETD cleared", "ETD saved", "Automatic — daily job",
    ]);
    expect(history[1]?.triggeredByName).toBe("Staff Actor A");
    expect(history[4]?.triggeredByName).toBeNull(); // system
  });

  it("does not resolve an actor from another org (name stays null)", async () => {
    const history = await listVehicleStatusHistory(ORG_A, "v_fc_booked_future");
    expect(history.find((h) => h.id === "sh3")?.triggeredByName).toBeNull();
  });

  it("returns nothing for another org's vehicle id", async () => {
    expect(await listVehicleStatusHistory(ORG_A, "v_b_fc")).toEqual([]);
    expect(await listVehicleStatusHistory(ORG_B, "v_fc_booked_future")).toEqual([]);
  });

  it("returns nothing for a soft-deleted vehicle", async () => {
    fake.seed("statusHistory", { id: "sh_del", vehicleId: "v_fc_deleted", fromStatus: null, toStatus: "PENDING", trigger: "ETD_SAVED", triggeredBy: null, createdAt: new Date() });
    expect(await listVehicleStatusHistory(ORG_A, "v_fc_deleted")).toEqual([]);
  });

  it("returns an empty list for a vehicle with no history (e.g. FL)", async () => {
    expect(await listVehicleStatusHistory(ORG_A, "v_fl_native")).toEqual([]);
  });
});

describe("listVehicles: scoping and soft delete", () => {
  it("returns only the caller's org and never soft-deleted vehicles", async () => {
    const s = await serials();
    expect(s).toEqual(["FC101", "FC102", "FC103", "FC104", "FC105", "FC107", "FC108", "FC109", "FL201", "FL202"]);
    expect(s).not.toContain("FC106");
    expect(await serials({}, ORG_B)).toEqual(["FC101", "FC900"]);
    expect((await list({}, ORG_B)).rows.map((r) => r.id)).toEqual(["v_b_fc", "v_b_other"]);
  });

  it("every query includes org_id and excludes deleted rows", async () => {
    await list({ search: "chassis", shipmentStatus: ["SHIPPED"], track: "FC" });
    const calls = fake.calls.filter((c) => c.model === "vehicle");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(mentionsOrg(call.args, ORG_A)).toBe(true);
      expect(JSON.stringify(call.args)).toContain('"deletedAt":null');
    }
  });

  it("a filter id from another org matches nothing instead of leaking rows", async () => {
    expect(await serials({ customerId: "cust_b1" })).toEqual([]);
    expect(await serials({ brandId: "brand_b1" })).toEqual([]);
  });
});

describe("listVehicles: effective track", () => {
  it("FC = native FC plus FL converted to export, minus FC converted to local", async () => {
    expect(await serials({ track: "FC" })).toEqual(["FC101", "FC102", "FC103", "FC104", "FC105", "FC108", "FC109", "FL202"]);
  });
  it("FL = native FL plus FC converted to local", async () => {
    expect(await serials({ track: "FL" })).toEqual(["FC107", "FL201"].sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""))));
  });
  it("ALL has no track restriction", async () => {
    expect((await list({ track: "ALL" })).total).toBe(10);
  });
  it("row.track reports the effective track", async () => {
    const rows = (await list()).rows;
    expect(rows.find((r) => r.serial === "FL202")?.track).toBe("FC");
    expect(rows.find((r) => r.serial === "FC107")?.track).toBe("FL");
  });
});

describe("listVehicles: effective shipment status filters", () => {
  const fc = (shipmentStatus: VehicleListParams["shipmentStatus"]) => serials({ track: "FC", shipmentStatus });

  it("PENDING excludes cancelled vehicles (FC108 is stored PENDING but cancelled)", async () => {
    expect(await fc(["PENDING"])).toEqual(["FC101"]);
  });
  it("BOOKING_RECEIVED means not yet past its ETD, and excludes cancelled", async () => {
    expect(await fc(["BOOKING_RECEIVED"])).toEqual(["FC102", "FL202"]);
  });
  it("SHIPPED includes stored SHIPPED and BOOKING_RECEIVED whose ETD has passed, and excludes cancelled (FC109)", async () => {
    expect(await fc(["SHIPPED"])).toEqual(["FC103", "FC104"]);
  });
  it("CANCELLED is FC only and never matches an FL vehicle with a cancelling colour", async () => {
    expect(await fc(["CANCELLED"])).toEqual(["FC105", "FC108", "FC109"]);
    expect(await serials({ track: "ALL", shipmentStatus: ["CANCELLED"] })).toEqual(["FC105", "FC108", "FC109"]);
  });
  it("several statuses are OR-ed together", async () => {
    expect(await fc(["PENDING", "SHIPPED"])).toEqual(["FC101", "FC103", "FC104"]);
  });
  it("the filter agrees with the status shown on each row", async () => {
    const { rows } = await list({ track: "FC", sortBy: "serial" });
    for (const status of ["PENDING", "BOOKING_RECEIVED", "SHIPPED", "CANCELLED"] as const) {
      const filtered = await serials({ track: "FC", shipmentStatus: [status] });
      const shown = rows.filter((r) => r.effectiveShipmentStatus === status).map((r) => r.serial);
      expect(filtered).toEqual(shown);
    }
  });
});

describe("listVehicles: search and filters", () => {
  it("search is case-insensitive across serial, chassis, model, brand, customer and partner name", async () => {
    expect(await serials({ search: "chassis-aaa-2" })).toEqual(["FC102"]);
    expect(await serials({ search: "fl20" })).toEqual(["FL201", "FL202"]);
    expect(await serials({ search: "ETA TWO" })).toEqual(["FC102", "FL201"]);
    expect(await serials({ search: "beta autos" })).toEqual(["FC102", "FL201"]);
    expect(await serials({ search: "iota" })).toEqual(["FC101", "FL201"]);
    expect(await serials({ search: "partner one" })).toEqual(["FL201"]);
  });
  it("search never finds another org's data", async () => {
    expect(await serials({ search: "Org B Partner" })).toEqual([]);
    expect(await serials({ search: "Lambda" })).toEqual([]);
    expect(await serials({ search: "CHASSIS-BBB" })).toEqual([]);
  });
  it("search combines with the other filters", async () => {
    expect(await serials({ search: "chassis-aaa", track: "FC", shipmentStatus: ["SHIPPED"] })).toEqual(["FC103", "FC104"]);
  });
  it("filters by customer, destination, brand and model", async () => {
    expect(await serials({ customerId: "cust_a1" })).toEqual(["FC101", "FL201"]);
    expect(await serials({ destination: "Country One" })).toEqual(["FC101", "FC103"]);
    expect(await serials({ brandId: "brand_a2" })).toEqual(["FC102", "FL201"]);
    expect(await serials({ modelId: "model_a2" })).toEqual(["FC102", "FL201"]);
  });
  it("tri-state filters keep null distinct from false", async () => {
    expect(await serials({ auctionBillPaid: "YES" })).toEqual(["FC102"]);
    expect(await serials({ auctionBillPaid: "NO" })).toEqual(["FC103"]);
    expect(await serials({ auctionBillPaid: "BLANK" })).toEqual(["FC101", "FC104", "FC105", "FC107", "FC108", "FC109", "FL201", "FL202"]);
  });
  it("partnership, partner name, currency and conversion filters", async () => {
    expect(await serials({ hasPartnership: "YES" })).toEqual(["FC107", "FL201"]);
    expect(await serials({ partnerName: "Partner One" })).toEqual(["FL201"]);
    expect(await serials({ sellingPriceCurrency: "USD" })).toEqual(["FL201"]);
    expect(await serials({ convertedToExport: "YES" })).toEqual(["FL202"]);
    expect(await serials({ convertedToLocal: "YES" })).toEqual(["FC107"]);
  });
  it("etd range is inclusive and independent per bound", async () => {
    expect(await serials({ etdFrom: dayOffset(5), etdTo: dayOffset(12) })).toEqual(["FC102", "FC105", "FL202"]);
    expect(await serials({ etdFrom: dayOffset(8) })).toEqual(["FC102", "FC105"]);
  });
  it("rowColourStatusIdNot excludes that colour", async () => {
    const result = await serials({ rowColourStatusId: "rc_cancel" });
    expect(result).toEqual(["FC105", "FC109", "FL201"]);
    const not = await serials({ rowColourStatusIdNot: "rc_cancel" });
    for (const cancelled of ["FC105", "FC109", "FL201"]) expect(not).not.toContain(cancelled);
    expect(not).toContain("FC108"); // a different colour
    // ...and vehicles with NO colour at all (a plain { not } would drop them: SQL NULL <> x is not true).
    for (const noColour of ["FC101", "FC102", "FC103", "FC104", "FC107", "FL202"]) expect(not).toContain(noColour);
  });
});

describe("listVehicles: sorting and paging", () => {
  it("sorts serial numerically, not as text", async () => {
    expect(await serials({ sortBy: "serial", sortDir: "asc" })).toEqual(["FC101", "FC102", "FC103", "FC104", "FC105", "FC107", "FC108", "FC109", "FL201", "FL202"]);
    expect((await serials({ sortBy: "serial", sortDir: "desc" }))[0]).toBe("FL202");
  });
  it("sorts by a related column (model name)", async () => {
    const s = await serials({ sortBy: "model", sortDir: "asc" });
    expect(s.slice(0, 2).sort()).toEqual(["FC102", "FL201"]);
  });
  it("sorts by effective shipment status (not the stored column) and pages in memory", async () => {
    const all = await serials({ track: "FC", sortBy: "shipmentStatus", sortDir: "asc" });
    expect(all).toEqual(["FC101", "FC102", "FL202", "FC103", "FC104", "FC105", "FC108", "FC109"]);
    const page2 = await list({ track: "FC", sortBy: "shipmentStatus", sortDir: "asc", page: 2, pageSize: 2 });
    expect(page2.rows.map((r) => r.serial)).toEqual(["FL202", "FC103"]);
    expect(page2).toMatchObject({ total: 8, page: 2, pageSize: 2, totalPages: 4 });
  });
  it("paginates with total and totalPages", async () => {
    const page = await list({ page: 2, pageSize: 3 });
    expect(page.rows.map((r) => r.serial)).toEqual(["FC104", "FC105", "FC107"]);
    expect(page).toMatchObject({ total: 10, page: 2, pageSize: 3, totalPages: 4 });
  });
  it("an empty result still reports one page", async () => {
    expect(await list({ search: "no-such-thing" })).toMatchObject({ rows: [], total: 0, totalPages: 1 });
  });
});

describe("listVehicles: row shape", () => {
  it("returns plain values, not Prisma rows, with tri-state intact", async () => {
    const row = (await list()).rows.find((r) => r.serial === "FL201")!;
    expect(row).toMatchObject({
      brandName: "Beta Autos", modelName: "Eta Two", customerName: "Iota Buyer",
      sellingPrice: 12345, paidByCustomer: true, auctionBillPaid: null, hasPartnership: true,
    });
    expect(row.rowColourStatus).toEqual({ id: "rc_cancel", name: "Unit Canceled", colour: "#ff0000", transportCellOnly: false });
    expect(Object.keys(row)).not.toContain("org_id");
    expect(Object.keys(row)).not.toContain("deletedAt");
  });
  it("shows the effective status next to the stored one", async () => {
    const row = (await list()).rows.find((r) => r.serial === "FC103")!;
    expect(row).toMatchObject({ shipmentStatus: "BOOKING_RECEIVED", effectiveShipmentStatus: "SHIPPED" });
  });
});

describe("distinct destinations and partner names", () => {
  it("destinations: non-null, sorted, caller's org only, no deleted vehicles", async () => {
    fake.seed("vehicle", { id: "v_del_dest", org_id: ORG_A, serial: "FC108", deletedAt: new Date(), destination: "Deleted Place", serialPrefix: "FC", convertedToExport: false, convertedToLocal: false });
    expect(await listDistinctDestinations(ORG_A)).toEqual(["Country One", "Country Two", "Local Town"]);
    expect(await listDistinctDestinations(ORG_B)).toEqual(["Org B Country"]);
  });
  it("destinations can be limited to a track", async () => {
    expect(await listDistinctDestinations(ORG_A, "FL")).toEqual(["Local Town"]);
    expect(await listDistinctDestinations(ORG_A, "FC")).toEqual(["Country One", "Country Two"]);
  });
  it("partner names: caller's org only, limited by track", async () => {
    expect(await listDistinctPartnerNames(ORG_A)).toEqual(["Partner One", "Partner Two"]);
    expect(await listDistinctPartnerNames(ORG_A, "FL")).toEqual(["Partner One", "Partner Two"]);
    expect(await listDistinctPartnerNames(ORG_A, "FC")).toEqual([]);
    expect(await listDistinctPartnerNames(ORG_B)).toEqual(["Org B Partner"]);
  });
  it("every query includes org_id", async () => {
    await listDistinctDestinations(ORG_A);
    await listDistinctPartnerNames(ORG_A);
    expect(fake.calls.every((c) => mentionsOrg(c.args, ORG_A))).toBe(true);
  });
});

describe("getVehicleFilterOptions", () => {
  it("returns the fixed option sets and touches no data", () => {
    const options = getVehicleFilterOptions();
    expect(options.tracks.map((t) => t.value)).toEqual(["FC", "FL"]);
    expect(options.shipmentStatuses.map((s) => s.value)).toEqual(["PENDING", "BOOKING_RECEIVED", "SHIPPED", "CANCELLED"]);
    expect(options.shippingMethods).toEqual(["RORO", "CONTAINER"]);
    expect(options.triStateValues).toEqual(["YES", "NO", "BLANK"]);
    expect(options.twoStateValues).toEqual(["YES", "NO"]);
    expect(options.soldCurrencies).toEqual(["JPY", "LKR", "USD"]);
    expect(fake.calls).toHaveLength(0);
  });
});
