// Presign (uploads) and signed downloads. The store is a recorder: no real bucket is ever contacted.

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { newVehicleFake } from "./helpers/vehicle-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown, base: "https://files.example.test" as string | undefined, ttl: 600 }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), R2_PUBLIC_URL: state.base, SIGNED_URL_TTL_SECONDS: state.ttl }) };
});

import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { buildObjectKey, deleteObject, safeFileName, setObjectStore, signedDownloadUrl, type ObjectStore } from "../src/lib/object-storage.js";
import { authorizeCustomerFile, signedUrlForCustomerFile } from "../src/services/customer-file-access.service.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";

const BASE = "https://files.example.test";
let app: FastifyInstance;
let fake: FakePrisma;
const calls = { put: [] as Parameters<ObjectStore["presignPut"]>[0][], get: [] as Parameters<ObjectStore["presignGet"]>[0][], del: [] as string[] };
const recorder: ObjectStore = {
  presignPut: async (args) => (calls.put.push(args), `https://upload.example.test/${args.key}?signed=1`),
  presignGet: async (args) => (calls.get.push(args), `https://download.example.test/${args.key}?signed=1&ttl=${args.expiresInSeconds}`),
  deleteKey: async (key) => void calls.del.push(key),
};

const bearer = async (role: Role, orgId = ORG_A) => ({
  authorization: `Bearer ${await signAccessToken({ sub: "staff_a1", orgId, role, name: `Test ${role}`, email: null })}`,
});
const presign = async (role: Role | null, body: unknown, orgId = ORG_A) =>
  app.inject({ method: "POST", url: "/api/v1/uploads/presign", payload: body as object, headers: role ? await bearer(role, orgId) : {} });

beforeEach(async () => {
  fake = newVehicleFake();
  state.fake = fake;
  state.base = BASE;
  state.ttl = 600;
  calls.put.length = 0;
  calls.get.length = 0;
  calls.del.length = 0;
  setObjectStore(recorder);
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  setObjectStore(null);
  await app.close();
});

const photoRequest = { vehicleId: "v_fc_pending", kind: "VEHICLE_PHOTO", fileName: "front view.jpg", contentType: "image/jpeg", fileSize: 1_000_000 };

