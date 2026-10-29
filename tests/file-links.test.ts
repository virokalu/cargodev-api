// Temporary file links on our own domain (ADR 0007): the format, issuing, serving (GET /f/v1/:kind/:id/:variant), and every way a link
// can be refused. Every refusal must be the SAME 404. Fake data only.

import { createHash, createHmac } from "node:crypto";
import { Readable, Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { newCustomerFake } from "./helpers/customer-fixtures.js";
import { newVehicleFake } from "./helpers/vehicle-fixtures.js";

const SECRET = "link-secret-value-for-tests-0123456789abcdef";
const PREVIOUS = "older-link-secret-value-for-tests-0123456789ab";
const BASE = "https://files.example.test"; // the stored-address base (R2_PUBLIC_URL), NOT the link host
const LINK_HOST = "https://api.example.test";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "cargodev-fake-files";

const state = vi.hoisted(() => ({
  fake: undefined as unknown,
  secret: undefined as string | undefined,
  previous: undefined as string | undefined,
  base: undefined as string | undefined,
  ttl: 300,
  max: 900,
  cache: 0,
}));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      R2_PUBLIC_URL: "https://files.example.test",
      R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      R2_BUCKET_NAME: "cargodev-fake-files",
      FILE_LINK_SECRET: state.secret,
      FILE_LINK_SECRET_PREVIOUS: state.previous,
      FILE_LINK_BASE_URL: state.base,
      FILE_LINK_TTL_SECONDS: state.ttl,
      FILE_LINK_MAX_TTL_SECONDS: state.max,
      STAFF_AUTH_CACHE_SECONDS: state.cache,
    }),
  };
});

import { buildApp } from "../src/app.js";
import { signParts, type FileLinkAudience, type FileLinkKind, type FileLinkParts, type FileLinkVariant } from "../src/lib/file-link.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { setObjectStore, type ObjectStore } from "../src/lib/object-storage.js";
import { redactSecrets } from "../src/lib/redact.js";
import { FILE_LINK_RATE_LIMIT } from "../src/config/file-link-rate-limits.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { issueFileLink, parseSingleRange } from "../src/services/file-link.service.js";
import { clearStaffAuthCache } from "../src/services/staff-auth-state.service.js";
import { setStaffActive } from "../src/services/user.service.js";

// ---------------------------------------------------------------------------------------------
// The storage double: a few objects, ETags, ranges, and a record of what was read.

const objects = new Map<string, Buffer>();
const reads: string[] = [];
let streamsOpened: Readable[] = [];
let storeOverride: ObjectStore["getObject"] | null = null;
// Like a real store: a hash, not something made of the key.
const etagOf = (key: string) => `"${createHash("md5").update(key).digest("hex")}"`;

const store: ObjectStore = {
  presignPut: async () => "https://upload.example.test/x",
  getObject: async (args) => {
    if (storeOverride) return storeOverride(args);
    reads.push(args.key);
    const body = objects.get(args.key);
    if (!body) return { kind: "missing" };
    if (args.ifNoneMatch && args.ifNoneMatch === etagOf(args.key)) return { kind: "notModified", etag: etagOf(args.key) };
    let slice = body;
    let contentRange: string | null = null;
    if (args.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(args.range)!;
      const start = m[1] === "" ? Math.max(0, body.length - Number(m[2])) : Number(m[1]);
      const end = m[1] === "" || m[2] === "" ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
      if (start >= body.length) return { kind: "rangeNotSatisfiable" };
      slice = body.subarray(start, end + 1);
      contentRange = `bytes ${start}-${start + slice.length - 1}/${body.length}`;
    }
    const stream = Readable.from([slice]);
    streamsOpened.push(stream);
    return { kind: "found", body: stream, contentLength: slice.length, etag: etagOf(args.key), contentRange };
  },
  putObject: async () => undefined,
  deleteKey: async () => undefined,
};

// ---------------------------------------------------------------------------------------------

let app: FastifyInstance;
let fake: FakePrisma;
const PHOTO = Buffer.from("fake-jpeg-bytes-0123456789");
const PDF = Buffer.from("%PDF-fake-pdf-bytes-0123456789");
const SHEET = Buffer.from("fake-auction-sheet-bytes");
const keyOf = (vehicle: string, folder: string, name: string) => `org/${ORG_A}/vehicles/${vehicle}/${folder}/${name}`;
const urlOf = (key: string) => `${BASE}/${key}`;
const STAFF = "staff_link";
const CUSTOMER = "cust_a1";

const nowSeconds = () => Math.floor(Date.now() / 1000);
const pathOf = (absolute: string) => {
  const u = new URL(absolute);
  return `${u.pathname}${u.search}`;
};
const get = (path: string, headers: Record<string, string> = {}, remoteAddress?: string) =>
  app.inject({ method: "GET", url: path, headers, ...(remoteAddress ? { remoteAddress } : {}) });

const staffContext = (userId = STAFF, orgId = ORG_A) => ({ orgId, userId, audience: "staff" as FileLinkAudience });
const customerContext = (userId = CUSTOMER, orgId = ORG_A) => ({ orgId, userId, audience: "customer" as FileLinkAudience });
const issue = (context: ReturnType<typeof staffContext>, kind: FileLinkKind, id: string, variant: FileLinkVariant = "full") => {
  const link = issueFileLink(context, kind, id, variant);
  if (!link) throw new Error("links are not configured in this test");
  return { ...link, path: pathOf(link.url) };
};

/** A link made by hand with any parts, signed with any secret: for the cases the service would never issue. */
function handmade(parts: Partial<FileLinkParts> & { secret?: string }): string {
  const full: FileLinkParts = { kind: "photo", id: "ph_ok", variant: "full", orgId: ORG_A, userId: STAFF, audience: "staff", exp: nowSeconds() + 300, ...parts };
  const sig = signParts(parts.secret ?? SECRET, full);
  return `/f/v1/${full.kind}/${full.id}/${full.variant}?o=${full.orgId}&u=${full.userId}&a=${full.audience}&exp=${full.exp}&sig=${sig}`;
}

const header = (res: { headers: Record<string, unknown> }, name: string) => String(res.headers[name] ?? "");
const withoutDate = (headers: Record<string, unknown>) => {
  const { date: _date, ...rest } = headers;
  return rest;
};

