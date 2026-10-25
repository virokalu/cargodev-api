import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { setObjectDeleter } from "../src/lib/object-storage.js";
import {
  addVehicleDocument,
  addVehiclePhoto,
  deleteVehicleDocument,
  deleteVehiclePhoto,
  getVehiclePdfImages,
  listVehicleFiles,
  notifyPhotosAdded,
  setAuctionSheet,
} from "../src/services/file.service.js";

const BASE = "https://files.example.test";
const VEH = "v_fc_pending";
const photoUrl = (org = ORG_A, vehicle = VEH, name = "a.jpg") => `${BASE}/org/${org}/vehicles/${vehicle}/photos/${name}`;
const docUrl = (name = "d.pdf") => `${BASE}/org/${ORG_A}/vehicles/${VEH}/documents/${name}`;
const sheetUrl = (name = "s.jpg") => `${BASE}/org/${ORG_A}/vehicles/${VEH}/auction-sheet/${name}`;

let fake: FakePrisma;
let deleted: string[];

beforeEach(() => {
  fake = newVehicleFake();
  state.fake = fake;
  fake.seed("user", { id: "user_a_manager", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: false, name: "Test Manager A" }, { id: "someone", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: false, name: "Someone" }, { id: "mgr_actor", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "Actor" });
  state.base = BASE;
  deleted = [];
  setObjectDeleter(async (key) => {
    deleted.push(key);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setObjectDeleter(async () => undefined);
});

const rejects = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ code });
};

describe("a vehicle outside the caller's org is NOT_FOUND on every file operation", () => {
  const other = "v_b_fc";
  it.each([
    ["list", () => listVehicleFiles(ORG_A, other)],
    ["pdf images", () => getVehiclePdfImages(ORG_A, other)],
    ["set auction sheet", () => setAuctionSheet(actor(), other, { url: sheetUrl() })],
    ["add photo", () => addVehiclePhoto(actor(), other, { url: photoUrl() })],
    ["photos added", () => notifyPhotosAdded(actor(), other, { count: 1 })],
    ["add document", () => addVehicleDocument(actor(), other, { url: docUrl(), name: "n", documentType: "OTHER" })],
    ["delete photo", () => deleteVehiclePhoto(actor(), other, "p")],
    ["delete document", () => deleteVehicleDocument(actor(), other, "d")],
  ])("%s", async (_n, run) => {
    await rejects(run(), "NOT_FOUND");
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  it("and so is a soft-deleted vehicle", async () => {
    await rejects(addVehiclePhoto(actor(), "v_fc_deleted", { url: photoUrl(ORG_A, "v_fc_deleted") }), "NOT_FOUND");
  });
});

describe("new file URLs must be this org's own upload for this vehicle", () => {
  it.each([
    ["an internal address", "http://169.254.169.254/latest/meta-data/"],
    ["another host", "https://evil.test/a.jpg"],
    ["another org's folder", photoUrl(ORG_B)],
    ["another vehicle's folder", photoUrl(ORG_A, "v_fc_booked_future")],
    ["the wrong kind folder", docUrl()],
    ["traversal", `${BASE}/org/${ORG_A}/vehicles/${VEH}/photos/../../../${ORG_B}/x.jpg`],
    ["a query string", `${photoUrl()}?x=1`],
  ])("a photo URL with %s is a field error and writes nothing", async (_n, url) => {
    await expect(addVehiclePhoto(actor(), VEH, { url })).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { url: expect.any(String) },
    });
    expect(fake.rows("vehiclePhoto")).toHaveLength(0);
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  it("fails closed when storage is not configured", async () => {
    state.base = undefined;
    await expect(addVehiclePhoto(actor(), VEH, { url: photoUrl() })).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { url: "File storage is not configured." },
    });
  });

  it("rejects a malformed body before touching the database", async () => {
    await rejects(addVehiclePhoto(actor(), VEH, {}), "VALIDATION");
    await rejects(addVehicleDocument(actor(), VEH, { url: docUrl(), name: "n", documentType: "NOPE" }), "VALIDATION");
    await rejects(notifyPhotosAdded(actor(), VEH, { count: 0 }), "VALIDATION");
  });
});

