import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { actor, ORG_A, ORG_B } from "./helpers/fixtures.js";
import { newVehicleFake } from "./helpers/vehicle-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown, base: "https://files.example.test" as string | undefined }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));
vi.mock("../src/config/env.js", () => ({
  loadEnv: () => ({ R2_PUBLIC_URL: state.base }),
}));

import {
  convertVehicleToExport,
  correctVehicleSerialNumber,
  createVehicle,
  deleteVehicle,
  revertVehicleToLocal,
  updateVehicle,
  updateVehicleAuctionBillPaid,
} from "../src/services/vehicle.service.js";

let fake: FakePrisma;
const row = (id: string) => fake.rows("vehicle").find((v) => v["id"] === id)!;
const actions = () => fake.rows("activityLog").map((r) => r["action"]);

beforeEach(() => {
  fake = newVehicleFake();
  state.fake = fake;
  state.base = "https://files.example.test";
  fake.seed(
    "serialCounter",
    { org_id: ORG_A, prefix: "FC", lastNumber: 109 },
    { org_id: ORG_A, prefix: "FL", lastNumber: 202 },
    { org_id: ORG_B, prefix: "FC", lastNumber: 900 }
  );
  fake.seed("user", { id: "user_a_manager", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: false, name: "Test Manager A" });
});

const base = { track: "FC", isLegacyEntry: false, chassisNo: "NEW-CHASSIS-1", brandId: "brand_a1", modelId: "model_a1" } as const;

