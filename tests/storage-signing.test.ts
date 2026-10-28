// Staff uploads (presign) and the customer file gateway. The store is a recorder: no real bucket is ever contacted.

import { Readable, Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { bearerFor, newCustomerFake } from "./helpers/customer-fixtures.js";
import { newVehicleFake } from "./helpers/vehicle-fixtures.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const state = vi.hoisted(() => ({ fake: undefined as unknown, base: "https://files.example.test" as string | undefined, cache: 300 }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), R2_PUBLIC_URL: state.base, CUSTOMER_FILE_CACHE_SECONDS: state.cache }) };
});

import { buildApp } from "../src/app.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { buildObjectKey, deleteObject, safeFileName, setObjectStore, thumbKeyFor, type ObjectStore } from "../src/lib/object-storage.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";
import { authorizeCustomerFile, contentDispositionFor } from "../src/services/customer-file-access.service.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";

const BASE = "https://files.example.test";

// ---- a recording store with a few objects in it
const objects = new Map<string, Buffer>();
const calls = { put: [] as Parameters<ObjectStore["presignPut"]>[0][], get: [] as { key: string; ifNoneMatch?: string }[], del: [] as string[] };
const etagOf = (key: string) => `"etag-${key.length}-${key.at(-5)}"`;
const recorder: ObjectStore = {
  presignGet: async (args) => `https://s3.example.test/${args.key}?X-Amz-Expires=${args.expiresInSeconds}&X-Amz-Signature=test`,
  presignPut: async (args) => (calls.put.push(args), `https://upload.example.test/${args.key}?signed=1`),
  getObject: async (args) => {
    calls.get.push(args);
    const body = objects.get(args.key);
    if (!body) return { kind: "missing" };
    if (args.ifNoneMatch && args.ifNoneMatch === etagOf(args.key)) return { kind: "notModified", etag: etagOf(args.key) };
    return { kind: "found", body: Readable.from([body]), contentLength: body.length, etag: etagOf(args.key) };
  },
  putObject: async (args) => void objects.set(args.key, args.body),
  deleteKey: async (key) => void calls.del.push(key),
};

let app: FastifyInstance;
let fake: FakePrisma;

const staffBearer = async (role: Role, orgId = ORG_A) => ({
  authorization: `Bearer ${await signAccessToken({ sub: "staff_a1", orgId, role, name: `Test ${role}`, email: null })}`,
});
const presign = async (role: Role | null, body: unknown, orgId = ORG_A) =>
  app.inject({ method: "POST", url: "/api/v1/uploads/presign", payload: body as object, headers: role ? await staffBearer(role, orgId) : {} });