beforeEach(async () => {
  state.secret = SECRET;
  state.previous = undefined;
  state.base = LINK_HOST;
  state.ttl = 300;
  state.max = 900;
  state.cache = 0;
  clearStaffAuthCache();
  identifierLimiter.reset();
  objects.clear();
  reads.length = 0;
  streamsOpened = [];
  storeOverride = null;

  // The vehicle world, plus the customer fixtures (cust_a1, cust_a2, cust_b1), plus staff.
  fake = newVehicleFake();
  for (const row of newCustomerFake().rows("user")) {
    const existing = fake.rows("user").find((u) => u["id"] === row["id"]);
    if (existing) Object.assign(existing, row);
    else fake.seed("user", row);
  }
  fake.seed(
    "user",
    { id: STAFF, org_id: ORG_A, userType: "STAFF", name: "Link Manager", email: "link.manager@example.test", role: "MANAGER", loginEnabled: true },
    { id: "staff_super", org_id: ORG_A, userType: "STAFF", name: "Administrator", email: "super@example.test", role: "ADMINISTRATOR", loginEnabled: true },
    { id: "staff_off", org_id: ORG_A, userType: "STAFF", name: "Off", email: "off@example.test", role: "MANAGER", loginEnabled: false },
    { id: "staff_b", org_id: ORG_B, userType: "STAFF", name: "Other Org", email: "b@example.test", role: "MANAGER", loginEnabled: true }
  );
  state.fake = fake;
  const set = (id: string, over: Record<string, unknown>) => Object.assign(fake.rows("vehicle").find((v) => v["id"] === id)!, over);
  set("v_fc_pending", { customerId: CUSTOMER, customerVisible: true, auctionSheetUrl: urlOf(keyOf("v_fc_pending", "auction-sheet", "s.jpg")) });
  set("v_fc_booked_future", { customerId: "cust_a2", customerVisible: true });
  fake.seed("vehiclePhoto", { id: "ph_ok", vehicleId: "v_fc_pending", url: urlOf(keyOf("v_fc_pending", "photos", "a.jpg")), visibleToCustomer: true, uploadedById: STAFF });
  fake.seed("vehiclePhoto", { id: "ph_hidden", vehicleId: "v_fc_pending", url: urlOf(keyOf("v_fc_pending", "photos", "b.jpg")), visibleToCustomer: false, uploadedById: STAFF });
  fake.seed("vehiclePhoto", { id: "ph_other_customer", vehicleId: "v_fc_booked_future", url: urlOf(keyOf("v_fc_booked_future", "photos", "c.jpg")), visibleToCustomer: true, uploadedById: STAFF });
  fake.seed("vehiclePhoto", { id: "ph_missing_object", vehicleId: "v_fc_pending", url: urlOf(keyOf("v_fc_pending", "photos", "gone.jpg")), visibleToCustomer: true, uploadedById: STAFF });
  fake.seed("vehiclePhoto", { id: "ph_other_org", vehicleId: "v_b_fc", url: `${BASE}/org/${ORG_B}/vehicles/v_b_fc/photos/z.jpg`, visibleToCustomer: true, uploadedById: "staff_b" });
  fake.seed("vehiclePhoto", { id: "ph_elsewhere", vehicleId: "v_fc_pending", url: "https://evil.test/a.jpg", visibleToCustomer: true, uploadedById: STAFF });
  fake.seed("vehiclePhoto", { id: "ph_pdf_as_photo", vehicleId: "v_fc_pending", url: urlOf(keyOf("v_fc_pending", "photos", "e.pdf")), visibleToCustomer: true, uploadedById: STAFF });
  fake.seed("vehicleDocument", { id: "doc_ok", vehicleId: "v_fc_pending", url: urlOf(keyOf("v_fc_pending", "documents", "bl.pdf")), name: "Bill of lading", documentType: "BL", visibleToCustomer: true, uploadedById: STAFF });
  fake.seed("vehicleDocument", { id: "doc_private", vehicleId: "v_fc_pending", url: urlOf(keyOf("v_fc_pending", "documents", "cost.pdf")), name: "Cost", documentType: "OTHER", visibleToCustomer: false, uploadedById: STAFF });
  objects.set(keyOf("v_fc_pending", "photos", "a.jpg"), PHOTO);
  objects.set(keyOf("v_fc_pending", "photos", "b.jpg"), PHOTO);
  objects.set(keyOf("v_fc_booked_future", "photos", "c.jpg"), PHOTO);
  objects.set(keyOf("v_fc_pending", "photos", "e.pdf"), PDF);
  objects.set(keyOf("v_fc_pending", "documents", "bl.pdf"), PDF);
  objects.set(keyOf("v_fc_pending", "documents", "cost.pdf"), PDF);
  objects.set(keyOf("v_fc_pending", "auction-sheet", "s.jpg"), SHEET);
  objects.set("a.jpg", PHOTO); // what the path of https://evil.test/a.jpg would be if an address were cut at its host
  setObjectStore(store);
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await app.close();
  setObjectStore(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe("the link format", () => {
  it("is <base>/f/v1/<kind>/<id>/<variant>?o=&u=&a=&exp=&sig= with the signature over v1|kind|id|variant|o|u|a|exp", () => {
    const link = issueFileLink(staffContext(), "photo", "ph_ok", "thumb", 1_800_000_000_000)!;
    const exp = 1_800_000_000 + 300;
    const expected = createHmac("sha256", SECRET).update(`v1|photo|ph_ok|thumb|${ORG_A}|${STAFF}|staff|${exp}`).digest("base64url");
    expect(link.url).toBe(`${LINK_HOST}/f/v1/photo/ph_ok/thumb?o=${ORG_A}&u=${STAFF}&a=staff&exp=${exp}&sig=${expected}`);
    expect(link.expiresAt).toBe(new Date(exp * 1000).toISOString());
  });

  it.each([
    ["photo", "ph_ok"],
    ["document", "doc_ok"],
    ["auction-sheet", "v_fc_pending"],
  ] as const)("a %s link carries database ids only: no key, bucket, storage host or account id", (kind, id) => {
    const { url } = issue(staffContext(), kind, id);
    expect(url).toMatch(new RegExp(`^${LINK_HOST}/f/v1/${kind}/${id}/full\\?o=${ORG_A}&u=${STAFF}&a=staff&exp=\\d+&sig=[A-Za-z0-9_-]{43}$`));
    for (const forbidden of [ACCOUNT, BUCKET, "r2.dev", "cloudflarestorage", "files.example.test", "org/", "/vehicles/", "a.jpg", "bl.pdf", "X-Amz"]) expect(url, forbidden).not.toContain(forbidden);
  });

  it("lives FILE_LINK_TTL_SECONDS, and never longer than FILE_LINK_MAX_TTL_SECONDS", () => {
    state.ttl = 120;
    expect(Date.parse(issue(staffContext(), "photo", "ph_ok").expiresAt) - Date.now()).toBeGreaterThan(115_000);
    expect(Date.parse(issue(staffContext(), "photo", "ph_ok").expiresAt) - Date.now()).toBeLessThanOrEqual(121_000);
    state.ttl = 600;
    state.max = 60;
    expect(Date.parse(issue(staffContext(), "photo", "ph_ok").expiresAt) - Date.now()).toBeLessThanOrEqual(61_000);
  });

  it("is not issued when the secret or the base address is missing", () => {
    state.secret = undefined;
    expect(issueFileLink(staffContext(), "photo", "ph_ok", "full")).toBeNull();
    state.secret = SECRET;
    state.base = undefined;
    expect(issueFileLink(staffContext(), "photo", "ph_ok", "full")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("serving a good link", () => {
  it("a staff photo: 200, the bytes, and the safe headers", async () => {
    const res = await get(issue(staffContext(), "photo", "ph_ok").path);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PHOTO)).toBe(true);
    expect(header(res, "content-type")).toBe("image/jpeg");
    expect(header(res, "x-content-type-options")).toBe("nosniff");
    expect(header(res, "referrer-policy")).toBe("no-referrer");
    expect(header(res, "content-disposition")).toBe("inline");
    expect(header(res, "content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(header(res, "cross-origin-resource-policy")).toBe("cross-origin");
    expect(header(res, "etag")).toBe(etagOf(keyOf("v_fc_pending", "photos", "a.jpg")));
    expect(header(res, "cache-control")).toMatch(/^private, max-age=\d+$/);
  });

  it("the cache lifetime is the link's remaining life, never more than 300 seconds", async () => {
    state.ttl = 120;
    const short = await get(issue(staffContext(), "photo", "ph_ok").path);
    const seconds = Number(/max-age=(\d+)/.exec(header(short, "cache-control"))![1]);
    expect(seconds).toBeGreaterThan(100);
    expect(seconds).toBeLessThanOrEqual(120);
    state.ttl = 900;
    state.max = 900;
    const long = await get(issue(staffContext(), "photo", "ph_ok").path);
    expect(header(long, "cache-control")).toBe("private, max-age=300");
  });

  it("a staff document is an attachment with its name; an auction sheet is inline", async () => {
    const doc = await get(issue(staffContext(), "document", "doc_ok").path);
    expect(doc.statusCode).toBe(200);
    expect(header(doc, "content-type")).toBe("application/pdf");
    expect(header(doc, "content-disposition")).toMatch(/^attachment; filename="Bill of lading\.pdf"/);
    const sheet = await get(issue(staffContext(), "auction-sheet", "v_fc_pending").path);
    expect(sheet.statusCode).toBe(200);
    expect(header(sheet, "content-disposition")).toBe("inline");
    expect(sheet.rawPayload.equals(SHEET)).toBe(true);
  });

  it("the thumb variant serves the small version when there is one, and the full image when there is not", async () => {
    const thumbKey = keyOf("v_fc_pending", "photos-thumb", "a.jpg");
    const fallback = await get(issue(staffContext(), "photo", "ph_ok", "thumb").path);
    expect(fallback.rawPayload.equals(PHOTO)).toBe(true);
    objects.set(thumbKey, Buffer.from("tiny"));
    const thumb = await get(issue(staffContext(), "photo", "ph_ok", "thumb").path);
    expect(thumb.rawPayload.toString()).toBe("tiny");
  });

  it("a customer link works for the customer's own released photo and document", async () => {
    expect((await get(issue(customerContext(), "photo", "ph_ok").path)).rawPayload.equals(PHOTO)).toBe(true);
    expect((await get(issue(customerContext(), "document", "doc_ok").path)).statusCode).toBe(200);
  });

  it("needs no Bearer token and ignores one", async () => {
    const path = issue(staffContext(), "photo", "ph_ok").path;
    expect((await get(path)).statusCode).toBe(200);
    expect((await get(path, { authorization: "Bearer not.a.token" })).statusCode).toBe(200);
  });

  it("HEAD works like GET without a body", async () => {
    const res = await app.inject({ method: "HEAD", url: issue(staffContext(), "photo", "ph_ok").path });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(0);
  });
});

describe("ETag and Range", () => {
  it("If-None-Match with the current ETag is a 304 with no body and the same safe headers; a stale one gets the file", async () => {
    const path = issue(staffContext(), "photo", "ph_ok").path;
    const etag = etagOf(keyOf("v_fc_pending", "photos", "a.jpg"));
    const same = await get(path, { "if-none-match": etag });
    expect(same.statusCode).toBe(304);
    expect(same.rawPayload.length).toBe(0);
    expect(header(same, "etag")).toBe(etag);
    expect(header(same, "x-content-type-options")).toBe("nosniff");
    expect(header(same, "cache-control")).toMatch(/^private, max-age=\d+$/);
    expect((await get(path, { "if-none-match": '"old"' })).statusCode).toBe(200);
  });

  it("a 304 is never given to a link that is refused (the file is not even looked at)", async () => {
    const etag = etagOf(keyOf("v_fc_pending", "photos", "a.jpg"));
    const res = await get(handmade({ exp: nowSeconds() - 600 }), { "if-none-match": etag });
    expect(res.statusCode).toBe(404);
    expect(reads).toEqual([]);
  });

  it("a PDF supports ONE range: 206 with Content-Range and Accept-Ranges", async () => {
    const path = issue(staffContext(), "document", "doc_ok").path;
    const res = await get(path, { range: "bytes=0-3" });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.toString()).toBe("%PDF");
    expect(header(res, "content-range")).toBe(`bytes 0-3/${PDF.length}`);
    expect(header(res, "accept-ranges")).toBe("bytes");
    const tail = await get(path, { range: "bytes=-5" });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.toString()).toBe(PDF.subarray(-5).toString());
    const open = await get(path, { range: "bytes=10-" });
    expect(open.rawPayload.length).toBe(PDF.length - 10);
  });

  it("a full PDF response advertises Accept-Ranges; an image does not and ignores Range", async () => {
    const pdf = await get(issue(staffContext(), "document", "doc_ok").path);
    expect(pdf.statusCode).toBe(200);
    expect(header(pdf, "accept-ranges")).toBe("bytes");
    const image = await get(issue(staffContext(), "photo", "ph_ok").path, { range: "bytes=0-3" });
    expect(image.statusCode).toBe(200);
    expect(image.rawPayload.equals(PHOTO)).toBe(true);
    expect(header(image, "accept-ranges")).toBe("");
  });

  it("several ranges, a malformed range and a backwards range are ignored: the whole file", async () => {
    const path = issue(staffContext(), "document", "doc_ok").path;
    for (const range of ["bytes=0-1,5-6", "bytes=abc", "bytes=9-2", "items=0-3", "bytes=-", "bytes=0-1-2"]) {
      const res = await get(path, { range });
      expect(res.statusCode, range).toBe(200);
      expect(res.rawPayload.length).toBe(PDF.length);
    }
  });

  it("a range past the end of the file is 416", async () => {
    const res = await get(issue(staffContext(), "document", "doc_ok").path, { range: "bytes=999-1000" });
    expect(res.statusCode).toBe(416);
  });

  it("parseSingleRange accepts exactly one well-formed range", () => {
    expect(parseSingleRange("bytes=0-99")).toBe("bytes=0-99");
    expect(parseSingleRange("bytes=5-")).toBe("bytes=5-");
    expect(parseSingleRange("bytes=-5")).toBe("bytes=-5");
    for (const bad of [undefined, "", "bytes=", "bytes=-", "bytes=a-b", "bytes=1-2,3-4", "bytes=5-1", "chunks=1-2"]) expect(parseSingleRange(bad), String(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("every refusal is the same 404", () => {
  /** [label, how to make the request] */
  const cases: Array<[string, () => Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> | { statusCode: number; headers: Record<string, unknown>; body: string }]> = [];
  const good = () => issue(staffContext(), "photo", "ph_ok").path;
  const url = (path: string) => new URL(`${LINK_HOST}${path}`);
  const tamper = (mutate: (u: URL) => void) => {
    const u = url(good());
    mutate(u);
    return get(`${u.pathname}${u.search}`);
  };
  const setQuery = (name: string, value: string) => tamper((u) => u.searchParams.set(name, value));
  const dropQuery = (name: string) => tamper((u) => u.searchParams.delete(name));

  // forged and tampered, field by field
  cases.push(["a garbage signature", () => setQuery("sig", "x".repeat(43))]);
  cases.push(["a signature of the wrong length", () => setQuery("sig", "abc")]);
  cases.push(["an empty signature", () => setQuery("sig", "")]);
  cases.push(["a changed kind (photo -> document)", () => get(good().replace("/photo/", "/document/"))]);
  cases.push(["a changed id", () => get(good().replace("/ph_ok/", "/ph_hidden/"))]);
  cases.push(["a changed variant (full -> thumb)", () => get(good().replace("/full?", "/thumb?"))]);
  cases.push(["a changed org (o)", () => setQuery("o", ORG_B)]);
  cases.push(["a changed user (u)", () => setQuery("u", "staff_super")]);
  cases.push(["a changed audience (a)", () => setQuery("a", "customer")]);
  cases.push(["a changed expiry (exp + 1)", () => tamper((u) => u.searchParams.set("exp", String(Number(u.searchParams.get("exp")) + 1)))]);
  cases.push(["a signature copied from another link", async () => {
    const other = url(issue(staffContext(), "document", "doc_ok").path);
    return setQuery("sig", other.searchParams.get("sig")!);
  }]);
  for (const name of ["o", "u", "a", "exp", "sig"]) cases.push([`the ${name} parameter missing`, () => dropQuery(name)]);
  cases.push(["an extra query parameter", () => setQuery("download", "1")]);
  cases.push(["no query at all", () => get("/f/v1/photo/ph_ok/full")]);
  cases.push(["an unknown kind", () => get(good().replace("/photo/", "/video/"))]);
  cases.push(["an unknown variant", () => get(good().replace("/full?", "/huge?"))]);
  cases.push(["an id with odd characters", () => get(good().replace("/ph_ok/", "/ph%2Fok/"))]);
  cases.push(["a path-traversal id", () => get(good().replace("/ph_ok/", "/..%2F..%2Fx/"))]);
  cases.push(["a link signed with another secret", () => get(handmade({ secret: "example-other-link-value-0123456789abcdefghij" }))]);
  cases.push(["a link signed with the secret of another purpose", () => get(handmade({ secret: process.env["MOBILE_JWT_SECRET"] ?? "x" }))]);
  // time
  cases.push(["an expired link", () => get(handmade({ exp: nowSeconds() - 120 }))]);
  cases.push(["a link issued further ahead than the cap", () => get(handmade({ exp: nowSeconds() + 900 + 120 }))]);
  // the person
  cases.push(["a deactivated staff user", () => get(handmade({ userId: "staff_off" }))]);
  cases.push(["an unknown staff user", () => get(handmade({ userId: "staff_nobody" }))]);
  cases.push(["a staff user of another org", () => get(handmade({ userId: "staff_b" }))]);
  cases.push(["a customer's id presented as staff", () => get(handmade({ userId: CUSTOMER }))]);
  cases.push(["a disabled customer", () => get(handmade({ audience: "customer", userId: "cust_disabled" }))]);
  cases.push(["an unverified customer", () => get(handmade({ audience: "customer", userId: "cust_unverified" }))]);
  cases.push(["a deleted customer", () => get(handmade({ audience: "customer", userId: "cust_deleted" }))]);
  cases.push(["a staff id presented as a customer", () => get(handmade({ audience: "customer", userId: STAFF }))]);
  // the file
  cases.push(["an unknown file", () => get(handmade({ id: "ph_nope" }))]);
  cases.push(["a file of another org", () => get(handmade({ id: "ph_other_org" }))]);
  cases.push(["a link for another org's id with this org's staff", () => get(handmade({ orgId: ORG_B, id: "ph_ok", userId: "staff_b" }))]);
  cases.push(["a photo id used as a document", () => get(handmade({ kind: "document", id: "ph_ok" }))]);
  cases.push(["a stored address on another host", () => get(handmade({ id: "ph_elsewhere" }))]);
  cases.push(["a pdf stored as a photo", () => get(handmade({ id: "ph_pdf_as_photo" }))]);
  cases.push(["a document with a thumb variant", () => get(handmade({ kind: "document", id: "doc_ok", variant: "thumb" }))]);
  cases.push(["a missing object in storage", () => get(handmade({ id: "ph_missing_object" }))]);
  cases.push(["a customer asking for an auction sheet", () => get(handmade({ audience: "customer", userId: CUSTOMER, kind: "auction-sheet", id: "v_fc_pending" }))]);
  cases.push(["another customer's photo", () => get(handmade({ audience: "customer", userId: CUSTOMER, id: "ph_other_customer" }))]);
  cases.push(["a customer's unreleased photo", () => get(handmade({ audience: "customer", userId: CUSTOMER, id: "ph_hidden" }))]);
  cases.push(["a customer's unreleased document", () => get(handmade({ audience: "customer", userId: CUSTOMER, kind: "document", id: "doc_private" }))]);
  cases.push(["a file of a deleted vehicle", async () => {
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!, { deletedAt: new Date() });
    return get(good());
  }]);
  cases.push(["links switched off (no secret)", () => {
    const path = good(); // made while links still work
    state.secret = undefined;
    return get(path);
  }]);

  it("a baseline: the answer for something that simply does not exist", async () => {
    const res = await get(handmade({ id: "ph_nope" }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { code: "NOT_FOUND", message: "File not found." } });
  });

  it.each(cases.map(([label, run]) => [label, run] as const))("%s", async (_label, run) => {
    const baseline = await get(handmade({ id: "ph_nope" }));
    const res = await run();
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(baseline.body);
    expect(withoutDate(res.headers)).toEqual(withoutDate(baseline.headers));
    expect(header(res, "cache-control")).toBe("no-store");
    expect(header(res, "etag")).toBe("");
    expect(header(res, "content-disposition")).toBe("");
  });

  it("the store is never touched for a link that fails before the file is authorised", async () => {
    await get(handmade({ exp: nowSeconds() - 600 }));
    await get(handmade({ userId: "staff_off" }));
    await get(handmade({ audience: "customer", userId: CUSTOMER, id: "ph_hidden" }));
    await get(handmade({ id: "ph_other_org" }));
    expect(reads).toEqual([]);
  });
});

describe("a link signed with the RIGHT secret but outside the format is still refused", () => {
  // If the secret ever leaked, the format rules must still hold: nothing a link can say may widen what it opens.
  const raw = (p: { kind: string; id: string; variant: string; o: string; u: string; a: string; exp: string }, signedExp = p.exp) => {
    const sig = createHmac("sha256", SECRET).update(["v1", p.kind, p.id, p.variant, p.o, p.u, p.a, signedExp].join("|")).digest("base64url");
    return `/f/v1/${p.kind}/${p.id}/${p.variant}?o=${p.o}&u=${p.u}&a=${p.a}&exp=${p.exp}&sig=${sig}`;
  };
  const good = () => ({ kind: "photo", id: "ph_ok", variant: "full", o: ORG_A, u: STAFF, a: "staff", exp: String(nowSeconds() + 300) });

  it("the control: the same link in the proper format opens", async () => {
    expect((await get(raw(good()))).statusCode).toBe(200);
  });

  it("an unknown kind is refused (it must not fall through to the auction sheet)", async () => {
    expect((await get(raw({ ...good(), kind: "video", id: "v_fc_pending" }))).statusCode).toBe(404);
  });

  it("an unknown variant is refused (it must not act like 'full')", async () => {
    expect((await get(raw({ ...good(), variant: "huge" }))).statusCode).toBe(404);
  });

  it("an unknown audience is refused (it must not act like a customer)", async () => {
    expect((await get(raw({ ...good(), a: "admin", u: CUSTOMER }))).statusCode).toBe(404);
    expect((await get(raw({ ...good(), a: "", u: CUSTOMER }))).statusCode).toBe(404);
  });

  it("one ticket has one URL: another way of writing the same expiry number is refused", async () => {
    const exp = nowSeconds() + 300;
    for (const written of [`0${exp}`, `00${exp}`, `+${exp}`, `${exp}.0`, ` ${exp}`, `${exp}e0`, `0x${exp.toString(16)}`]) {
      expect((await get(raw({ ...good(), exp: written }, String(exp)))).statusCode, written).toBe(404);
    }
    expect((await get(raw({ ...good(), exp: String(exp) }))).statusCode).toBe(200);
  });

  it("an id with odd characters is refused", async () => {
    for (const id of ["ph%20ok", "ph.ok", "ph%00ok", "a".repeat(65)]) expect((await get(raw({ ...good(), id }))).statusCode, id).toBe(404);
  });

  it("a customer's link for an auction sheet is refused even if a document happens to have the vehicle's id", async () => {
    fake.seed("vehicleDocument", { id: "v_fc_pending", vehicleId: "v_fc_pending", url: urlOf(keyOf("v_fc_pending", "documents", "bl.pdf")), name: "x", documentType: "OTHER", visibleToCustomer: true, uploadedById: STAFF });
    expect((await get(raw({ ...good(), kind: "auction-sheet", id: "v_fc_pending", a: "customer", u: CUSTOMER }))).statusCode).toBe(404);
  });

  it("a stored address on another host is refused even when an object exists at the path it would have if the host were cut off", async () => {
    expect(objects.has("a.jpg")).toBe(true);
    expect((await get(raw({ ...good(), id: "ph_elsewhere" }))).statusCode).toBe(404);
    expect(reads).not.toContain("a.jpg");
  });
});

describe("a link just inside the time limits works", () => {
  it("expired 10 seconds ago is still accepted (30 s of clock skew), 60 seconds ago is not", async () => {
    expect((await get(handmade({ exp: nowSeconds() - 10 }))).statusCode).toBe(200);
    expect((await get(handmade({ exp: nowSeconds() - 60 }))).statusCode).toBe(404);
  });

  it("issued up to the cap plus the skew ahead is accepted, further is not", async () => {
    state.max = 600;
    expect((await get(handmade({ exp: nowSeconds() + 600 + 10 }))).statusCode).toBe(200);
    expect((await get(handmade({ exp: nowSeconds() + 600 + 60 }))).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------

describe("revocation is immediate: the database is asked on every fetch", () => {
  it("a staff user deactivated through the service loses a link already issued, even with a long auth cache", async () => {
    state.cache = 300;
    const path = issue(staffContext(), "photo", "ph_ok").path;
    expect((await get(path)).statusCode).toBe(200); // primes the cache
    await setStaffActive({ id: "staff_super", role: "ADMINISTRATOR", orgId: ORG_A, name: "Administrator", email: null }, STAFF, false);
    expect((await get(path)).statusCode).toBe(404);
    await setStaffActive({ id: "staff_super", role: "ADMINISTRATOR", orgId: ORG_A, name: "Administrator", email: null }, STAFF, true);
    expect((await get(path)).statusCode).toBe(200);
  });

  it("a photo staff un-release stops working for the customer at once, and works again when re-released", async () => {
    const path = issue(customerContext(), "photo", "ph_ok").path;
    expect((await get(path)).statusCode).toBe(200);
    Object.assign(fake.rows("vehiclePhoto").find((p) => p["id"] === "ph_ok")!, { visibleToCustomer: false });
    expect((await get(path)).statusCode).toBe(404);
    Object.assign(fake.rows("vehiclePhoto").find((p) => p["id"] === "ph_ok")!, { visibleToCustomer: true });
    expect((await get(path)).statusCode).toBe(200);
  });

  it.each([
    ["the vehicle is no longer released", { customerVisible: false }],
    ["the vehicle is unlinked from the customer", { customerId: "cust_a2" }],
    ["the vehicle is converted to local", { convertedToLocal: true }],
    ["the vehicle is deleted", { deletedAt: new Date() }],
  ])("a customer's link stops when %s", async (_label, change) => {
    const path = issue(customerContext(), "document", "doc_ok").path;
    expect((await get(path)).statusCode).toBe(200);
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!, change);
    expect((await get(path)).statusCode).toBe(404);
  });

  it.each([
    ["is disabled", { loginEnabled: false }],
    ["is deleted", { deletedAt: new Date() }],
    ["loses their password", { password: null }],
  ])("a customer link stops when the account %s", async (_label, change) => {
    const path = issue(customerContext(), "photo", "ph_ok").path;
    expect((await get(path)).statusCode).toBe(200);
    Object.assign(fake.rows("user").find((u) => u["id"] === CUSTOMER)!, change);
    expect((await get(path)).statusCode).toBe(404);
  });

  it("a staff link stops when the photo row is deleted or the vehicle is soft-deleted", async () => {
    const path = issue(staffContext(), "photo", "ph_ok").path;
    const sheet = issue(staffContext(), "auction-sheet", "v_fc_pending").path;
    const document = issue(staffContext(), "document", "doc_ok").path;
    expect((await get(path)).statusCode).toBe(200);
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!, { deletedAt: new Date() });
    expect((await get(path)).statusCode).toBe(404);
    expect((await get(sheet)).statusCode).toBe(404);
    expect((await get(document)).statusCode).toBe(404);
  });

  it("a replaced auction sheet: the old link now serves the NEW sheet (the link names the vehicle, not the object)", async () => {
    const path = issue(staffContext(), "auction-sheet", "v_fc_pending").path;
    const newKey = keyOf("v_fc_pending", "auction-sheet", "new.jpg");
    objects.set(newKey, Buffer.from("new-sheet"));
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!, { auctionSheetUrl: urlOf(newKey) });
    expect((await get(path)).rawPayload.toString()).toBe("new-sheet");
  });
});

// ---------------------------------------------------------------------------------------------

describe("secret rotation (FILE_LINK_SECRET_PREVIOUS)", () => {
  it("a link made with the old secret is accepted while it is the previous one, and refused once it is removed", async () => {
    state.secret = PREVIOUS;
    const old = issue(staffContext(), "photo", "ph_ok").path; // signed with what will become the previous secret
    state.secret = SECRET;
    expect((await get(old)).statusCode).toBe(404); // no previous secret yet

    state.previous = PREVIOUS;
    expect((await get(old)).statusCode).toBe(200); // the overlap
    expect((await get(issue(staffContext(), "photo", "ph_ok").path)).statusCode).toBe(200); // new links use the new secret

    state.previous = undefined;
    expect((await get(old)).statusCode).toBe(404); // the overlap is over
  });

  it("new links are signed with the CURRENT secret, never the previous one", () => {
    state.previous = PREVIOUS;
    const path = issue(staffContext(), "photo", "ph_ok").path;
    const exp = Number(new URL(`${LINK_HOST}${path}`).searchParams.get("exp"));
    const sig = new URL(`${LINK_HOST}${path}`).searchParams.get("sig");
    expect(sig).toBe(signParts(SECRET, { kind: "photo", id: "ph_ok", variant: "full", orgId: ORG_A, userId: STAFF, audience: "staff", exp }));
    expect(sig).not.toBe(signParts(PREVIOUS, { kind: "photo", id: "ph_ok", variant: "full", orgId: ORG_A, userId: STAFF, audience: "staff", exp }));
  });
});

describe("the signature is compared in constant time", () => {
  it("the comparison uses timingSafeEqual, and checks every secret without stopping at the first", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/file-link.ts", "utf8");
    expect(source).toContain("timingSafeEqual(");
    expect(source).not.toMatch(/sig\s*===|===\s*sig|expected\s*===|\.startsWith\(sig/);
    const loop = source.slice(source.indexOf("export function signatureMatches"));
    expect(loop).not.toMatch(/\breturn true\b/); // no early exit inside the loop: every secret is always checked
  });
});

// ---------------------------------------------------------------------------------------------

describe("rate limit, size cap, disconnect", () => {
  it("the route has its OWN limit (240 a minute), lower than the global one", () => {
    expect(FILE_LINK_RATE_LIMIT.max).toBe(240);
  });

  it("wrong links count toward the per-IP limit, and the 429 uses the standard envelope", async () => {
    await app.close();
    app = await buildApp(); // the real rate limiter
    const bad = handmade({ id: "ph_nope" });
    let last = 0;
    for (let i = 0; i <= FILE_LINK_RATE_LIMIT.max; i += 1) last = (await get(bad, {}, "10.9.9.9")).statusCode;
    expect(last).toBe(429);
    expect((await get(bad, {}, "10.8.8.8")).statusCode).toBe(404); // another address is unaffected
  });

  it("a file larger than the limit for its kind is refused (404), and its stream is closed", async () => {
    storeOverride = async () => {
      const body = Readable.from([Buffer.from("x")]);
      streamsOpened.push(body);
      return { kind: "found", body, contentLength: 10 * 1024 * 1024 + 1, etag: '"e"' };
    };
    const res = await get(issue(staffContext(), "photo", "ph_ok").path);
    expect(res.statusCode).toBe(404);
    expect(streamsOpened[0]!.destroyed).toBe(true);
  });

  it("a stream of unknown length can never deliver more than the limit", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1);
    storeOverride = async () => {
      const body = Readable.from((function* () {
        for (let i = 0; i < 12; i += 1) yield chunk; // 12 MB against a 10 MB limit
      })());
      streamsOpened.push(body);
      return { kind: "found", body, contentLength: null, etag: '"e"' };
    };
    const received = await get(issue(staffContext(), "photo", "ph_ok").path).then(
      (res) => res.rawPayload.length,
      () => 0
    );
    expect(received).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(received).toBeLessThan(12 * 1024 * 1024);
  });

  it("when the client goes away the read from storage is stopped", async () => {
    await app.close();
    app = await buildApp({ rateLimit: false });
    let produced = 0;
    let body!: Readable;
    storeOverride = async () => {
      body = new Readable({
        read() {
          produced += 1;
          setTimeout(() => this.push(Buffer.alloc(16 * 1024, 1)), 5);
        },
      });
      return { kind: "found", body, contentLength: null, etag: '"e"' };
    };
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const link = issue(staffContext(), "photo", "ph_ok").path;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${address.port}${link}`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await vi.waitFor(() => expect(body.destroyed).toBe(true), { timeout: 3000 });
    const stopped = produced;
    await new Promise((r) => setTimeout(r, 100));
    expect(produced).toBe(stopped); // nothing more is read after the client left
  });
});

// ---------------------------------------------------------------------------------------------

describe("logs and leaks", () => {
  it("REAL log output: the request line carries the route pattern, never the signature, the query or the ids", async () => {
    await app.close();
    const lines: string[] = [];
    app = await buildApp({ rateLimit: false, logger: true, logStream: new Writable({ write(chunk, _e, done) { lines.push(chunk.toString()); done(); } }) });
    const link = issue(staffContext(), "photo", "ph_ok");
    const sig = new URL(link.url).searchParams.get("sig")!;
    await get(link.path);
    await get(handmade({ id: "ph_nope" }));
    const text = lines.join("");
    expect(text).toContain("/f/v1/:kind/:id/:variant");
    for (const forbidden of [sig, "sig=", "exp=", "ph_ok", STAFF, "ph_nope", ACCOUNT, BUCKET]) expect(text, forbidden).not.toContain(forbidden);
  });

  it("the redactor removes a signature from any text that carries a link", () => {
    const link = issue(staffContext(), "photo", "ph_ok").url;
    const sig = new URL(link).searchParams.get("sig")!;
    const redacted = redactSecrets(`failed to open ${link} (retry)`);
    expect(redacted).not.toContain(sig);
    expect(redacted).toContain("[redacted]");
    expect(redactSecrets("https://api.example.test/f/v1/photo/x/full?o=a&sig=abcDEF_-123456789012345678901234567890123&u=b")).not.toContain("abcDEF");
  });

  it("no link, response or log holds an R2 host, an object key, the bucket name or the account id", async () => {
    await app.close();
    const lines: string[] = [];
    const spy: string[] = [];
    for (const m of ["warn", "error", "log", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void spy.push(a.map(String).join(" ")));
    app = await buildApp({ rateLimit: false, logger: true, logStream: new Writable({ write(chunk, _e, done) { lines.push(chunk.toString()); done(); } }) });
    const token = await signAccessToken({ sub: STAFF, orgId: ORG_A, role: "MANAGER", name: "Link Manager", email: null });
    const responses = [
      await app.inject({ method: "GET", url: "/api/v1/vehicles/FC101/files", headers: { authorization: `Bearer ${token}` } }),
      await get(issue(staffContext(), "photo", "ph_ok").path),
      await get(issue(staffContext(), "document", "doc_ok").path),
      await get(handmade({ id: "ph_missing_object" })),
      await get(handmade({ id: "ph_other_org" })),
    ];
    const everything = [...responses.map((r) => `${r.body}${JSON.stringify(r.headers)}`.replace(/Content-Type[^,]*/g, "")), ...lines, ...spy].join("\n");
    const binary = [PHOTO, PDF].map((b) => b.toString());
    const scrubbed = binary.reduce((acc, b) => acc.split(b).join(""), everything);
    for (const forbidden of [ACCOUNT, BUCKET, "r2.dev", "cloudflarestorage", "files.example.test", "org/org_test_a", "vehicles/v_fc_pending/", "a.jpg", "bl.pdf", "s.jpg", "X-Amz"]) expect(scrubbed, forbidden).not.toContain(forbidden);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the staff endpoints hand out these links", () => {
  const headers = async (role: "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER" = "MANAGER") => ({
    authorization: `Bearer ${await signAccessToken({ sub: STAFF, orgId: ORG_A, role, name: "Link Manager", email: null })}`,
  });
  const files = async (role?: "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER") =>
    (await app.inject({ method: "GET", url: "/api/v1/vehicles/FC101/files", headers: await headers(role) })).json().data;
  const photo = (data: { photos: Array<{ id: string; url: string | null }> }, id = "ph_ok") => data.photos.find((p) => p.id === id)!;
  const document = (data: { documents: Array<{ id: string; url: string | null }> }, id = "doc_ok") => data.documents.find((d) => d.id === id)!;

  it("GET /vehicles/:serial/files: every url is a link on our domain for THIS user, with expiresAt, and it opens", async () => {
    const data = await files();
    expect(photo(data).url).toMatch(new RegExp(`^${LINK_HOST}/f/v1/photo/ph_ok/full\\?o=${ORG_A}&u=${STAFF}&a=staff&exp=\\d+&sig=`));
    expect(document(data).url).toContain("/f/v1/document/doc_ok/full");
    expect(data.auctionSheetUrl).toContain("/f/v1/auction-sheet/v_fc_pending/full");
    expect(Date.parse((photo(data) as unknown as { expiresAt: string }).expiresAt)).toBeGreaterThan(Date.now());
    expect((await get(pathOf(photo(data).url!))).statusCode).toBe(200);
    expect((await get(pathOf(document(data).url!))).statusCode).toBe(200);
    expect((await get(pathOf(data.auctionSheetUrl))).statusCode).toBe(200);
    expect(JSON.stringify(data)).not.toContain(BASE);
  });

  it("every staff role gets links (the list is open to all roles, like before)", async () => {
    for (const role of ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"] as const) expect(photo(await files(role)).url, role).toContain("/f/v1/photo/");
  });

  it("a row that cannot be linked is `url: null, unavailable: true`; the rest still work", async () => {
    fake.seed("vehiclePhoto", { id: "ph_bad", vehicleId: "v_fc_pending", url: "https://evil.test/a.jpg", uploadedById: STAFF, createdAt: new Date(2030, 0, 1) });
    fake.seed("vehicleDocument", { id: "doc_as_image", vehicleId: "v_fc_pending", url: urlOf(keyOf("v_fc_pending", "documents", "x.jpg")), name: "x", documentType: "OTHER", uploadedById: STAFF });
    const data = await files();
    const bad = data.photos.find((p: { id: string }) => p.id === "ph_bad");
    expect(bad).toMatchObject({ url: null, expiresAt: null, unavailable: true });
    expect(data.documents.find((d: { id: string }) => d.id === "doc_as_image")).toMatchObject({ url: null, unavailable: true });
    expect(photo(data).url).toContain("/f/v1/photo/ph_ok/"); // the good ones are untouched
  });

  it("with links switched off every file is unavailable and nothing breaks", async () => {
    state.secret = undefined;
    state.base = undefined;
    const data = await files();
    expect(photo(data)).toMatchObject({ url: null, expiresAt: null, unavailable: true });
    expect(data.auctionSheetUrl).toBeNull();
    expect(data.auctionSheetUnavailable).toBe(true);
  });

  it("adding a photo, a document and setting the auction sheet answer with links", async () => {
    objects.set(keyOf("v_fc_pending", "photos", "new.jpg"), PHOTO);
    objects.set(keyOf("v_fc_pending", "documents", "new.pdf"), PDF);
    objects.set(keyOf("v_fc_pending", "auction-sheet", "new.jpg"), SHEET);
    const h = await headers();
    const photo = await app.inject({ method: "POST", url: "/api/v1/vehicles/v_fc_pending/photos", headers: h, payload: { key: keyOf("v_fc_pending", "photos", "new.jpg") } });
    expect(photo.statusCode).toBe(201);
    expect(photo.json().data.url).toContain("/f/v1/photo/");
    const doc = await app.inject({ method: "POST", url: "/api/v1/vehicles/v_fc_pending/documents", headers: h, payload: { key: keyOf("v_fc_pending", "documents", "new.pdf"), name: "n", documentType: "OTHER" } });
    expect(doc.json().data.url).toContain("/f/v1/document/");
    const sheet = await app.inject({ method: "PUT", url: "/api/v1/vehicles/v_fc_pending/auction-sheet", headers: h, payload: { key: keyOf("v_fc_pending", "auction-sheet", "new.jpg") } });
    expect(sheet.json().data).toEqual({ auctionSheetUrl: expect.stringContaining("/f/v1/auction-sheet/v_fc_pending/full"), auctionSheetExpiresAt: expect.any(String) });
    for (const r of [photo, doc, sheet]) expect(r.body).not.toContain(BASE);
  });

  it("GET /vehicles/:serial/pdf-images reads through the store: no link, no network call to any address", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("no network call may be made");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/vehicles/FC101/pdf-images", headers: await headers() });
      expect(res.statusCode).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(reads).toContain(keyOf("v_fc_pending", "auction-sheet", "s.jpg"));
      expect(res.json().data.auctionSheetDataUrl).toBe(`data:image/jpeg;base64,${SHEET.toString("base64")}`);
      expect(res.body).not.toContain("/f/v1/");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pdf-images skips an address outside the org, a missing object and a non-image, and still answers", async () => {
    fake.seed("vehiclePhoto", { id: "ph_x1", vehicleId: "v_fc_pending", url: "https://evil.test/a.jpg", uploadedById: STAFF });
    fake.seed("vehiclePhoto", { id: "ph_x2", vehicleId: "v_fc_pending", url: urlOf(keyOf("v_fc_pending", "photos", "nothing-here.jpg")), uploadedById: STAFF });
    const res = await app.inject({ method: "GET", url: "/api/v1/vehicles/FC101/pdf-images", headers: await headers() });
    expect(res.statusCode).toBe(200);
    // Only the two real images (a.jpg, b.jpg) come back: the foreign address, the missing object and the pdf are skipped.
    expect(res.json().data.photoDataUrls).toEqual([`data:image/jpeg;base64,${PHOTO.toString("base64")}`, `data:image/jpeg;base64,${PHOTO.toString("base64")}`]);
  });
});
