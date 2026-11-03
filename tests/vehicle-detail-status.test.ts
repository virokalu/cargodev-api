// The vehicle detail shows the EFFECTIVE shipment status as `shipmentStatus` and the stored value as `storedShipmentStatus`, by the
// same rule as the list (a past ETD reads SHIPPED; a cancelled row colour reads CANCELLED on FC only). And the derived Shipment
// Timeline (GET /vehicles/:serial/timeline). Fake data only.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { installFakeStorage, makeCtx, newContractWorld, removeFakeStorage, type Ctx } from "./helpers/staff-contract-examples.js";

vi.setConfig({ testTimeout: 60_000 });
const state = vi.hoisted(() => {
  process.env["R2_PUBLIC_URL"] = "https://files.example.test";
  return { fake: undefined as unknown };
});
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { buildApp } from "../src/app.js";
import { setTrustTokenClaimsForTests } from "../src/lib/staff-auth-seam.js";
import { clearStaffAuthCache } from "../src/services/staff-auth-state.service.js";

let app: FastifyInstance;
let fake: FakePrisma;
let ctx: Ctx;
type Row = Record<string, unknown>;

beforeAll(async () => {
  setTrustTokenClaimsForTests(false);
  installFakeStorage();
  state.fake = newContractWorld();
  app = await buildApp({ rateLimit: false, publicStockEnabled: true });
});
afterAll(async () => {
  await app.close();
  removeFakeStorage();
  setTrustTokenClaimsForTests(true);
});
beforeEach(() => {
  fake = newContractWorld();
  state.fake = fake;
  clearStaffAuthCache();
  ctx = makeCtx(app, fake);
});

const detail = async (serial: string) => ((await ctx.call("VIEWER", "GET", `/api/v1/vehicles/${serial}`)).body as { data: Row }).data;
const listRow = async (serial: string) => {
  const res = await ctx.call("VIEWER", "GET", `/api/v1/vehicles?track=ALL&pageSize=100`);
  return ((res.body as { data: { rows: Row[] } }).data.rows).find((r) => r["serial"] === serial)!;
};
const steps = async (serial: string) => ((await ctx.call("VIEWER", "GET", `/api/v1/vehicles/${serial}/timeline`)).body as { data: Array<{ key: string; label: string; completed: boolean; date: string | null }> }).data;
const vehicle = (id: string): Row => fake.rows("vehicle").find((r) => r["id"] === id) as Row;

describe("detail: shipmentStatus is the effective value, storedShipmentStatus the stored one", () => {
  it("a booked vehicle whose ETD has passed reads SHIPPED while the database still holds BOOKING_RECEIVED", async () => {
    const d = await detail("FC103");
    expect([d["shipmentStatus"], d["storedShipmentStatus"]]).toEqual(["SHIPPED", "BOOKING_RECEIVED"]);
  });

  it("a cancelled row colour reads CANCELLED on an FC vehicle whatever is stored", async () => {
    for (const [serial, stored] of [["FC105", "BOOKING_RECEIVED"], ["FC108", "PENDING"], ["FC109", "SHIPPED"]] as const) {
      const d = await detail(serial);
      expect([serial, d["shipmentStatus"], d["storedShipmentStatus"]]).toEqual([serial, "CANCELLED", stored]);
    }
  });

  it("an FL vehicle is never CANCELLED, even with a cancelled row colour", async () => {
    const d = await detail("FL201");
    expect(d["shipmentStatus"]).not.toBe("CANCELLED");
    expect(d["storedShipmentStatus"]).toBe(vehicle("v_fl_native")["shipmentStatus"]);
  });

  it("an unchanged vehicle has the same value in both", async () => {
    const d = await detail("FC102");
    expect([d["shipmentStatus"], d["storedShipmentStatus"]]).toEqual(["BOOKING_RECEIVED", "BOOKING_RECEIVED"]);
  });

  it("agrees with the list for every vehicle: detail.shipmentStatus equals the list row's effectiveShipmentStatus, and the stored values match", async () => {
    for (const serial of ["FC101", "FC102", "FC103", "FC104", "FC105", "FC108", "FC109", "FL201", "FL202", "FC107"]) {
      const d = await detail(serial);
      const l = await listRow(serial);
      expect(d["shipmentStatus"], `${serial} effective`).toBe(l["effectiveShipmentStatus"]);
      expect(d["storedShipmentStatus"], `${serial} stored`).toBe(l["shipmentStatus"]);
    }
  });

  it("create and update answer with the same two keys", async () => {
    const created = await ctx.call("MANAGER", "PUT", "/api/v1/vehicles/v_fc_booked_past", {
      chassisNo: "CHASSIS-AAA-3", brandId: "brand_a1", modelId: "model_a1", etd: "2020-01-01", hasPartnership: false, hasInspection: false,
    });
    const data = (created.body as { data: Row }).data;
    expect(created.status).toBe(200);
    expect(data).toHaveProperty("storedShipmentStatus");
    expect(data["shipmentStatus"]).toBe("SHIPPED");
  });
});