describe("createVehicle", () => {
  it("assigns the next serial for the org, writes an ActivityLog row, and leaves tri-state flags null", async () => {
    const created = await createVehicle(actor(), { ...base });
    expect(created).toMatchObject({ serial: "FC110", org_id: ORG_A, auctionBillPaid: null, logBook: null, extraKey: null });
    expect(actions()).toEqual(["CREATE_VEHICLE"]);
    expect(fake.rows("serialCounter").find((c) => c["org_id"] === ORG_A && c["prefix"] === "FC")?.["lastNumber"]).toBe(110);
    expect(fake.rows("serialCounter").find((c) => c["org_id"] === ORG_B)?.["lastNumber"]).toBe(900);
  });

  it("keeps an explicit false as false and does not turn null into false", async () => {
    const created = await createVehicle(actor(), { ...base, auctionBillPaid: false, logBook: true });
    expect(created).toMatchObject({ auctionBillPaid: false, logBook: true, extraKey: null });
  });

  it("an FL vehicle never stores shipping fields, whatever is posted", async () => {
    const created = await createVehicle(actor(), {
      ...base, track: "FL", etd: "2030-01-01", eta: "2030-02-01", blNo: "BL1", vesselName: "V",
      freightAgentId: "fa_a1", shippingMethod: "RORO", hasInspection: true,
    });
    expect(created).toMatchObject({
      serial: "FL203", etd: null, eta: null, blNo: null, vesselName: null, freightAgentId: null,
      shippingMethod: null, hasInspection: false,
    });
  });

  it("an FC vehicle created with an ETD starts at Booking Received with a history row", async () => {
    const created = await createVehicle(actor(), { ...base, etd: "2031-01-01" });
    expect(created["shipmentStatus"]).toBe("BOOKING_RECEIVED");
    expect(fake.rows("statusHistory").filter((h) => h["vehicleId"] === created.id)).toMatchObject([{ toStatus: "BOOKING_RECEIVED", trigger: "ETD_SAVED" }]);
  });

  it("a legacy serial that already exists is a CONFLICT and changes nothing", async () => {
    await expect(createVehicle(actor(), { ...base, isLegacyEntry: true, legacySerialNumber: 101 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  describe("every referenced id must belong to the caller's org", () => {
    it.each([
      ["modelId", { modelId: "model_b1" }],
      ["gradeId", { gradeId: "grade_b" }],
      ["rowColourStatusId", { rowColourStatusId: "rc_b_cancel" }],
      ["customerId", { customerId: "cust_b1" }],
      ["customerId (a staff user)", { customerId: "staff_a1" }],
      ["modelId (unknown)", { modelId: "nope" }],
    ])("%s", async (_n, over) => {
      await expect(createVehicle(actor(), { ...base, ...over })).rejects.toMatchObject({ code: "VALIDATION" });
      expect(fake.rows("activityLog")).toHaveLength(0);
      expect(fake.rows("serialCounter").find((c) => c["org_id"] === ORG_A && c["prefix"] === "FC")?.["lastNumber"]).toBe(109);
    });
  });

  describe("staged file URLs must be this org's uploads", () => {
    it.each([
      ["an internal address", { photoUrls: ["http://169.254.169.254/x.jpg"] }],
      ["another org's staging area", { photoUrls: [`https://files.example.test/org/${ORG_B}/uploads/staging/a.jpg`] }],
      ["an auction sheet elsewhere", { auctionSheetUrl: "https://evil.test/a.jpg" }],
      ["a document elsewhere", { documents: [{ url: "https://evil.test/a.pdf", name: "n", documentType: "OTHER" }] }],
    ])("rejects %s", async (_n, over) => {
      await expect(createVehicle(actor(), { ...base, ...over })).rejects.toMatchObject({ code: "VALIDATION" });
      expect(fake.rows("vehiclePhoto")).toHaveLength(0);
    });

    it("accepts this org's staging uploads and attaches them with ActivityLog rows", async () => {
      const url = `https://files.example.test/org/${ORG_A}/uploads/staging/a.jpg`;
      await createVehicle(actor(), { ...base, photoUrls: [url] });
      expect(fake.rows("vehiclePhoto")).toMatchObject([{ url }]);
      expect(actions()).toEqual(["ADD_VEHICLE_PHOTO", "CREATE_VEHICLE"]);
    });
  });

  it("rejects an invalid body with field errors", async () => {
    await expect(createVehicle(actor(), {})).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: expect.objectContaining({ chassisNo: expect.any(String) }),
    });
  });
});

describe("updateVehicle", () => {
  const edit = { chassisNo: "EDITED-1", brandId: "brand_a1", modelId: "model_a1" };

  it("is a full replace: omitted optional fields are cleared", async () => {
    expect(row("v_fc_pending")["yom"]).toBe(2020);
    await updateVehicle(actor(), "v_fc_pending", edit);
    expect(row("v_fc_pending")).toMatchObject({ chassisNo: "EDITED-1", yom: null, destination: null });
    expect(actions()).toContain("UPDATE_VEHICLE");
  });

  it("does not let an edit change the serial or track", async () => {
    await updateVehicle(actor(), "v_fc_pending", { ...edit, serial: "FC999", serialPrefix: "FL" });
    expect(row("v_fc_pending")).toMatchObject({ serial: "FC101", serialPrefix: "FC" });
  });

  it("another org's vehicle is NOT_FOUND and untouched", async () => {
    await expect(updateVehicle(actor(), "v_b_fc", edit)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(row("v_b_fc")["chassisNo"]).toBe("CHASSIS-BBB-1");
  });

  it("rejects another org's lookup ids", async () => {
    await expect(updateVehicle(actor(), "v_fc_pending", { ...edit, modelId: "model_b1" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(row("v_fc_pending")["modelId"]).toBe("model_a1");
  });
});

describe("deleteVehicle / conversions / quick edits", () => {
  it("delete is soft and a deleted vehicle is NOT_FOUND afterwards", async () => {
    await deleteVehicle(ORG_A, "u", "v_fc_pending");
    expect(row("v_fc_pending")["deletedAt"]).toBeInstanceOf(Date);
    await expect(deleteVehicle(ORG_A, "u", "v_fc_pending")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("only an FL vehicle can be converted to export, and only once", async () => {
    await expect(convertVehicleToExport(ORG_A, "u", "v_fc_pending", "Country")).rejects.toMatchObject({ code: "VALIDATION" });
    await convertVehicleToExport(ORG_A, "u", "v_fl_native", "Country One");
    expect(row("v_fl_native")).toMatchObject({ convertedToExport: true, destination: "Country One" });
    await expect(convertVehicleToExport(ORG_A, "u", "v_fl_native", "Country One")).rejects.toMatchObject({ code: "VALIDATION" });
    await revertVehicleToLocal(ORG_A, "u", "v_fl_native");
    expect(row("v_fl_native")["convertedToExport"]).toBe(false);
  });

  it("auction-bill-paid: true -> notifies once; the same value again does not; null stays null", async () => {
    fake.seed("user", { id: "mgr_1", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "M1" });
    await updateVehicleAuctionBillPaid(ORG_A, "u", "v_fc_pending", true);
    expect(fake.rows("notification")).toHaveLength(1);
    await updateVehicleAuctionBillPaid(ORG_A, "u", "v_fc_pending", true);
    expect(fake.rows("notification")).toHaveLength(1);
    await updateVehicleAuctionBillPaid(ORG_A, "u", "v_fc_pending", null);
    expect(row("v_fc_pending")["auctionBillPaid"]).toBeNull();
  });
});

describe("correctVehicleSerialNumber", () => {
  it("changes the number, keeps the prefix, bumps the counter up only", async () => {
    const result = await correctVehicleSerialNumber(ORG_A, "u", "v_fc_pending", 500);
    expect(result).toEqual({ serial: "FC500" });
    expect(row("v_fc_pending")).toMatchObject({ serial: "FC500", serialNumber: 500, serialPrefix: "FC" });
    const counter = () => fake.rows("serialCounter").find((c) => c["org_id"] === ORG_A && c["prefix"] === "FC")?.["lastNumber"];
    expect(counter()).toBe(500);
    await correctVehicleSerialNumber(ORG_A, "u", "v_fc_pending", 20);
    expect(counter()).toBe(500);
  });

  it("refuses a serial that another vehicle already has (CONFLICT) and leaves everything unchanged", async () => {
    await expect(correctVehicleSerialNumber(ORG_A, "u", "v_fc_pending", 102)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(row("v_fc_pending")["serial"]).toBe("FC101");
  });

  it("allows a serial that only the OTHER org uses", async () => {
    // Org B has FC900; org A does not.
    await expect(correctVehicleSerialNumber(ORG_A, "u", "v_fc_pending", 900)).resolves.toEqual({ serial: "FC900" });
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects %s", async (n) => {
    await expect(correctVehicleSerialNumber(ORG_A, "u", "v_fc_pending", n)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("another org's vehicle is NOT_FOUND", async () => {
    await expect(correctVehicleSerialNumber(ORG_A, "u", "v_b_fc", 5000)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