describe("photos", () => {
  it("adds a photo with an ActivityLog row, scoped to the caller's org", async () => {
    const photo = await addVehiclePhoto(actor(), VEH, { url: photoUrl() });
    expect(photo).toMatchObject({ url: photoUrl(), uploaderName: expect.any(String) });
    expect(fake.rows("vehiclePhoto")).toHaveLength(1);
    expect(fake.rows("activityLog")).toMatchObject([{ org_id: ORG_A, action: "ADD_VEHICLE_PHOTO" }]);
  });

  it("deleting removes the row, logs it, and removes the stored object in the org's folder", async () => {
    const photo = await addVehiclePhoto(actor(), VEH, { url: photoUrl() });
    await deleteVehiclePhoto(actor(), VEH, photo.id);
    expect(fake.rows("vehiclePhoto")).toHaveLength(0);
    expect(fake.rows("activityLog").map((r) => r["action"])).toContain("DELETE_VEHICLE_PHOTO");
    expect(deleted).toEqual([`org/${ORG_A}/vehicles/${VEH}/photos/a.jpg`]);
  });

  it("a photo id from another vehicle is NOT_FOUND", async () => {
    fake.seed("vehiclePhoto", { id: "p_other", vehicleId: "v_fc_booked_future", url: photoUrl(ORG_A, "v_fc_booked_future"), uploadedById: "staff_a1" });
    await rejects(deleteVehiclePhoto(actor(), VEH, "p_other"), "NOT_FOUND");
    expect(fake.rows("vehiclePhoto")).toHaveLength(1);
  });

  it("a stored URL pointing at ANOTHER org's file is deleted from the database but its object is never touched", async () => {
    // Rows written before validation existed may hold anything.
    fake.seed("vehiclePhoto", { id: "p_bad", vehicleId: VEH, url: photoUrl(ORG_B, "v_b_fc"), uploadedById: "staff_a1" });
    fake.seed("vehiclePhoto", { id: "p_bad2", vehicleId: VEH, url: "http://169.254.169.254/x.jpg", uploadedById: "staff_a1" });
    await deleteVehiclePhoto(actor(), VEH, "p_bad");
    await deleteVehiclePhoto(actor(), VEH, "p_bad2");
    expect(deleted).toEqual([]);
  });

  it("a failing object delete never fails the request", async () => {
    setObjectDeleter(async () => {
      throw new Error("storage down");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const photo = await addVehiclePhoto(actor(), VEH, { url: photoUrl() });
    await expect(deleteVehiclePhoto(actor(), VEH, photo.id)).resolves.toBeUndefined();
  });

  it("notifyPhotosAdded sends one notification per recipient, excluding the actor", async () => {
    fake.seed(
      "user",
      { id: "mgr_1", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "M1" },
      
      { id: "mgr_b", org_id: ORG_B, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "Other org" }
    );
    await notifyPhotosAdded(actor({ id: "mgr_actor" }), VEH, { count: 3 });
    const rows = fake.rows("notification");
    expect(rows.map((r) => r["userId"] ?? r["user_id"])).toEqual(["mgr_1"]);
    expect(rows[0]).toMatchObject({ org_id: ORG_A, event: "DOCUMENT_UPLOADED" });
  });
});

describe("documents", () => {
  it("adds a document with an ActivityLog row and a notification", async () => {
    fake.seed("user", { id: "mgr_1", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "M1" });
    const doc = await addVehicleDocument(actor({ id: "someone" }), VEH, { url: docUrl(), name: "Invoice", documentType: "SALES_INVOICE" });
    expect(doc).toMatchObject({ name: "Invoice", documentType: "SALES_INVOICE" });
    expect(fake.rows("activityLog").map((r) => r["action"])).toEqual(["ADD_VEHICLE_DOCUMENT"]);
    expect(fake.rows("notification").map((r) => r["userId"] ?? r["user_id"]).sort()).toEqual(["mgr_1", "mgr_actor"]);
  });

  it("deletes a document and its own-org object", async () => {
    const doc = await addVehicleDocument(actor(), VEH, { url: docUrl(), name: "n", documentType: "OTHER" });
    await deleteVehicleDocument(actor(), VEH, doc.id);
    expect(fake.rows("vehicleDocument")).toHaveLength(0);
    expect(deleted).toEqual([`org/${ORG_A}/vehicles/${VEH}/documents/d.pdf`]);
  });
});

describe("auction sheet", () => {
  it("sets the sheet, logs before/after, and removes the replaced object", async () => {
    await setAuctionSheet(actor(), VEH, { url: sheetUrl("one.jpg") });
    const second = await setAuctionSheet(actor(), VEH, { url: sheetUrl("two.jpg") });
    expect(second).toEqual({ auctionSheetUrl: sheetUrl("two.jpg") });
    expect(deleted).toEqual([`org/${ORG_A}/vehicles/${VEH}/auction-sheet/one.jpg`]);
    expect(fake.rows("activityLog")).toHaveLength(2);
  });

  it("setting the same URL again deletes nothing", async () => {
    await setAuctionSheet(actor(), VEH, { url: sheetUrl() });
    await setAuctionSheet(actor(), VEH, { url: sheetUrl() });
    expect(deleted).toEqual([]);
  });
});

describe("getVehiclePdfImages: the server-side fetch", () => {
  const image = (type = "image/png", body = "abc", headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { "content-type": type, ...headers } });

  const seedPhotos = (...urls: string[]) =>
    urls.forEach((url, i) => fake.seed("vehiclePhoto", { id: `p${i}`, vehicleId: VEH, url, uploadedById: "staff_a1" }));

  it("fetches own-org images with redirects refused and a timeout, returning data URLs", async () => {
    seedPhotos(photoUrl());
    const fetchMock = vi.fn(async () => image());
    vi.stubGlobal("fetch", fetchMock);
    const result = await getVehiclePdfImages(ORG_A, VEH);
    expect(result.photoDataUrls).toEqual([`data:image/png;base64,${Buffer.from("abc").toString("base64")}`]);
    expect(fetchMock).toHaveBeenCalledWith(photoUrl(), expect.objectContaining({ redirect: "error", signal: expect.anything() }));
  });

  it("NEVER fetches a stored URL outside this org's folder (SSRF / cross-org)", async () => {
    seedPhotos("http://169.254.169.254/latest/meta-data/", "http://localhost:5432/", photoUrl(ORG_B, "v_b_fc"), "https://evil.test/a.jpg");
    fake.rows("vehicle").find((v) => v["id"] === VEH)!["auctionSheetUrl"] = "http://10.0.0.5/admin";
    const fetchMock = vi.fn(async () => image());
    vi.stubGlobal("fetch", fetchMock);
    const result = await getVehiclePdfImages(ORG_A, VEH);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ auctionSheetDataUrl: null, photoDataUrls: [] });
  });

  it("never fetches when storage is not configured", async () => {
    state.base = undefined;
    seedPhotos(photoUrl());
    const fetchMock = vi.fn(async () => image());
    vi.stubGlobal("fetch", fetchMock);
    expect((await getVehiclePdfImages(ORG_A, VEH)).photoDataUrls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-image type", () => image("text/html")],
    ["an svg", () => image("image/svg+xml")],
    ["a non-200", () => new Response("no", { status: 404, headers: { "content-type": "image/png" } })],
    ["a declared size over the cap", () => image("image/png", "x", { "content-length": String(16 * 1024 * 1024) })],
    ["a body over the cap", () => new Response(new Uint8Array(15 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } })],
  ])("skips %s", async (_n, make) => {
    seedPhotos(photoUrl());
    vi.stubGlobal("fetch", vi.fn(async () => make()));
    expect((await getVehiclePdfImages(ORG_A, VEH)).photoDataUrls).toEqual([]);
  });

  it("a network error or redirect error skips that image and keeps the others", async () => {
    seedPhotos(photoUrl(ORG_A, VEH, "bad.jpg"), photoUrl(ORG_A, VEH, "good.jpg"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("bad.jpg")) throw new TypeError("redirect mode is set to error");
        return image();
      })
    );
    expect((await getVehiclePdfImages(ORG_A, VEH)).photoDataUrls).toHaveLength(1);
  });
});