describe("GET /vehicles/:serial/timeline", () => {
  it("is the derived steps in process order, each { key, label, completed, date }", async () => {
    const t = await steps("FC102");
    expect(t.map((s) => s.key)).toEqual(["AUCTION_BILL_PAID", "TRANSPORT_ASSIGNED", "EC_RECEIVED", "BOOKING_RECEIVED", "SHIPPED", "DELIVERED"]);
    for (const step of t) expect(Object.keys(step).sort()).toEqual(["completed", "date", "key", "label"]);
    expect(t.find((s) => s.key === "AUCTION_BILL_PAID")).toMatchObject({ completed: true, date: null });
    expect(t.find((s) => s.key === "BOOKING_RECEIVED")?.completed).toBe(true);
    expect(t.find((s) => s.key === "SHIPPED")).toMatchObject({ completed: false, date: null });
  });

  it("auction bill false and null both read as not completed (the tri-state is for forms, not this view)", async () => {
    expect((await steps("FC103")).find((s) => s.key === "AUCTION_BILL_PAID")?.completed).toBe(false);
    expect((await steps("FC101")).find((s) => s.key === "AUCTION_BILL_PAID")?.completed).toBe(false);
  });

  it("SHIPPED and DELIVERED complete when the ETD and the ETA have passed, and carry those dates", async () => {
    const t = await steps("FC103");
    expect(t.find((s) => s.key === "SHIPPED")).toMatchObject({ completed: true });
    expect(t.find((s) => s.key === "SHIPPED")?.date).toBe((vehicle("v_fc_booked_past")["etd"] as Date).toISOString());
    expect(t.find((s) => s.key === "DELIVERED")).toMatchObject({ completed: false, date: null });
    vehicle("v_fc_booked_past")["eta"] = new Date(Date.now() + 5 * 86_400_000); // an ETA still ahead is not delivered
    expect((await steps("FC103")).find((s) => s.key === "DELIVERED")).toMatchObject({ completed: false, date: null });
    vehicle("v_fc_booked_past")["eta"] = new Date(Date.now() - 86_400_000);
    expect((await steps("FC103")).find((s) => s.key === "DELIVERED")?.completed).toBe(true);
  });

  it("LOADED appears only for container shipments and completes when the vanning date has passed", async () => {
    expect((await steps("FC103")).map((s) => s.key)).not.toContain("LOADED");
    Object.assign(vehicle("v_fc_booked_past"), { shippingMethod: "CONTAINER", vanningDate: new Date(Date.now() - 86_400_000) });
    expect((await steps("FC103")).find((s) => s.key === "LOADED")).toMatchObject({ completed: true });
    Object.assign(vehicle("v_fc_booked_past"), { vanningDate: new Date(Date.now() + 5 * 86_400_000) });
    expect((await steps("FC103")).find((s) => s.key === "LOADED")).toMatchObject({ completed: false, date: null });
    Object.assign(vehicle("v_fc_booked_past"), { shippingMethod: "RORO" });
    expect((await steps("FC103")).map((s) => s.key)).not.toContain("LOADED");
  });

  it("LC_OPEN appears only for Sri Lanka and Bangladesh and completes with an LC number", async () => {
    expect((await steps("FC102")).map((s) => s.key)).not.toContain("LC_OPEN");
    Object.assign(vehicle("v_fc_booked_future"), { destination: "Sri Lanka" });
    expect((await steps("FC102")).find((s) => s.key === "LC_OPEN")).toMatchObject({ completed: false });
    Object.assign(vehicle("v_fc_booked_future"), { lcNo: "LC-1", destination: "Bangladesh" });
    expect((await steps("FC102")).find((s) => s.key === "LC_OPEN")).toMatchObject({ completed: true });
  });

  it("EC_RECEIVED completes with an EC document (dated by the earliest), INSPECTION_COMPLETED appears only with an inspection report", async () => {
    const before = await steps("FC102");
    expect(before.find((s) => s.key === "EC_RECEIVED")).toMatchObject({ completed: false, date: null });
    expect(before.map((s) => s.key)).not.toContain("INSPECTION_COMPLETED");
    const doc = (id: string, documentType: string, createdAt: string): Row => ({ id, vehicleId: "v_fc_booked_future", url: "https://files.example.test/x.pdf", name: "x.pdf", documentType, uploadedById: "staff_mgr", createdAt: new Date(createdAt), visibleToCustomer: false });
    fake.seed("vehicleDocument", doc("d_ec_late", "EC", "2026-10-20T00:00:00Z"), doc("d_ec_early", "EC", "2026-10-10T00:00:00Z"), doc("d_insp", "INSPECTION_REPORT", "2026-10-15T00:00:00Z"));
    const after = await steps("FC102");
    expect(after.find((s) => s.key === "EC_RECEIVED")).toMatchObject({ completed: true, date: "2026-10-10T00:00:00.000Z" });
    expect(after.find((s) => s.key === "INSPECTION_COMPLETED")).toMatchObject({ completed: true, date: "2026-10-15T00:00:00.000Z" });
    const keys = after.map((s) => s.key);
    expect(keys.indexOf("INSPECTION_COMPLETED")).toBeGreaterThan(keys.indexOf("EC_RECEIVED"));
    expect(keys.indexOf("INSPECTION_COMPLETED")).toBeLessThan(keys.indexOf("BOOKING_RECEIVED"));
  });

  it("another vehicle's documents do not count", async () => {
    fake.seed("vehicleDocument", { id: "d_other", vehicleId: "v_fc_pending", url: "https://files.example.test/y.pdf", name: "y.pdf", documentType: "EC", uploadedById: "staff_mgr", createdAt: new Date(), visibleToCustomer: false });
    expect((await steps("FC102")).find((s) => s.key === "EC_RECEIVED")?.completed).toBe(false);
  });

  it("an unknown, a deleted and another organisation's serial are 404", async () => {
    for (const serial of ["FC999", "FC106", "FC900"]) {
      const res = await ctx.call("VIEWER", "GET", `/api/v1/vehicles/${serial}/timeline`);
      expect(res.status, serial).toBe(404);
    }
  });

  it("needs a staff token (401 without, 401 with a customer token is covered by the route inventory)", async () => {
    expect((await ctx.call(null, "GET", "/api/v1/vehicles/FC102/timeline")).status).toBe(401);
  });
});