beforeEach(async () => {
  fake = newVehicleFake();
  state.fake = fake;
  state.base = BASE;
  state.cache = 300;
  objects.clear();
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
    ["VEHICLE_DOCUMENT", "application/pdf", "documents", "pdf"],
    ["AUCTION_SHEET", "image/png", "auction-sheet", "png"],
    ["VEHICLE_PHOTO", "image/webp", "photos", "webp"],
  ])("a %s goes to its own folder with the extension of its type", async (kind, contentType, folder, extension) => {
    const res = await presign("MANAGER", { ...photoRequest, kind, contentType, fileName: "x.bin" });
    const key = res.json().data.key as string;
    expect(key).toContain(`/vehicles/v_fc_pending/${folder}/`);
    expect(key.endsWith(`.${extension}`)).toBe(true);
  });

  it.each(["x.html", "x.svg", "x.exe", "x.jpg.html", "x", "x.", ".htaccess", "x.JPG", "x.pdf"])(
    "the extension comes from the signed type, never from the file name (%s)",
    async (fileName) => {
      const res = await presign("MANAGER", { ...photoRequest, fileName });
      expect(res.statusCode).toBe(200);
      const key = res.json().data.key as string;
      expect(key.endsWith(".jpg")).toBe(true);
      expect(key).not.toMatch(/\.(html|svg|exe|pdf|htaccess)/i);
    }
  );

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

  describe("content types: only jpeg, png, webp and pdf, exactly", () => {
    it.each([
      "image/svg+xml",
      "image/svg",
      "text/html",
      "application/xhtml+xml",
      "text/xml",
      "application/xml",
      "application/javascript",
      "text/javascript",
      "application/octet-stream",
      "image/gif",
      "image/avif",
      "image/heic",
      "image/tiff",
      "image/bmp",
      "image/jpg",
      "image/x-icon",
      "multipart/form-data",
      "*/*",
      "image/*",
      "IMAGE/JPEG",
      "Image/Jpeg",
      "image/jpeg; charset=utf-8",
      "image/jpeg;",
      " image/jpeg",
      "image/jpeg ",
      "image/jpeg\n",
      "image/jpeg\u0000.html",
      "application/pdf",
    ])("a photo may not be %j", async (contentType) => {
      const res = await presign("MANAGER", { ...photoRequest, contentType });
      expect(res.statusCode).toBe(400);
      expect(calls.put).toHaveLength(0);
    });

    it.each(["image/jpeg", "image/png", "image/webp", "text/html", "image/svg+xml", "application/PDF", "application/pdf; x=1", "application/x-pdf"])(
      "a document may only be application/pdf (not %j unless it is exactly that)",
      async (contentType) => {
        const res = await presign("MANAGER", { ...photoRequest, kind: "VEHICLE_DOCUMENT", contentType });
        expect(res.statusCode, contentType).toBe(400);
        expect(calls.put).toHaveLength(0);
      }
    );

    it.each(["image/jpeg", "image/png", "image/webp"])("an auction sheet or photo may be %s", async (contentType) => {
      for (const kind of ["VEHICLE_PHOTO", "AUCTION_SHEET"]) {
        expect((await presign("MANAGER", { ...photoRequest, kind, contentType })).statusCode, `${kind} ${contentType}`).toBe(200);
      }
    });

    it("a missing or non-string content type is refused", async () => {
      for (const contentType of [undefined, null, 5, ["image/jpeg"], {}]) {
        expect((await presign("MANAGER", { ...photoRequest, contentType })).statusCode).toBe(400);
      }
      expect(calls.put).toHaveLength(0);
    });
  });

  it.each([
    ["a photo over 10 MB", { fileSize: 10 * 1024 * 1024 + 1 }],
    ["a zero size", { fileSize: 0 }],
    ["a negative size", { fileSize: -5 }],
    ["a fractional size", { fileSize: 1.5 }],
    ["a size sent as text", { fileSize: "1000" }],
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

describe("buildObjectKey / safeFileName / thumbKeyFor", () => {
  it("only ever produces keys the URL validator accepts back", () => {
    for (const name of ["a.jpg", "../../x", "a b/c", "‮.png", "", "....", "日本語.jpg"]) {
      const key = buildObjectKey(ORG_A, "VEHICLE_PHOTO", "veh_1", name, "11111111-1111-1111-1111-111111111111", "image/png");
      expect(key).toMatch(/^[A-Za-z0-9._\-/]+$/);
      expect(key.startsWith(`org/${ORG_A}/vehicles/veh_1/photos/`)).toBe(true);
      expect(key.endsWith(".png")).toBe(true);
    }
    expect(safeFileName("")).toBe("file");
  });

  it("the small version of a photo lives beside the photos folder, never inside it", () => {
    expect(thumbKeyFor(`org/${ORG_A}/vehicles/v/photos/a.jpg`)).toBe(`org/${ORG_A}/vehicles/v/photos-thumb/a.jpg`);
    expect(thumbKeyFor(`org/${ORG_A}/vehicles/v/documents/a.pdf`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("customer file gateway: authorise first, then stream", () => {
  const keyOf = (vehicle: string, folder: string, name: string) => `org/${ORG_A}/vehicles/${vehicle}/${folder}/${name}`;
  const urlOf = (key: string) => `${BASE}/${key}`;
  const PHOTO = Buffer.from("fake-jpeg-bytes");
  const PDF = Buffer.from("fake-pdf-bytes");

  const get = async (path: string, as = "cust_a1", orgId = ORG_A, extra: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: `/api/customer/v1${path}`, headers: { ...(await bearerFor(as, orgId)), ...extra } });

  beforeEach(async () => {
    await app.close();
    // The gateway needs the customer fixtures too (cust_a1, cust_a2, cust_b1) next to the vehicle world.
    fake = newVehicleFake();
    for (const row of newCustomerFake().rows("user")) {
      const existing = fake.rows("user").find((u) => u["id"] === row["id"]);
      if (existing) Object.assign(existing, row);
      else fake.seed("user", row);
    }
    state.fake = fake;
    identifierLimiter.reset();
    resetShadowLockouts();
    app = await buildApp({ rateLimit: false });

    // v_fc_pending is released to cust_a1; v_fc_booked_future to cust_a2; v_fl_native is FL; v_b_fc is org B.
    const set = (id: string, over: Record<string, unknown>) => Object.assign(fake.rows("vehicle").find((v) => v["id"] === id)!, over);
    set("v_fc_pending", { customerId: "cust_a1", customerVisible: true });
    set("v_fc_booked_future", { customerId: "cust_a2", customerVisible: true });
    set("v_fc_booked_past", { customerId: "cust_a1", customerVisible: false });
    set("v_fl_native", { customerId: "cust_a1", customerVisible: true });
    set("v_fl_to_export", { customerId: "cust_a1", customerVisible: true });

    const photo = (id: string, vehicle: string, name: string, visible: boolean, extra: Record<string, unknown> = {}) =>
      fake.seed("vehiclePhoto", { id, vehicleId: vehicle, url: urlOf(keyOf(vehicle, "photos", name)), visibleToCustomer: visible, uploadedById: "staff_a1", ...extra });
    const doc = (id: string, vehicle: string, name: string, shown: string, visible: boolean, extra: Record<string, unknown> = {}) =>
      fake.seed("vehicleDocument", { id, vehicleId: vehicle, url: urlOf(keyOf(vehicle, "documents", name)), name: shown, visibleToCustomer: visible, uploadedById: "staff_a1", ...extra });

    photo("ph_ok", "v_fc_pending", "a.jpg", true);
    photo("ph_hidden", "v_fc_pending", "b.jpg", false);
    photo("ph_other_customer", "v_fc_booked_future", "c.jpg", true);
    photo("ph_svg", "v_fc_pending", "d.svg", true);
    photo("ph_pdf_as_photo", "v_fc_pending", "e.pdf", true);
    photo("ph_no_ext", "v_fc_pending", "f", true);
    photo("ph_missing_object", "v_fc_pending", "gone.jpg", true);
    photo("ph_elsewhere", "v_fc_pending", "h.jpg", true, { url: "https://evil.test/h.jpg" });
    photo("ph_other_org_key", "v_fc_pending", "i.jpg", true, { url: `${BASE}/org/${ORG_B}/vehicles/x/photos/i.jpg` });
    doc("doc_ok", "v_fc_pending", "bl.pdf", "Bill of lading", true);
    doc("doc_private", "v_fc_pending", "cost.pdf", "Cost", false);
    doc("doc_unreleased_vehicle", "v_fc_booked_past", "x.pdf", "x", true);
    doc("doc_fl", "v_fl_native", "x.pdf", "x", true);
    doc("doc_fl_exported", "v_fl_to_export", "x.pdf", "Exported", true);
    doc("doc_html", "v_fc_pending", "page.html", "page", true);

    objects.set(keyOf("v_fc_pending", "photos", "a.jpg"), PHOTO);
    objects.set(keyOf("v_fc_pending", "photos", "b.jpg"), PHOTO);
    objects.set(keyOf("v_fc_booked_future", "photos", "c.jpg"), PHOTO);
    objects.set(keyOf("v_fc_pending", "photos", "d.svg"), Buffer.from("<svg onload=alert(1)>"));
    objects.set(keyOf("v_fc_pending", "photos", "e.pdf"), PDF);
    objects.set(keyOf("v_fc_pending", "documents", "bl.pdf"), PDF);
    objects.set(keyOf("v_fc_pending", "documents", "cost.pdf"), PDF);
    objects.set(keyOf("v_fc_pending", "documents", "page.html"), Buffer.from("<script>1</script>"));
    objects.set(keyOf("v_fl_to_export", "documents", "x.pdf"), PDF);
  });

  describe("a photo", () => {
    it("streams the bytes with the safe headers", async () => {
      const res = await get("/photos/ph_ok/image");
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(PHOTO)).toBe(true);
      expect(res.headers["content-type"]).toBe("image/jpeg");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("private, max-age=300");
      expect(res.headers["content-disposition"]).toBe("inline");
      expect(res.headers["etag"]).toBe(etagOf(keyOf("v_fc_pending", "photos", "a.jpg")));
      expect(res.headers["content-length"]).toBe(String(PHOTO.length));
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(res.headers["vary"]).toContain("Authorization");
      expect(calls.get).toHaveLength(1);
    });

    it("the cache lifetime comes from CUSTOMER_FILE_CACHE_SECONDS", async () => {
      state.cache = 0;
      expect((await get("/photos/ph_ok/image")).headers["cache-control"]).toBe("private, max-age=0");
      state.cache = 3600;
      expect((await get("/photos/ph_ok/image")).headers["cache-control"]).toBe("private, max-age=3600");
    });

    it("If-None-Match with the current ETag is a 304 with no body, still private and nosniff", async () => {
      const etag = etagOf(keyOf("v_fc_pending", "photos", "a.jpg"));
      const res = await get("/photos/ph_ok/image", "cust_a1", ORG_A, { "if-none-match": etag });
      expect(res.statusCode).toBe(304);
      expect(res.rawPayload.length).toBe(0);
      expect(res.headers["etag"]).toBe(etag);
      expect(res.headers["cache-control"]).toBe("private, max-age=300");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("a stale If-None-Match gets the full 200", async () => {
      expect((await get("/photos/ph_ok/image", "cust_a1", ORG_A, { "if-none-match": '"old"' })).statusCode).toBe(200);
    });

    it("a 304 is only ever given to the owner: another customer with the same ETag gets a 404 and nothing is read", async () => {
      const etag = etagOf(keyOf("v_fc_pending", "photos", "a.jpg"));
      const res = await get("/photos/ph_ok/image", "cust_a2", ORG_A, { "if-none-match": etag });
      expect(res.statusCode).toBe(404);
      expect(calls.get).toHaveLength(0);
    });

    it("size=thumb serves the small version when it exists, otherwise falls back to the full image", async () => {
      const full = keyOf("v_fc_pending", "photos", "a.jpg");
      const thumb = keyOf("v_fc_pending", "photos-thumb", "a.jpg");
      let res = await get("/photos/ph_ok/image?size=thumb");
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(PHOTO)).toBe(true);
      expect(calls.get.map((c) => c.key)).toEqual([thumb, full]);

      calls.get.length = 0;
      objects.set(thumb, Buffer.from("tiny"));
      res = await get("/photos/ph_ok/image?size=thumb");
      expect(res.rawPayload.toString()).toBe("tiny");
      expect(calls.get.map((c) => c.key)).toEqual([thumb]);
    });

    it("size=full and no size are the same; any other size or extra query parameter is a 400", async () => {
      expect((await get("/photos/ph_ok/image?size=full")).statusCode).toBe(200);
      for (const q of ["size=huge", "size=", "size=thumb&x=1", "orgId=org_b", "key=org/x"]) {
        expect((await get(`/photos/ph_ok/image?${q}`)).statusCode, q).toBe(400);
      }
    });
  });

  describe("a document", () => {
    it("is an attachment with a safe name, nosniff, private caching and its ETag", async () => {
      const res = await get("/documents/doc_ok/file");
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(PDF)).toBe(true);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toBe(`attachment; filename="Bill of lading.pdf"; filename*=UTF-8''Bill%20of%20lading.pdf`);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("private, max-age=300");
      expect(res.headers["etag"]).toBeTruthy();
    });

    it("supports If-None-Match", async () => {
      const etag = etagOf(keyOf("v_fc_pending", "documents", "bl.pdf"));
      expect((await get("/documents/doc_ok/file", "cust_a1", ORG_A, { "if-none-match": etag })).statusCode).toBe(304);
    });

    it("takes no query parameters", async () => {
      expect((await get("/documents/doc_ok/file?size=thumb")).statusCode).toBe(400);
    });

    it("an FL vehicle converted to export counts as an export vehicle", async () => {
      expect((await get("/documents/doc_fl_exported/file")).statusCode).toBe(200);
    });
  });

  describe("every failure is the same 404 and NOTHING is read from the store", () => {
    const cases: [string, string, string?, string?][] = [
      ["a photo staff have not released", "/photos/ph_hidden/image"],
      ["a document staff have not released", "/documents/doc_private/file"],
      ["a photo of another customer in the same org", "/photos/ph_other_customer/image"],
      ["a file on a vehicle not released to the customer", "/documents/doc_unreleased_vehicle/file"],
      ["a file on a local (FL) vehicle", "/documents/doc_fl/file"],
      ["an unknown id", "/photos/nope/image"],
      ["a photo id used as a document id", "/documents/ph_ok/file"],
      ["a document id used as a photo id", "/photos/doc_ok/image"],
      ["an svg stored as a photo", "/photos/ph_svg/image"],
      ["a pdf stored as a photo", "/photos/ph_pdf_as_photo/image"],
      ["a stored file with no extension", "/photos/ph_no_ext/image"],
      ["an html document", "/documents/doc_html/file"],
      ["a stored URL on another host", "/photos/ph_elsewhere/image"],
      ["a stored URL in another org's folder", "/photos/ph_other_org_key/image"],
      ["a path-like id", "/photos/..%2F..%2Fx/image"],
      ["a very long id", `/photos/${"a".repeat(90)}/image`],
    ];

    it.each(cases)("%s", async (_name, path) => {
      const res = await get(path);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "File not found." } });
      expect(calls.get).toHaveLength(0);
    });

    it("all of them look identical to each other", async () => {
      const bodies = new Set<string>();
      for (const [, path] of cases) bodies.add(JSON.stringify((await get(path)).json()));
      expect(bodies.size).toBe(1);
    });

    it("the whole response is identical, status and headers included, and so is an authorised file whose object is missing", async () => {
      const shape = async (path: string) => {
        const res = await get(path);
        const { date: _date, "x-request-id": _id, ...headers } = res.headers as Record<string, string>;
        return JSON.stringify({ status: res.statusCode, headers, body: res.body });
      };
      const shapes = new Set<string>();
      for (const [, path] of cases) shapes.add(await shape(path));
      // an authorised photo whose object is not in the bucket is the same answer too (it does read the store, once)
      calls.get.length = 0;
      shapes.add(await shape("/photos/ph_missing_object/image"));
      expect(calls.get.length).toBeGreaterThan(0);
      expect(shapes.size).toBe(1);
      const only = JSON.parse([...shapes][0]!) as { status: number; headers: Record<string, string> };
      expect(only.status).toBe(404);
      expect(only.headers["cache-control"]).toBe("no-store"); // never cacheable: a 404 must not be remembered as "private"
      expect(only.headers["etag"]).toBeUndefined();
      expect(only.headers["content-disposition"]).toBeUndefined();
    });

    it("other customers and other orgs cannot read the first customer's files", async () => {
      // Another customer in the same org, and a customer of another org: 404. A token naming the wrong org for the
      // account is rejected by the guard itself (401) before any file is looked at.
      for (const [as, org, expected] of [["cust_a2", ORG_A, 404], ["cust_b1", ORG_B, 404], ["cust_a1", ORG_B, 401]] as const) {
        expect((await get("/photos/ph_ok/image", as, org)).statusCode, `${as} ${org}`).toBe(expected);
        expect((await get("/documents/doc_ok/file", as, org)).statusCode, `${as} ${org}`).toBe(expected);
      }
      expect(calls.get).toHaveLength(0);
    });

    it("a vehicle switched back to not released, converted to local, or soft-deleted stops serving", async () => {
      const row = fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!;
      for (const change of [{ customerVisible: false }, { convertedToLocal: true }, { deletedAt: new Date() }]) {
        const saved = { ...row };
        Object.assign(row, change);
        expect((await get("/documents/doc_ok/file")).statusCode, JSON.stringify(change)).toBe(404);
        Object.assign(row, saved);
      }
      expect(calls.get).toHaveLength(0);
    });

    it("a disabled customer account cannot read anything (the guard re-loads the account)", async () => {
      Object.assign(fake.rows("user").find((u) => u["id"] === "cust_a1")!, { loginEnabled: false });
      expect((await get("/photos/ph_ok/image")).statusCode).toBe(401);
      expect(calls.get).toHaveLength(0);
    });
  });

  it("an object that is authorised but missing in storage is the same 404", async () => {
    const res = await get("/photos/ph_missing_object/image");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe("File not found.");
  });

  it("401 without a token, with a staff token, or with a forged one; nothing is read", async () => {
    const staff = await signAccessToken({ sub: "staff_a1", orgId: ORG_A, role: "ADMINISTRATOR", name: "S", email: null });
    for (const headers of [{}, { authorization: `Bearer ${staff}` }, { authorization: "Bearer not.a.token" }]) {
      for (const url of ["/api/customer/v1/photos/ph_ok/image", "/api/customer/v1/documents/doc_ok/file"]) {
        expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(401);
      }
    }
    expect(calls.get).toHaveLength(0);
  });

  it("the same ids on the STAFF API prefix do not exist for customers (the zones are separate)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/photos/ph_ok/image", headers: await bearerFor("cust_a1") });
    expect(res.statusCode).toBe(404);
    expect(calls.get).toHaveLength(0);
  });

  it("a storage error is a generic 500; the key, host and account id are in neither the response nor the log", async () => {
    process.env["R2_ACCOUNT_ID"] = ACCOUNT_ID;
    const lines: string[] = [];
    const noisy = await buildApp({
      rateLimit: false,
      logger: true,
      logStream: new Writable({ write(chunk, _e, done) { lines.push(chunk.toString()); done(); } }),
    });
    const key = keyOf("v_fc_pending", "photos", "a.jpg");
    setObjectStore({
      ...recorder,
      getObject: async () => {
        throw new Error(`connect ECONNREFUSED ${ACCOUNT_ID}.r2.cloudflarestorage.com while reading ${key} from ${BASE}/${key}`);
      },
    });
    try {
      const res = await noisy.inject({ method: "GET", url: "/api/customer/v1/photos/ph_ok/image", headers: await bearerFor("cust_a1") });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: { code: "INTERNAL", message: "Something went wrong." } });
      const everything = `${res.body}${JSON.stringify(res.headers)}${lines.join("")}`;
      for (const secret of [ACCOUNT_ID, "r2.cloudflarestorage.com", `org/${ORG_A}`, "vehicles/v_fc_pending", "a.jpg"]) expect(everything, secret).not.toContain(secret);
      expect(lines.join("")).toContain("unexpected error");
    } finally {
      delete process.env["R2_ACCOUNT_ID"];
      await noisy.close();
    }
  });

  it("with no store configured an authorised file is a generic 500, and an unauthorised one is still a 404", async () => {
    setObjectStore(null);
    expect((await get("/photos/ph_ok/image")).statusCode).toBe(500);
    expect((await get("/photos/ph_hidden/image")).statusCode).toBe(404);
  });

  it("is limited per customer (120 a minute) and the limit answer is the standard 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 122; i++) statuses.push((await get("/photos/ph_ok/image")).statusCode);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(120)).toEqual([429, 429]);
    // another customer is not affected
    expect((await get("/photos/ph_other_customer/image", "cust_a2")).statusCode).toBe(200);
    const limited = await get("/photos/ph_ok/image");
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  }, 60_000);

  it("a failed request still counts toward the per-customer limit", async () => {
    for (let i = 0; i < 120; i++) await get("/photos/nope/image");
    expect((await get("/photos/ph_ok/image")).statusCode).toBe(429);
  }, 60_000);

  it("NO customer response or log line contains an object key, a storage host, the public base or the account id", async () => {
    process.env["R2_ACCOUNT_ID"] = ACCOUNT_ID;
    const lines: string[] = [];
    const noisy = await buildApp({
      rateLimit: false,
      logger: true,
      logStream: new Writable({ write(chunk, _e, done) { lines.push(chunk.toString()); done(); } }),
    });
    const consoleOutput: string[] = [];
    for (const m of ["warn", "error", "log", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleOutput.push(a.map(String).join(" ")));
    try {
      const headers = await bearerFor("cust_a1");
      const responses = [];
      for (const [method, url, payload] of [
        ["GET", "/photos/ph_ok/image", undefined],
        ["GET", "/photos/ph_ok/image?size=thumb", undefined],
        ["GET", "/documents/doc_ok/file", undefined],
        ["GET", "/photos/ph_hidden/image", undefined],
        ["GET", "/documents/doc_private/file", undefined],
        ["GET", "/photos/ph_missing_object/image", undefined],
        ["GET", "/photos/ph_elsewhere/image", undefined],
        ["GET", "/photos/ph_other_org_key/image", undefined],
        ["GET", "/photos/nope/image?size=bad", undefined],
        ["GET", "/me", undefined],
        ["PATCH", "/me", { name: "Renamed Customer" }],
      ] as const) {
        responses.push(await noisy.inject({ method, url: `/api/customer/v1${url}`, headers, ...(payload ? { payload } : {}) }));
      }
      responses.push(await noisy.inject({ method: "POST", url: "/api/customer/v1/auth/login", payload: { email: "a1@example.test", password: "wrong-example-password" } }));

      const binary = new Set([PHOTO.toString(), PDF.toString()]);
      const text = responses.map((r) => (binary.has(r.body) ? "" : r.body) + JSON.stringify(r.headers)).join("\n");
      const everything = `${text}\n${lines.join("")}\n${consoleOutput.join("\n")}`;
      const forbidden = ["org/", ORG_A + "/", "vehicles/v_", "/photos/", "/documents/bl", "r2.cloudflarestorage", "cloudflarestorage", ACCOUNT_ID, "files.example.test", "photos-thumb"];
      // The log carries the route PATTERN ("/photos/:photoId/image"), which legitimately contains "/photos/"; strip those.
      const scrubbed = everything.replace(/\/api\/customer\/v1\/(photos|documents)\/:?[A-Za-z0-9_%.-]*\/(image|file)/g, "[route]");
      for (const secret of forbidden) expect(scrubbed, secret).not.toContain(secret);
      expect(lines.join("").length).toBeGreaterThan(0);
    } finally {
      delete process.env["R2_ACCOUNT_ID"];
      await noisy.close();
    }
  });
});

