import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { actor, ORG_A, ORG_B } from "./helpers/fixtures.js";
import { newVehicleFake } from "./helpers/vehicle-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown, base: "https://files.example.test" as string | undefined }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));
vi.mock("../src/config/env.js", () => ({
  loadEnv: () => ({ R2_PUBLIC_URL: state.base, STAFF_SIGNED_URL_TTL_SECONDS: 600 }),
}));

import { setObjectDeleter, setObjectStore, type ObjectStore } from "../src/lib/object-storage.js";
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
// Files are registered by KEY (what the upload presign returned); the stored address is built on the server from it.
const photoKey = (org = ORG_A, vehicle = VEH, name = "a.jpg") => `org/${org}/vehicles/${vehicle}/photos/${name}`;
const docKey = (name = "d.pdf") => `org/${ORG_A}/vehicles/${VEH}/documents/${name}`;
const sheetKey = (name = "s.jpg") => `org/${ORG_A}/vehicles/${VEH}/auction-sheet/${name}`;
const photoUrl = (...args: Parameters<typeof photoKey>) => `${BASE}/${photoKey(...args)}`;
const docUrl = (name = "d.pdf") => `${BASE}/${docKey(name)}`;

// Staff get short-lived signed links, never the stored address. The store holds only the objects a test says were uploaded
// (registering a key checks the object exists and is not too large).
const SIGNED = (key: string) => `https://s3.example.test/${key}?X-Amz-Expires=600&X-Amz-Signature=test`;
const uploaded = new Map<string, number>(); // key -> size in bytes
const signingStore: ObjectStore = {
  presignGet: async (args) => SIGNED(args.key),
  presignPut: async () => "https://upload.example.test/x",
  getObject: async ({ key }) => {
    const size = uploaded.get(key);
    return size === undefined ? { kind: "missing" } : { kind: "found", body: Readable.from([Buffer.from("x")]), contentLength: size, etag: null };
  },
  putObject: async () => undefined,
  deleteKey: async (key) => void deleted.push(key),
};

let fake: FakePrisma;
let deleted: string[];