describe("POST /uploads/presign", () => {
  it("401 without a token; 403 for a viewer; allowed for administrator, manager and operator", async () => {
    expect((await presign(null, photoRequest)).statusCode).toBe(401);
    expect((await presign("VIEWER", photoRequest)).statusCode).toBe(403);
    for (const role of ["ADMINISTRATOR", "MANAGER", "OPERATOR"] as const) expect((await presign(role, photoRequest)).statusCode, role).toBe(200);
  });

  it("authorises BEFORE signing: another org's, a deleted and an unknown vehicle are 404 and nothing is signed", async () => {
    for (const vehicleId of ["v_b_fc", "v_fc_deleted", "nope"]) {
      expect((await presign("ADMINISTRATOR", { ...photoRequest, vehicleId })).statusCode, vehicleId).toBe(404);
    }
    expect((await presign("ADMINISTRATOR", photoRequest, ORG_B)).statusCode).toBe(404);
    expect(calls.put).toHaveLength(0);
  });

  it("signs for 300 seconds, pins the exact size and type, and keeps the key inside the vehicle's folder for that kind", async () => {
    const res = await presign("MANAGER", photoRequest);
    const data = res.json().data;
    expect(Object.keys(data).sort()).toEqual(["expiresInSeconds", "headers", "key", "publicUrl", "uploadUrl"]);
    expect(data.expiresInSeconds).toBe(300);
    expect(data.key).toMatch(new RegExp(`^org/${ORG_A}/vehicles/v_fc_pending/photos/[0-9a-f-]{36}-front-view\\.jpg$`));
    expect(data.publicUrl).toBe(`${BASE}/${data.key}`);
    expect(data.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(calls.put).toEqual([{ key: data.key, contentType: "image/jpeg", contentLength: 1_000_000, expiresInSeconds: 300 }]);
  });

  it.each([
    ["VEHICLE_DOCUMENT", "application/pdf", "documents"],
    ["AUCTION_SHEET", "image/png", "auction-sheet"],
  ])("a %s goes to its own folder", async (kind, contentType, folder) => {
    const res = await presign("MANAGER", { ...photoRequest, kind, contentType, fileName: "x.bin" });
    expect(res.json().data.key).toContain(`/vehicles/v_fc_pending/${folder}/`);
  });

  it("without a vehicle (a new vehicle being created) the key is in this org's staging area", async () => {
    const res = await presign("MANAGER", { kind: "VEHICLE_PHOTO", fileName: "a.jpg", contentType: "image/jpeg", fileSize: 10 });
    expect(res.json().data.key).toMatch(new RegExp(`^org/${ORG_A}/uploads/staging/`));
  });

  it("the client cannot choose the key, the org or the bucket", async () => {
    const res = await presign("MANAGER", { ...photoRequest, key: `org/${ORG_B}/vehicles/x/photos/evil.jpg`, orgId: ORG_B, bucket: "other" });
    expect(res.statusCode).toBe(200);
    expect(calls.put[0]!.key.startsWith(`org/${ORG_A}/vehicles/v_fc_pending/photos/`)).toBe(true);
    expect(JSON.stringify(calls.put)).not.toContain(ORG_B);
  });

  it.each([
    ["a path-traversal file name", "../../../etc/passwd.jpg"],
    ["a name with slashes, spaces and unicode", "a/b c\u0000‮.jpg"],
    ["a very long name", `${"x".repeat(240)}.jpg`],
  ])("a file name with %s becomes a safe key segment", async (_n, fileName) => {
    const res = await presign("MANAGER", { ...photoRequest, fileName });
    expect(res.statusCode).toBe(200);
    const key = res.json().data.key as string;
    expect(key).toMatch(/^[A-Za-z0-9._\-/]+$/);
    expect(key).not.toContain("..");
    expect(key.split("/")).toHaveLength(6);
    expect(key.length).toBeLessThan(250);
  });

  it.each([
    ["an unsupported type for a photo", { contentType: "application/pdf" }],
    ["an svg", { contentType: "image/svg+xml" }],
    ["a photo over 10 MB", { fileSize: 10 * 1024 * 1024 + 1 }],
    ["a zero size", { fileSize: 0 }],
    ["a fractional size", { fileSize: 1.5 }],
    ["a document that is not a pdf", { kind: "VEHICLE_DOCUMENT", contentType: "image/png" }],
    ["a document over 20 MB", { kind: "VEHICLE_DOCUMENT", contentType: "application/pdf", fileSize: 20 * 1024 * 1024 + 1 }],
    ["an unknown kind", { kind: "SECRET" }],
    ["a missing file name", { fileName: "" }],
  ])("rejects %s with 400 and signs nothing", async (_n, over) => {
    const res = await presign("MANAGER", { ...photoRequest, ...over });
    expect(res.statusCode).toBe(400);
    expect(calls.put).toHaveLength(0);
  });

  it("accepts the limits exactly (10 MB image, 20 MB pdf)", async () => {
    expect((await presign("MANAGER", { ...photoRequest, fileSize: 10 * 1024 * 1024 })).statusCode).toBe(200);
    expect((await presign("MANAGER", { ...photoRequest, kind: "VEHICLE_DOCUMENT", contentType: "application/pdf", fileSize: 20 * 1024 * 1024 })).statusCode).toBe(200);
  });

  it("fails closed when storage is not configured (no public base, or no store)", async () => {
    state.base = undefined;
    expect((await presign("MANAGER", photoRequest)).statusCode).toBe(400);
    state.base = BASE;
    setObjectStore(null);
    const res = await presign("MANAGER", photoRequest);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("File storage is not configured.");
  });
});

describe("buildObjectKey / safeFileName", () => {
  it("only ever produces keys the URL validator accepts back", () => {
    for (const name of ["a.jpg", "../../x", "a b/c", "‮.png", "", "....", "日本語.jpg"]) {
      const key = buildObjectKey(ORG_A, "VEHICLE_PHOTO", "veh_1", name, "11111111-1111-1111-1111-111111111111");
      expect(key).toMatch(/^[A-Za-z0-9._\-/]+$/);
      expect(key.startsWith(`org/${ORG_A}/vehicles/veh_1/photos/`)).toBe(true);
    }
    expect(safeFileName("")).toBe("file");
  });
});

// ---------------------------------------------------------------------------------------------

describe("customer downloads: authorise first, then sign", () => {
  const ME = { id: "cust_a1", orgId: ORG_A };
  const keyOf = (vehicle: string, folder: string, name: string) => `org/${ORG_A}/vehicles/${vehicle}/${folder}/${name}`;

  beforeEach(() => {
    // v_fc_pending is released to cust_a1; v_fc_booked_future to cust_a2; v_fl_native is FL; v_b_fc is org B.
    const set = (id: string, over: Record<string, unknown>) => Object.assign(fake.rows("vehicle").find((v) => v["id"] === id)!, over);
    set("v_fc_pending", { customerId: "cust_a1", customerVisible: true });
    set("v_fc_booked_future", { customerId: "cust_a2", customerVisible: true });
    set("v_fc_booked_past", { customerId: "cust_a1", customerVisible: false });
    set("v_fl_native", { customerId: "cust_a1", customerVisible: true });
    set("v_fl_to_export", { customerId: "cust_a1", customerVisible: true });
    fake.seed(
      "vehiclePhoto",
      { id: "ph_ok", vehicleId: "v_fc_pending", url: `${BASE}/${keyOf("v_fc_pending", "photos", "a.jpg")}`, visibleToCustomer: true, uploadedById: "staff_a1" },
      { id: "ph_hidden", vehicleId: "v_fc_pending", url: `${BASE}/${keyOf("v_fc_pending", "photos", "b.jpg")}`, visibleToCustomer: false, uploadedById: "staff_a1" },
      { id: "ph_other_customer", vehicleId: "v_fc_booked_future", url: `${BASE}/${keyOf("v_fc_booked_future", "photos", "c.jpg")}`, visibleToCustomer: true, uploadedById: "staff_a1" }
    );
    fake.seed(
      "vehicleDocument",
      { id: "doc_ok", vehicleId: "v_fc_pending", url: `${BASE}/${keyOf("v_fc_pending", "documents", "bl.pdf")}`, name: "Bill of lading.pdf", visibleToCustomer: true, uploadedById: "staff_a1" },
      { id: "doc_private", vehicleId: "v_fc_pending", url: `${BASE}/${keyOf("v_fc_pending", "documents", "cost.pdf")}`, name: "Cost.pdf", visibleToCustomer: false, uploadedById: "staff_a1" },
      { id: "doc_unreleased_vehicle", vehicleId: "v_fc_booked_past", url: `${BASE}/${keyOf("v_fc_booked_past", "documents", "x.pdf")}`, name: "x.pdf", visibleToCustomer: true, uploadedById: "staff_a1" },
      { id: "doc_fl", vehicleId: "v_fl_native", url: `${BASE}/${keyOf("v_fl_native", "documents", "x.pdf")}`, name: "x.pdf", visibleToCustomer: true, uploadedById: "staff_a1" },
      { id: "doc_fl_exported", vehicleId: "v_fl_to_export", url: `${BASE}/${keyOf("v_fl_to_export", "documents", "x.pdf")}`, name: "Exported.pdf", visibleToCustomer: true, uploadedById: "staff_a1" },
      { id: "doc_b", vehicleId: "v_b_fc", url: `https://files.example.test/org/${ORG_B}/vehicles/v_b_fc/documents/b.pdf`, name: "b.pdf", visibleToCustomer: true, uploadedById: "staff_b1" }
    );
  });

  it("a released document of the customer's own export vehicle gets a link that lives the configured time", async () => {
    const result = await signedUrlForCustomerFile(ME, "document", "doc_ok");
    expect(result.expiresInSeconds).toBe(600);
    expect(result.url).toContain(keyOf("v_fc_pending", "documents", "bl.pdf"));
    expect(calls.get).toEqual([{ key: keyOf("v_fc_pending", "documents", "bl.pdf"), expiresInSeconds: 600, downloadName: "Bill of lading.pdf" }]);
  });

  it("the lifetime comes from SIGNED_URL_TTL_SECONDS", async () => {
    state.ttl = 300;
    expect((await signedUrlForCustomerFile(ME, "photo", "ph_ok")).expiresInSeconds).toBe(300);
    state.ttl = 900;
    expect((await signedUrlForCustomerFile(ME, "photo", "ph_ok")).expiresInSeconds).toBe(900);
    expect(calls.get.map((c) => c.expiresInSeconds)).toEqual([300, 900]);
  });

  it("photos are released by default; a hidden one is not", async () => {
    expect((await signedUrlForCustomerFile(ME, "photo", "ph_ok")).url).toContain("a.jpg");
    await expect(signedUrlForCustomerFile(ME, "photo", "ph_hidden")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each([
    ["a document staff have not released", "document", "doc_private"],
    ["a file of another customer in the same org", "photo", "ph_other_customer"],
    ["a file of another organisation", "document", "doc_b"],
    ["a file on a vehicle not released to the customer", "document", "doc_unreleased_vehicle"],
    ["a file on a local (FL) vehicle", "document", "doc_fl"],
    ["an unknown id", "document", "nope"],
    ["a photo id used as a document id", "document", "ph_ok"],
  ])("%s is the same 404, and NOTHING is signed", async (_n, kind, id) => {
    await expect(signedUrlForCustomerFile(ME, kind as "photo" | "document", id)).rejects.toMatchObject({ code: "NOT_FOUND", message: "File not found." });
    expect(calls.get).toHaveLength(0);
  });

  it("an FL vehicle converted to export counts as an export vehicle", async () => {
    expect((await signedUrlForCustomerFile(ME, "document", "doc_fl_exported")).url).toContain("x.pdf");
  });

  it("an FC vehicle converted to local stops being visible", async () => {
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!, { convertedToLocal: true });
    await expect(signedUrlForCustomerFile(ME, "document", "doc_ok")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.get).toHaveLength(0);
  });

  it("a soft-deleted vehicle's files are gone, and so is a vehicle switched back to not released", async () => {
    const row = fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!;
    row["customerVisible"] = false;
    await expect(signedUrlForCustomerFile(ME, "document", "doc_ok")).rejects.toMatchObject({ code: "NOT_FOUND" });
    row["customerVisible"] = true;
    row["deletedAt"] = new Date();
    await expect(signedUrlForCustomerFile(ME, "document", "doc_ok")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.get).toHaveLength(0);
  });

  it("other customers and other orgs get 404 for the first customer's files", async () => {
    for (const other of [{ id: "cust_a2", orgId: ORG_A }, { id: "cust_b1", orgId: ORG_B }, { id: "cust_a1", orgId: ORG_B }]) {
      await expect(signedUrlForCustomerFile(other, "document", "doc_ok"), JSON.stringify(other)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(calls.get).toHaveLength(0);
  });

  it("a stored URL that points outside the org's folder (old data) is refused, not signed", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "https://evil.test/a.pdf", `${BASE}/org/${ORG_B}/vehicles/x/documents/b.pdf`, `${BASE}/org/${ORG_A}/../${ORG_B}/b.pdf`]) {
      fake.rows("vehicleDocument").find((d) => d["id"] === "doc_ok")!["url"] = url;
      await expect(signedUrlForCustomerFile(ME, "document", "doc_ok"), url).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(calls.get).toHaveLength(0);
  });

  it("authorizeCustomerFile alone never calls the store", async () => {
    await authorizeCustomerFile(ME, "document", "doc_ok");
    expect(calls.get).toHaveLength(0);
  });

  it("signedDownloadUrl itself refuses a key outside the org folder, a last line of defence", async () => {
    await expect(signedDownloadUrl(ORG_A, `org/${ORG_B}/vehicles/x/documents/b.pdf`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(signedDownloadUrl(ORG_A, `org/${ORG_A}/../x`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.get).toHaveLength(0);
  });

  it("with no store configured nothing is signed", async () => {
    setObjectStore(null);
    await expect(signedUrlForCustomerFile(ME, "document", "doc_ok")).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("deleting stored files goes through the store when there is one", () => {
  it("deleteObject calls the store", async () => {
    await deleteObject(`org/${ORG_A}/vehicles/v/photos/a.jpg`);
    expect(calls.del).toEqual([`org/${ORG_A}/vehicles/v/photos/a.jpg`]);
  });
});
