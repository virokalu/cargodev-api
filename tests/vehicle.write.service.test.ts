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

  describe("staged file KEYS must be this org's uploads", () => {
    it.each([
      ["an internal address", { photoKeys: ["http://169.254.169.254/x.jpg"] }, "photoKeys.0"],
      ["another org's staging area", { photoKeys: [`org/${ORG_B}/uploads/staging/a.jpg`] }, "photoKeys.0"],
      ["an auction sheet elsewhere", { auctionSheetKey: "evil/a.jpg" }, "auctionSheetKey"],
      ["a document elsewhere", { documents: [{ key: "evil/a.pdf", name: "n", documentType: "OTHER" }] }, "documents.0.key"],
      ["a whole address instead of a key", { photoKeys: ["https://files.example.test/org/org_test_a/uploads/staging/a.jpg"] }, "photoKeys.0"],
      ["a pdf as a photo", { photoKeys: [`org/${ORG_A}/uploads/staging/a.pdf`] }, "photoKeys.0"],
    ])("rejects %s", async (_n, over, field) => {
      await expect(createVehicle(actor(), { ...base, ...over })).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { [field]: expect.any(String) } });
      expect(fake.rows("vehiclePhoto")).toHaveLength(0);
      expect(actions()).toEqual([]);
    });

    it("with a store configured the objects must really exist and be within the size limit", async () => {
      const { setObjectStore } = await import("../src/lib/object-storage.js");
      const { Readable } = await import("node:stream");
      const sizes = new Map<string, number>();
      setObjectStore({
        presignPut: async () => "https://upload.example.test/x",
        getObject: async ({ key }: { key: string }) => (sizes.has(key) ? { kind: "found", body: Readable.from([Buffer.from("x")]), contentLength: sizes.get(key)!, etag: null } : { kind: "missing" }),
        putObject: async () => undefined,
        deleteKey: async () => undefined,
      } as never); // only what registering a file reads is provided
      try {
        const photo = `org/${ORG_A}/uploads/staging/p.jpg`;
        const doc = `org/${ORG_A}/uploads/staging/d.pdf`;
        const sheet = `org/${ORG_A}/uploads/staging/s.png`;
        await expect(createVehicle(actor(), { ...base, photoKeys: [photo] })).rejects.toMatchObject({ fieldErrors: { "photoKeys.0": expect.stringContaining("has not been uploaded") } });
        await expect(createVehicle(actor(), { ...base, auctionSheetKey: sheet })).rejects.toMatchObject({ fieldErrors: { auctionSheetKey: expect.stringContaining("has not been uploaded") } });
        await expect(createVehicle(actor(), { ...base, documents: [{ key: doc, name: "n", documentType: "OTHER" }] })).rejects.toMatchObject({ fieldErrors: { "documents.0.key": expect.stringContaining("has not been uploaded") } });
        expect(fake.rows("vehiclePhoto")).toHaveLength(0);
        sizes.set(photo, 10 * 1024 * 1024 + 1);
        await expect(createVehicle(actor(), { ...base, photoKeys: [photo] })).rejects.toMatchObject({ fieldErrors: { "photoKeys.0": expect.stringContaining("10 MB") } });
        sizes.set(photo, 1000);
        sizes.set(doc, 1000);
        sizes.set(sheet, 1000);
        await expect(createVehicle(actor(), { ...base, photoKeys: [photo], auctionSheetKey: sheet, documents: [{ key: doc, name: "n", documentType: "OTHER" }] })).resolves.toBeTruthy();
        expect(fake.rows("vehiclePhoto")).toHaveLength(1);
      } finally {
        setObjectStore(null);
      }
    });

    it("the old address fields are no longer accepted (unknown fields are ignored: nothing is attached)", async () => {
      const stagingUrl = `https://files.example.test/org/${ORG_A}/uploads/staging/a.jpg`;
      await createVehicle(actor(), { ...base, photoUrls: [stagingUrl], auctionSheetUrl: stagingUrl });
      expect(fake.rows("vehiclePhoto")).toHaveLength(0);
    });

    it("accepts this org's staging uploads, builds the stored address from the key, and logs ids, kinds and names only", async () => {
      const key = `org/${ORG_A}/uploads/staging/0f8fad5b-d9cb-469f-a165-70867728950e-front.jpg`;
      const sheet = `org/${ORG_A}/uploads/staging/s.png`;
      await createVehicle(actor(), { ...base, photoKeys: [key], auctionSheetKey: sheet });
      expect(fake.rows("vehiclePhoto")).toMatchObject([{ url: `https://files.example.test/${key}` }]);
      expect(actions()).toEqual(["ADD_VEHICLE_PHOTO", "CREATE_VEHICLE"]);
      const [photoLog, vehicleLog] = fake.rows("activityLog");
      expect(photoLog?.["after"]).toEqual({ fileId: fake.rows("vehiclePhoto")[0]!["id"], kind: "VEHICLE_PHOTO", fileName: "front.jpg" });
      expect(vehicleLog?.["after"]).toMatchObject({ auctionSheet: { kind: "AUCTION_SHEET", fileName: "s.png" } });
      expect(vehicleLog?.["after"]).not.toHaveProperty("auctionSheetUrl");
      expect(JSON.stringify(fake.rows("activityLog"))).not.toMatch(/files\.example|org\/|https?:/);
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