beforeEach(() => {
  fake = newVehicleFake();
  state.fake = fake;
  fake.seed("user", { id: "user_a_manager", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: false, name: "Test Manager A" }, { id: "someone", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: false, name: "Someone" }, { id: "mgr_actor", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "Actor" });
  state.base = BASE;
  uploaded.clear();
  for (const key of [photoKey(), photoKey(ORG_A, "v_fc_deleted"), docKey(), sheetKey(), sheetKey("one.jpg"), sheetKey("two.jpg")]) uploaded.set(key, 1000);
  vi.spyOn(console, "error").mockImplementation(() => undefined); // the best-effort thumbnail cannot read these fake objects
  setObjectStore(signingStore);
  deleted = [];
  setObjectDeleter(async (key) => {
    deleted.push(key);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setObjectStore(null);
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
    ["set auction sheet", () => setAuctionSheet(actor(), other, { key: sheetKey() })],
    ["add photo", () => addVehiclePhoto(actor(), other, { key: photoKey() })],
    ["photos added", () => notifyPhotosAdded(actor(), other, { count: 1 })],
    ["add document", () => addVehicleDocument(actor(), other, { key: docKey(), name: "n", documentType: "OTHER" })],
    ["delete photo", () => deleteVehiclePhoto(actor(), other, "p")],
    ["delete document", () => deleteVehicleDocument(actor(), other, "d")],
  ])("%s", async (_n, run) => {
    await rejects(run(), "NOT_FOUND");
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  it("and so is a soft-deleted vehicle", async () => {
    await rejects(addVehiclePhoto(actor(), "v_fc_deleted", { key: photoKey(ORG_A, "v_fc_deleted") }), "NOT_FOUND");
  });
});

describe("new file KEYS must be this org's own upload for this vehicle", () => {
  it.each([
    ["a whole URL instead of a key", photoUrl()],
    ["an internal address", "http://169.254.169.254/latest/meta-data/"],
    ["another org's folder", photoKey(ORG_B)],
    ["another vehicle's folder", photoKey(ORG_A, "v_fc_booked_future")],
    ["the wrong kind folder", docKey()],
    ["traversal", `org/${ORG_A}/vehicles/${VEH}/photos/../../../${ORG_B}/x.jpg`],
    ["a query string", `${photoKey()}?x=1`],
    ["an svg", photoKey(ORG_A, VEH, "x.svg")],
    ["an html file", photoKey(ORG_A, VEH, "x.html")],
    ["no extension", photoKey(ORG_A, VEH, "x")],
    ["a pdf as a photo", photoKey(ORG_A, VEH, "x.pdf")],
    ["another org's id as a prefix", `org/${ORG_A}x/vehicles/${VEH}/photos/a.jpg`],
    ["a thumbnail folder", `org/${ORG_A}/vehicles/${VEH}/photos-thumb/a.jpg`],
    ["an empty key", ""],
  ])("a photo key with %s is a field error and writes nothing", async (_n, key) => {
    await expect(addVehiclePhoto(actor(), VEH, { key })).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { key: expect.any(String) } });
    expect(fake.rows("vehiclePhoto")).toHaveLength(0);
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  it("the old 'url' field is no longer accepted", async () => {
    await expect(addVehiclePhoto(actor(), VEH, { url: photoUrl() })).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { key: expect.any(String) } });
    expect(fake.rows("vehiclePhoto")).toHaveLength(0);
  });

  it("fails closed when storage is not configured", async () => {
    state.base = undefined;
    await expect(addVehiclePhoto(actor(), VEH, { key: photoKey() })).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { key: "File storage is not configured." },
    });
  });

  it("a key whose object was never uploaded is refused, for all three kinds, and writes nothing", async () => {
    uploaded.clear();
    for (const [run, message] of [
      [() => addVehiclePhoto(actor(), VEH, { key: photoKey() }), "has not been uploaded"],
      [() => addVehicleDocument(actor(), VEH, { key: docKey(), name: "n", documentType: "OTHER" }), "has not been uploaded"],
      [() => setAuctionSheet(actor(), VEH, { key: sheetKey() }), "has not been uploaded"],
    ] as const) {
      await expect(run()).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { key: expect.stringContaining(message) } });
    }
    expect(fake.rows("vehiclePhoto")).toHaveLength(0);
    expect(fake.rows("vehicleDocument")).toHaveLength(0);
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  it("an object larger than the limit for its kind is refused (10 MB images, 20 MB documents)", async () => {
    uploaded.set(photoKey(), 10 * 1024 * 1024 + 1);
    uploaded.set(docKey(), 20 * 1024 * 1024 + 1);
    await expect(addVehiclePhoto(actor(), VEH, { key: photoKey() })).rejects.toMatchObject({ fieldErrors: { key: expect.stringContaining("10 MB") } });
    await expect(addVehicleDocument(actor(), VEH, { key: docKey(), name: "n", documentType: "OTHER" })).rejects.toMatchObject({ fieldErrors: { key: expect.stringContaining("20 MB") } });
    uploaded.set(photoKey(), 10 * 1024 * 1024); // exactly the limit is fine
    await expect(addVehiclePhoto(actor(), VEH, { key: photoKey() })).resolves.toBeTruthy();
  });

  it("the value stored is built on the server from the key (a client cannot choose the address)", async () => {
    await addVehiclePhoto(actor(), VEH, { key: photoKey() });
    expect(fake.rows("vehiclePhoto")[0]!["url"]).toBe(photoUrl());
  });

  it("rejects a malformed body before touching the database", async () => {
    await rejects(addVehiclePhoto(actor(), VEH, {}), "VALIDATION");
    await rejects(addVehicleDocument(actor(), VEH, { key: docKey(), name: "n", documentType: "NOPE" }), "VALIDATION");
    await rejects(notifyPhotosAdded(actor(), VEH, { count: 0 }), "VALIDATION");
  });
});

describe("the activity log keeps a file's id, kind and name, never its address", () => {
  const everything = () => JSON.stringify(fake.rows("activityLog"));

  it("photo: add and delete", async () => {
    const photo = await addVehiclePhoto(actor(), VEH, { key: photoKey() });
    await deleteVehiclePhoto(actor(), VEH, photo.id);
    const [added, removed] = fake.rows("activityLog");
    expect(added?.["after"]).toEqual({ fileId: photo.id, kind: "VEHICLE_PHOTO", fileName: "a.jpg" });
    expect(removed?.["before"]).toEqual({ fileId: photo.id, kind: "VEHICLE_PHOTO", fileName: "a.jpg" });
    expect(everything()).not.toMatch(/files\.example|org\/|vehicles\/|https?:/);
  });

  it("document: add and delete keep the name the staff member typed too", async () => {
    const doc = await addVehicleDocument(actor(), VEH, { key: docKey(), name: "Invoice", documentType: "SALES_INVOICE" });
    await deleteVehicleDocument(actor(), VEH, doc.id);
    const [added, removed] = fake.rows("activityLog");
    expect(added?.["after"]).toEqual({ fileId: doc.id, kind: "VEHICLE_DOCUMENT", fileName: "d.pdf", name: "Invoice", documentType: "SALES_INVOICE" });
    expect(removed?.["before"]).toEqual({ fileId: doc.id, kind: "VEHICLE_DOCUMENT", fileName: "d.pdf", name: "Invoice" });
    expect(everything()).not.toMatch(/files\.example|org\/|vehicles\/|https?:/);
  });

  it("auction sheet: before and after, and the random id in front of an uploaded name is dropped", async () => {
    uploaded.set(sheetKey("0f8fad5b-d9cb-469f-a165-70867728950e-front-page.jpg"), 10);
    await setAuctionSheet(actor(), VEH, { key: sheetKey("one.jpg") });
    await setAuctionSheet(actor(), VEH, { key: sheetKey("0f8fad5b-d9cb-469f-a165-70867728950e-front-page.jpg") });
    const [first, second] = fake.rows("activityLog");
    expect(first?.["before"]).toBeNull();
    expect(first?.["after"]).toEqual({ fileId: VEH, kind: "AUCTION_SHEET", fileName: "one.jpg" });
    expect(second?.["before"]).toEqual({ fileId: VEH, kind: "AUCTION_SHEET", fileName: "one.jpg" });
    expect(second?.["after"]).toEqual({ fileId: VEH, kind: "AUCTION_SHEET", fileName: "front-page.jpg" });
    expect(everything()).not.toMatch(/files\.example|org\/|vehicles\/|https?:/);
  });
});