describe("Content-Disposition for documents", () => {
  it("strips quotes, slashes and control characters, keeps a real extension, and adds an RFC 5987 name", () => {
    expect(contentDispositionFor("application/pdf", 'Bill "of" lading/..\\x\u0000\n')).toBe(
      `attachment; filename="Bill of lading..x.pdf"; filename*=UTF-8''Bill%20of%20lading..x.pdf`
    );
    expect(contentDispositionFor("application/pdf", "already.PDF")).toContain('filename="already.PDF"');
    expect(contentDispositionFor("application/pdf", "")).toContain('filename="document.pdf"');
    expect(contentDispositionFor("application/pdf", null)).toContain('filename="document.pdf"');
  });

  it("non-ASCII names keep an ASCII fallback and a UTF-8 name", () => {
    const header = contentDispositionFor("application/pdf", "請求書 #1.pdf");
    expect(header).toContain('filename="___ _1.pdf"'.replace("___ _1", "___ _1"));
    expect(header).toContain("filename*=UTF-8''%E8%AB%8B%E6%B1%82%E6%9B%B8%20%231.pdf");
    expect(header).toMatch(/^[\x20-\x7e]+$/);
  });

  it("images are inline and carry no file name", () => {
    expect(contentDispositionFor("image/png", "anything.png")).toBe("inline");
  });
});

describe("authorizeCustomerFile never touches the store", () => {
  it("even for an allowed file", async () => {
    fake = newVehicleFake();
    state.fake = fake;
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!, { customerId: "cust_a1", customerVisible: true });
    fake.seed("vehicleDocument", { id: "d1", vehicleId: "v_fc_pending", url: `${BASE}/org/${ORG_A}/vehicles/v_fc_pending/documents/x.pdf`, name: "x", visibleToCustomer: true, uploadedById: "staff_a1" });
    expect((await authorizeCustomerFile({ id: "cust_a1", orgId: ORG_A }, "document", "d1")).contentType).toBe("application/pdf");
    expect(calls.get).toHaveLength(0);
  });
});

describe("deleting stored files goes through the store when there is one", () => {
  it("deleteObject calls the store", async () => {
    await deleteObject(`org/${ORG_A}/vehicles/v/photos/a.jpg`);
    expect(calls.del).toEqual([`org/${ORG_A}/vehicles/v/photos/a.jpg`]);
  });
});