describe("photos", () => {
  it("adds a photo with an ActivityLog row, scoped to the caller's org", async () => {
    const photo = await addVehiclePhoto(actor(), VEH, { key: photoKey() });
    // the response carries a short-lived signed link, never the stored address
    expect(photo).toMatchObject({ url: SIGNED(`org/${ORG_A}/vehicles/${VEH}/photos/a.jpg`), expiresAt: expect.any(String), uploaderName: expect.any(String) });
    expect(photo.url).not.toContain(BASE);
    expect(fake.rows("vehiclePhoto")[0]!["url"]).toBe(photoUrl()); // the database still holds the stored address
    expect(fake.rows("vehiclePhoto")).toHaveLength(1);
    expect(fake.rows("activityLog")).toMatchObject([{ org_id: ORG_A, action: "ADD_VEHICLE_PHOTO" }]);
  });

  it("deleting removes the row, logs it, and removes the stored object in the org's folder", async () => {
    const photo = await addVehiclePhoto(actor(), VEH, { key: photoKey() });
    await deleteVehiclePhoto(actor(), VEH, photo.id);
    expect(fake.rows("vehiclePhoto")).toHaveLength(0);
    expect(fake.rows("activityLog").map((r) => r["action"])).toContain("DELETE_VEHICLE_PHOTO");
    // the photo and its small version, both inside the org's folder
    expect(deleted[0]).toBe(`org/${ORG_A}/vehicles/${VEH}/photos/a.jpg`);
    expect(deleted.every((key) => key.startsWith(`org/${ORG_A}/`))).toBe(true);
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
    const photo = await addVehiclePhoto(actor(), VEH, { key: photoKey() });
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
    const doc = await addVehicleDocument(actor({ id: "someone" }), VEH, { key: docKey(), name: "Invoice", documentType: "SALES_INVOICE" });
    expect(doc).toMatchObject({ name: "Invoice", documentType: "SALES_INVOICE" });
    expect(fake.rows("activityLog").map((r) => r["action"])).toEqual(["ADD_VEHICLE_DOCUMENT"]);
    expect(fake.rows("notification").map((r) => r["userId"] ?? r["user_id"]).sort()).toEqual(["mgr_1", "mgr_actor"]);
  });

  it("deletes a document and its own-org object", async () => {
    const doc = await addVehicleDocument(actor(), VEH, { key: docKey(), name: "n", documentType: "OTHER" });
    await deleteVehicleDocument(actor(), VEH, doc.id);
    expect(fake.rows("vehicleDocument")).toHaveLength(0);
    expect(deleted).toEqual([`org/${ORG_A}/vehicles/${VEH}/documents/d.pdf`]);
  });
});

describe("auction sheet", () => {
  it("sets the sheet, logs before/after, and removes the replaced object", async () => {
    await setAuctionSheet(actor(), VEH, { key: sheetKey("one.jpg") });
    const second = await setAuctionSheet(actor(), VEH, { key: sheetKey("two.jpg") });
    expect(second).toEqual({ auctionSheetUrl: SIGNED(`org/${ORG_A}/vehicles/${VEH}/auction-sheet/two.jpg`), auctionSheetExpiresAt: expect.any(String) });
    expect(deleted).toEqual([`org/${ORG_A}/vehicles/${VEH}/auction-sheet/one.jpg`]);
    expect(fake.rows("activityLog")).toHaveLength(2);
  });

  it("setting the same URL again deletes nothing", async () => {
    await setAuctionSheet(actor(), VEH, { key: sheetKey() });
    await setAuctionSheet(actor(), VEH, { key: sheetKey() });
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
    // the server fetches the storage API with a signed link, not the public address
    expect(fetchMock).toHaveBeenCalledWith(SIGNED(`org/${ORG_A}/vehicles/${VEH}/photos/a.jpg`), expect.objectContaining({ redirect: "error", signal: expect.anything() }));
    expect(fetchMock).not.toHaveBeenCalledWith(photoUrl(), expect.anything());
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
        if (url.includes("/bad.jpg?")) throw new TypeError("redirect mode is set to error");
        return image();
      })
    );
    expect((await getVehiclePdfImages(ORG_A, VEH)).photoDataUrls).toHaveLength(1);
  });
});
