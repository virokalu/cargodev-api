// Slice 7: the public website API (stock, enquiries), the staff stock tools and the staff enquiry inbox. Fake data only.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { createFakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { bearerFor } from "./helpers/customer-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { buildApp } from "../src/app.js";
import { PUBLIC_MAX_PAGE_SIZE, PUBLIC_RATE_LIMITS } from "../src/config/public-stock.js";
import { STOCK_ROLES } from "../src/config/roles.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { setPublicStockStore } from "../src/lib/public-stock-storage.js";
import type { ObjectStore } from "../src/lib/object-storage.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const ALL_ROLES: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];
const WEBSITE = "https://www.example.test";
const IMAGE_BASE = "https://img.example.test";

let app: FastifyInstance;
let fake: FakePrisma;
const rows = (model: string) => fake.rows(model);
const row = (model: string, id: string) => rows(model).find((r) => r["id"] === id)!;
const logs = (action: string) => rows("activityLog").filter((l) => l["action"] === action);

const staffHeaders = async (role: Role, orgId = ORG_A) => ({
  authorization: `Bearer ${await signAccessToken({ sub: orgId === ORG_A ? "staff_a1" : "staff_b1", orgId, role, name: `Test ${role}`, email: null })}`,
});
const staff = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, role: Role | null, body?: unknown, orgId = ORG_A) =>
  app.inject({ method, url: `/api/v1${url}`, headers: role ? await staffHeaders(role, orgId) : {}, ...(body === undefined ? {} : { payload: body as object }) });
const pub = (method: "GET" | "POST" | "OPTIONS", url: string, body?: unknown, headers: Record<string, string> = {}, remoteAddress?: string) =>
  app.inject({ method, url: `/api/public${url}`, headers, ...(body === undefined ? {} : { payload: body as object }), ...(remoteAddress ? { remoteAddress } : {}) });

let counter = 0;
function stock(over: Record<string, unknown> = {}) {
  counter += 1;
  const id = (over["id"] as string | undefined) ?? `sv${counter}`;
  fake.seed("stockVehicle", {
    id,
    org_id: ORG_A,
    slug: `car-${id}`,
    make: "Alpha",
    model: "One",
    year: 2020,
    priceFob: 5000,
    mileageKm: 40000,
    bodyType: "Sedan",
    fuel: "Petrol",
    transmission: "AT",
    colour: "White",
    description: "A clean example.",
    status: "PUBLISHED",
    publishedAt: new Date(2026, 0, counter),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  fake.seed("stockImage", { id: `img_${id}_1`, org_id: ORG_A, stockVehicleId: id, key: `stock/aaaaaaaaaaaaaaaa/${id}-1.jpg`, altText: "Front", sortOrder: 0, createdAt: new Date() }, { id: `img_${id}_2`, org_id: ORG_A, stockVehicleId: id, key: `stock/aaaaaaaaaaaaaaaa/${id}-2.jpg`, altText: null, sortOrder: 1, createdAt: new Date() });
  return id;
}

beforeEach(async () => {
  counter = 0;
  fake = createFakePrisma();
  fake.seed(
    "user",
    { id: "staff_a1", org_id: ORG_A, userType: "STAFF", name: "Staff A", role: "MANAGER", loginEnabled: true },
    { id: "staff_b1", org_id: ORG_B, userType: "STAFF", name: "Staff B", role: "MANAGER", loginEnabled: true },
    { id: "cust_a1", org_id: ORG_A, userType: "CUSTOMER", name: "Customer", email: "a1@example.test", loginEnabled: true, emailVerifiedAt: new Date(), deletedAt: null, password: "x", failedLoginAttempts: 0, lockoutUntil: null }
  );
  state.fake = fake;
  identifierLimiter.reset();
  app = await buildApp({ rateLimit: false, publicStockEnabled: true, publicOrigins: [WEBSITE] });
});
afterEach(async () => {
  await app.close();
  setPublicStockStore(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------

describe("everything is behind PUBLIC_STOCK_ENABLED", () => {
  it("with it off, none of the public or staff stock routes exist", async () => {
    await app.close();
    app = await buildApp({ rateLimit: false, publicStockEnabled: false });
    expect((await pub("GET", "/stock")).statusCode).toBe(404);
    expect((await pub("POST", "/enquiries", { name: "A", email: "a@example.test", message: "Hello there" })).statusCode).toBe(404);
    expect((await staff("GET", "/stock", "ADMINISTRATOR")).statusCode).toBe(404);
    expect((await staff("GET", "/enquiries", "ADMINISTRATOR")).statusCode).toBe(404);
  });

  it("the setting defaults to off and only accepts true or false", async () => {
    vi.resetModules();
    const { loadEnv } = await import("../src/config/env.js");
    const base = { DATABASE_URL: "postgresql://user:password@example.test:5432/dbname", MOBILE_JWT_SECRET: "mobile-secret-value-0123456789abcdefXX", ORG_ID: "org_x" };
    expect(loadEnv(base).PUBLIC_STOCK_ENABLED).toBe(false);
    vi.resetModules();
    expect((await import("../src/config/env.js")).loadEnv({ ...base, PUBLIC_STOCK_ENABLED: "true" }).PUBLIC_STOCK_ENABLED).toBe(true);
    vi.resetModules();
    await expect(import("../src/config/env.js").then((m) => m.loadEnv({ ...base, PUBLIC_STOCK_ENABLED: "yes" }))).rejects.toThrow(/PUBLIC_STOCK_ENABLED/);
    vi.resetModules();
    await expect(import("../src/config/env.js").then((m) => m.loadEnv({ ...base, PUBLIC_ALLOWED_ORIGINS: "https://a.test, *" }))).rejects.toThrow(/PUBLIC_ALLOWED_ORIGINS/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("what the public sees", () => {
  it("lists only PUBLISHED stock of the default org: drafts, sold and other orgs never appear", async () => {
    const pubId = stock();
    stock({ status: "DRAFT", publishedAt: null });
    stock({ status: "SOLD" });
    stock({ org_id: ORG_B });
    const res = await pub("GET", "/stock");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rows.map((r: { slug: string }) => r.slug)).toEqual([`car-${pubId}`]);
    expect(res.json().data.total).toBe(1);
  });

  it("every card has exactly the whitelisted keys (no ids, org, status, timestamps or storage keys)", async () => {
    stock();
    const res = await pub("GET", "/stock");
    const card = res.json().data.rows[0];
    expect(Object.keys(card).sort()).toEqual(["bodyType", "colour", "fuel", "image", "make", "mileageKm", "model", "price", "publishedAt", "slug", "transmission", "year"]);
    expect(card.image).toEqual({ url: `${IMAGE_BASE}/stock/aaaaaaaaaaaaaaaa/sv1-1.jpg`, alt: "Front" });
    expect(card.price).toEqual({ amount: 5000, currency: "LKR" }); // never a bare number
    expect(res.body).not.toMatch(/priceFob/);
    expect(res.body).not.toMatch(/org_test|"id"|"status"|createdAt|updatedAt|sortOrder|"key"|stockVehicleId/);
  });

  it("the detail has the description and every image in order, nothing else", async () => {
    const id = stock();
    const res = await pub("GET", `/stock/car-${id}`);
    const data = res.json().data;
    expect(Object.keys(data).sort()).toEqual(["bodyType", "colour", "description", "fuel", "image", "images", "make", "mileageKm", "model", "price", "publishedAt", "slug", "transmission", "year"]);
    expect(data.price).toEqual({ amount: 5000, currency: "LKR" });
    expect(data.images).toEqual([{ url: `${IMAGE_BASE}/stock/aaaaaaaaaaaaaaaa/sv1-1.jpg`, alt: "Front" }, { url: `${IMAGE_BASE}/stock/aaaaaaaaaaaaaaaa/sv1-2.jpg`, alt: null }]);
    expect(Object.keys(data.images[0]).sort()).toEqual(["alt", "url"]);
  });

  it("a draft, a sold vehicle, another org's vehicle, an id, a bad slug and an unknown slug are the same 404", async () => {
    const draft = stock({ status: "DRAFT", publishedAt: null });
    const sold = stock({ status: "SOLD" });
    const other = stock({ org_id: ORG_B });
    const real = stock();
    const results = await Promise.all([`car-${draft}`, `car-${sold}`, `car-${other}`, real, "UPPER", "a b", "..%2f..", "nope"].map((slug) => pub("GET", `/stock/${slug}`)));
    for (const res of results) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Stock vehicle not found." } });
    }
  });

  it("an over-long slug never reaches the service", async () => {
    expect([404, 414]).toContain((await pub("GET", `/stock/${"x".repeat(200)}`)).statusCode);
  });

  it("a listing with no price has price: null (never 0 or a bare number)", async () => {
    stock({ id: "np", priceFob: null });
    const card = (await pub("GET", "/stock")).json().data.rows[0];
    expect(card.price).toBeNull();
  });

  it("a stock image is shown only when a public image address is configured, and is never a private address", async () => {
    stock({ id: "sv9" });
    for (const row of rows("stockImage")) Object.assign(row, { key: "stock/aaaaaaaaaaaaaaaa/x.jpg" });
    const res = await pub("GET", "/stock");
    expect(res.json().data.rows[0].image.url.startsWith(IMAGE_BASE)).toBe(true);
    expect(res.body).not.toMatch(/r2\.cloudflarestorage|org\//);
  });

  describe("filters, sorting and paging", () => {
    beforeEach(() => {
      stock({ id: "a", make: "Alpha", model: "Zeta", year: 2018, priceFob: 3000, mileageKm: 90000, bodyType: "Sedan", fuel: "Diesel", transmission: "MT" });
      stock({ id: "b", make: "Beta", model: "Eta", year: 2021, priceFob: 9000, mileageKm: 10000, bodyType: "SUV", fuel: "Hybrid", transmission: "AT" });
      stock({ id: "c", make: "Alpha", model: "Theta", year: 2015, priceFob: null, mileageKm: null, bodyType: "Van", fuel: "Petrol", transmission: "AT" });
    });
    const slugs = async (q: string) => (await pub("GET", `/stock${q}`)).json().data.rows.map((r: { slug: string }) => r.slug.replace("car-", ""));

    it.each([
      ["make=alpha", ["c", "a"]],
      ["model=eta", ["b"]],
      ["bodyType=suv", ["b"]],
      ["fuel=petrol", ["c"]],
      ["transmission=at", ["c", "b"]],
      ["yearMin=2016", ["b", "a"]],
      ["yearMax=2016", ["c"]],
      ["priceMin=4000", ["b"]],
      ["priceMax=4000", ["a"]],
      ["mileageMax=50000", ["b"]],
      ["q=zet", ["a"]],
      ["make=alpha&fuel=diesel", ["a"]],
    ])("filter %s", async (query, expected) => {
      expect((await slugs(`?${query}`)).sort()).toEqual([...expected].sort());
    });

    it("sorts by every allowed order, with newest first by default", async () => {
      expect(await slugs("")).toEqual(["c", "b", "a"]);
      expect(await slugs("?sort=priceAsc")).toEqual(["a", "b", "c"]);
      expect(await slugs("?sort=yearDesc")).toEqual(["b", "a", "c"]);
      expect(await slugs("?sort=yearAsc")).toEqual(["c", "a", "b"]);
      expect(await slugs("?sort=mileageAsc")).toEqual(["b", "a", "c"]);
    });

    it("caps the page size at 24 and pages", async () => {
      expect(PUBLIC_MAX_PAGE_SIZE).toBe(24);
      for (let i = 0; i < 30; i += 1) stock({ id: `bulk${i}` });
      expect((await pub("GET", "/stock?pageSize=24")).json().data.rows).toHaveLength(24);
      expect((await pub("GET", "/stock?pageSize=25")).statusCode).toBe(400);
      expect((await pub("GET", "/stock")).json().data.pageSize).toBe(12);
      expect((await pub("GET", "/stock?pageSize=24&page=2")).json().data.rows).toHaveLength(9);
    });

    it.each(["page=0", "pageSize=0", "sort=password", "sort=id", "yearMin=abc", "priceMax=-1", "id=sv1", "orgId=org_test_b", "status=DRAFT", "priceMin=1.5", "priceMax=3000000000", "currency=USD", "make=" + "x".repeat(61), "unknown=1"])(
      "rejects the parameter %s",
      async (query) => {
        expect((await pub("GET", `/stock?${query}`)).statusCode).toBe(400);
      }
    );

    it("% _ and backslash in a search are literal characters, not wildcards", async () => {
      stock({ id: "lit1", make: "Delta", model: "100% Hybrid" });
      stock({ id: "lit2", make: "Delta", model: "A_B Sport" });
      stock({ id: "lit3", make: "Delta", model: "Back\\slash" });
      stock({ id: "lit4", make: "Delta", model: "Plain Model" });
      const found = async (q: string) => (await pub("GET", `/stock?q=${encodeURIComponent(q)}`)).json().data.rows.map((r: { slug: string }) => r.slug.replace("car-", "")).sort();
      expect(await found("%")).toEqual(["lit1"]); // not "everything"
      expect(await found("100%")).toEqual(["lit1"]);
      expect(await found("_")).toEqual(["lit2"]); // not "any character"
      expect(await found("a_b")).toEqual(["lit2"]);
      expect(await found("A%B")).toEqual([]); // a percent sign between letters is literal
      expect(await found("\\")).toEqual(["lit3"]);
      expect(await found("Back\\slash")).toEqual(["lit3"]);
      expect(await found("%%")).toEqual([]);
    });

    it("the search text is trimmed, cut at 100 characters, and blank means no search", async () => {
      stock({ id: "t1", make: "Echo", model: "Trim Me" });
      const rowsFor = async (q: string) => (await pub("GET", `/stock?q=${encodeURIComponent(q)}`)).json().data.total;
      expect(await rowsFor("   trim me  ")).toBe(1);
      expect(await rowsFor("   ")).toBeGreaterThan(0); // blank is ignored, so the whole list
      expect(await rowsFor("")).toBeGreaterThan(0);
      // 100 characters of the model name followed by junk: the junk is cut off, so it still matches
      stock({ id: "t2", make: "Foxtrot", model: "m".repeat(100) });
      expect(await rowsFor("m".repeat(100) + "!!!!")).toBe(1);
      expect((await pub("GET", `/stock?q=${"x".repeat(5000)}`)).statusCode).toBe(200);
    });

    it("search text is data, not syntax (quotes, wildcards, SQL)", async () => {
      for (const q of ["%25", "_", "' OR 1=1 --", "\\\\", "<script>"]) {
        const res = await pub("GET", `/stock?q=${encodeURIComponent(q)}`);
        expect(res.statusCode, q).toBe(200);
        expect(res.json().data.total, q).toBe(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("headers: cache and CORS", () => {
  it("successful public reads may be cached for 60 seconds; errors and the POST stay no-store", async () => {
    const id = stock();
    expect((await pub("GET", "/stock")).headers["cache-control"]).toBe("public, max-age=60");
    expect((await pub("GET", `/stock/car-${id}`)).headers["cache-control"]).toBe("public, max-age=60");
    expect((await pub("GET", "/stock/nope")).headers["cache-control"]).toBe("no-store");
    expect((await pub("GET", "/stock?page=0")).headers["cache-control"]).toBe("no-store");
    const post = await pub("POST", "/enquiries", { name: "A Person", email: "a@example.test", message: "Hello there" });
    expect(post.headers["cache-control"]).toBe("no-store");
  });

  it("everything outside /api/public is still no-store", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).headers["cache-control"]).toBe("no-store");
    expect((await staff("GET", "/stock", "MANAGER")).headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ method: "GET", url: "/api/customer/v1/me", headers: await bearerFor("cust_a1") })).headers["cache-control"]).toBe("no-store");
  });

  it("only the website origin is allowed on public routes, never *", async () => {
    stock();
    const allowed = await pub("GET", "/stock", undefined, { origin: WEBSITE });
    expect(allowed.headers["access-control-allow-origin"]).toBe(WEBSITE);
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
    for (const origin of ["https://evil.test", "https://www.example.test.evil.test", "null", "http://www.example.test"]) {
      const denied = await pub("GET", "/stock", undefined, { origin });
      expect(denied.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
    expect((await pub("GET", "/stock")).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("the preflight allows only GET, POST and Content-Type for the website, and refuses others", async () => {
    const preflight = (origin: string, method: string, requestHeaders = "content-type") =>
      pub("OPTIONS", "/enquiries", undefined, { origin, "access-control-request-method": method, "access-control-request-headers": requestHeaders });
    const ok = await preflight(WEBSITE, "POST");
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(WEBSITE);
    expect(ok.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    expect(ok.headers["access-control-allow-headers"]).toBe("Content-Type");
    expect((await preflight("https://evil.test", "POST")).headers["access-control-allow-origin"]).toBeUndefined();
    expect((await preflight(WEBSITE, "DELETE")).headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
  });

  it("the website origin gets nothing on the staff or customer API, and the app origins get nothing on the public one", async () => {
    await app.close();
    app = await buildApp({ rateLimit: false, publicStockEnabled: true, publicOrigins: [WEBSITE], corsOrigins: ["https://app.example.test"] });
    const staffRes = await app.inject({ method: "GET", url: "/health", headers: { origin: WEBSITE } });
    expect(staffRes.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/health", headers: { origin: "https://app.example.test" } })).headers["access-control-allow-origin"]).toBe("https://app.example.test");
    const appOnPublic = await pub("GET", "/stock", undefined, { origin: "https://app.example.test" });
    expect(appOnPublic.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("public routes ignore credentials entirely: a staff token changes nothing", async () => {
    stock({ status: "DRAFT", publishedAt: null });
    const res = await pub("GET", "/stock", undefined, { authorization: (await staffHeaders("ADMINISTRATOR")).authorization });
    expect(res.json().data.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the enquiry form", () => {
  const valid = { name: "Visitor Name", email: "Visitor@Example.test", phone: "+81 3 1234 5678", message: "Is this still available?" };
  const send = (body: unknown, ip = "10.0.0.1") => pub("POST", "/enquiries", body, {}, ip);
  const alerts = () => rows("notification").filter((n) => n["event"] === "ENQUIRY_RECEIVED");

  beforeEach(() => {
    fake.seed("user", { id: "staff_op", org_id: ORG_A, userType: "STAFF", name: "Operator", role: "OPERATOR", loginEnabled: true });
  });

  it("stores the enquiry, answers 202 with the same body as every other outcome, and tells managers (not operators)", async () => {
    const id = stock();
    const res = await send({ ...valid, stockSlug: `car-${id}` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ data: { accepted: true } });
    expect(rows("enquiry")).toMatchObject([{ org_id: ORG_A, name: "Visitor Name", email: "visitor@example.test", phone: "+81 3 1234 5678", message: "Is this still available?", stockSlug: `car-${id}` }]);
    expect(rows("enquiry")[0]!["handledAt"] ?? null).toBeNull();
    expect(alerts().map((n) => n["userId"])).toEqual(["staff_a1"]);
    expect(alerts()[0]).toMatchObject({ title: "New website enquiry", body: "From Visitor Name. Open the enquiries inbox to read it." });
    expect(JSON.stringify(alerts())).not.toContain("still available");
  });

  it("an unknown, draft or other-org listing is dropped from the enquiry, with the same answer", async () => {
    const draft = stock({ status: "DRAFT", publishedAt: null });
    for (const stockSlug of ["nope", `car-${draft}`]) {
      const res = await send({ ...valid, stockSlug }, `10.0.1.${stockSlug.length}`);
      expect(res.json()).toEqual({ data: { accepted: true } });
    }
    expect(rows("enquiry").map((e) => e["stockSlug"] ?? null)).toEqual([null, null]);
  });

  it("the honeypot: a filled hidden field gets the normal answer and nothing is kept or announced", async () => {
    const res = await send({ ...valid, website: "https://spam.example.test" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ data: { accepted: true } });
    expect(rows("enquiry")).toHaveLength(0);
    expect(rows("notification")).toHaveLength(0);
    expect((await send({ ...valid, website: "" }, "10.0.0.9")).statusCode).toBe(202);
    expect(rows("enquiry")).toHaveLength(1);
  });

  it.each([
    ["a missing name", { ...valid, name: undefined }],
    ["an empty name", { ...valid, name: "  " }],
    ["a long name", { ...valid, name: "n".repeat(101) }],
    ["a bad email", { ...valid, email: "not-an-email" }],
    ["a long email", { ...valid, email: `${"a".repeat(150)}@example.test` }],
    ["a bad phone", { ...valid, phone: "call me maybe" }],
    ["a missing message", { ...valid, message: undefined }],
    ["a long message", { ...valid, message: "m".repeat(2001) }],
    ["control characters", { ...valid, message: "bad\u0000message" }],
    ["a bad slug", { ...valid, stockSlug: "../../x" }],
    ["an unknown field", { ...valid, role: "ADMINISTRATOR" }],
    ["an org id", { ...valid, org_id: ORG_B }],
    ["a long honeypot", { ...valid, website: "w".repeat(301) }],
  ])("rejects %s with a 400 and stores nothing", async (_n, body) => {
    expect((await send(body)).statusCode).toBe(400);
    expect(rows("enquiry")).toHaveLength(0);
  });

  it("refuses a body over 8 KB before parsing it", async () => {
    const res = await send({ ...valid, message: "x".repeat(9000) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Invalid request."); // the parser's refusal, not our validation (which has field errors)
    expect(res.json().error.fieldErrors).toBeUndefined();
    expect(rows("enquiry")).toHaveLength(0);
  });

  it("accepts a message of exactly 2000 characters", async () => {
    expect((await send({ ...valid, message: "x".repeat(2000) })).statusCode).toBe(202);
    expect(rows("enquiry")).toHaveLength(1);
  });

  describe("rate limits", () => {
    it("3 per email per hour, then 429 with Retry-After", async () => {
      const codes: number[] = [];
      for (let i = 0; i < 4; i += 1) codes.push((await send(valid, `10.0.2.${i}`)).statusCode);
      expect(codes).toEqual([202, 202, 202, 429]);
      expect((await send(valid, "10.0.2.9")).headers["retry-after"]).toBe("3600");
      expect((await send({ ...valid, email: "other@example.test" }, "10.0.2.10")).statusCode).toBe(202);
    });

    it("10 per IP per hour (different addresses), then 429; another IP is unaffected", async () => {
      expect(PUBLIC_RATE_LIMITS.enquiryIpHour.max).toBe(10);
      const codes: number[] = [];
      for (let i = 0; i < 11; i += 1) codes.push((await send({ ...valid, email: `v${i}@example.test` }, "10.0.3.1")).statusCode);
      expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
      expect(codes[10]).toBe(429);
      expect((await send({ ...valid, email: "fresh@example.test" }, "10.0.3.2")).statusCode).toBe(202);
    });

    it("honeypot hits count against the limits too", async () => {
      for (let i = 0; i < 3; i += 1) await send({ ...valid, website: "spam" }, `10.0.4.${i}`);
      expect((await send(valid, "10.0.4.9")).statusCode).toBe(429);
    });

    it("the per-minute burst limit per IP is enforced by the route (5 a minute)", async () => {
      await app.close();
      app = await buildApp({ rateLimit: true, publicStockEnabled: true, publicOrigins: [WEBSITE] });
      const codes: number[] = [];
      for (let i = 0; i < 7; i += 1) codes.push((await send({ ...valid, email: `b${i}@example.test` }, "10.0.5.1")).statusCode);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Cloudflare Turnstile", () => {
    const withSecret = async () => {
      await app.close();
      vi.stubEnv("TURNSTILE_SECRET", "test-turnstile-secret");
      vi.resetModules();
      const { buildApp: build } = await import("../src/app.js");
      app = await build({ rateLimit: false, publicStockEnabled: true, publicOrigins: [WEBSITE] });
    };
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("is skipped when TURNSTILE_SECRET is not set (no network call)", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      expect((await send(valid)).statusCode).toBe(202);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("when set: a valid token passes, a missing, wrong or unverifiable one fails closed, and the secret is only sent to Cloudflare", async () => {
      await withSecret();
      const fetchSpy = vi.fn(async (_url: string, init?: { body?: URLSearchParams }) => {
        const token = init?.body?.get("response");
        return new Response(JSON.stringify({ success: token === "good-token" }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchSpy);
      expect((await send({ ...valid, turnstileToken: "good-token" }, "10.0.6.1")).statusCode).toBe(202);
      expect((await send({ ...valid, email: "b@example.test", turnstileToken: "bad-token" }, "10.0.6.2")).statusCode).toBe(400);
      expect((await send({ ...valid, email: "c@example.test" }, "10.0.6.3")).statusCode).toBe(400);
      expect(rows("enquiry")).toHaveLength(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      expect((init as { body: URLSearchParams }).body.get("secret")).toBe("test-turnstile-secret");

      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
      const down = await send({ ...valid, email: "d@example.test", turnstileToken: "good-token" }, "10.0.6.4");
      expect(down.statusCode).toBe(400);
      expect(down.body).not.toContain("test-turnstile-secret");
      expect(rows("enquiry")).toHaveLength(1);
    });
  });

  it("never writes what the visitor typed to a log, an error or a notification", async () => {
    const secretWords = "ZEBRA-PRIVATE-MESSAGE-4711";
    const logged: string[] = [];
    for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    await send({ ...valid, message: secretWords });
    await send({ ...valid, message: secretWords, email: "bad" }, "10.0.7.1");
    await send({ ...valid, message: secretWords + "x".repeat(9000) }, "10.0.7.2");
    await send({ ...valid, message: secretWords, website: "bot" }, "10.0.7.3");
    expect(logged.join("\n")).not.toMatch(/ZEBRA|visitor@example|Visitor Name/i);
    expect(JSON.stringify(rows("notification"))).not.toContain("ZEBRA");
    expect(JSON.stringify(rows("activityLog"))).not.toContain("ZEBRA");
  });

  describe("the staff inbox", () => {
    beforeEach(async () => {
      await send(valid);
      await send({ ...valid, email: "second@example.test", name: "Second Visitor" }, "10.0.8.1");
    });

    it("lists enquiries newest first for ADMINISTRATOR and MANAGER, only for their org", async () => {
      fake.seed("enquiry", { id: "enq_b", org_id: ORG_B, name: "B", email: "b@example.test", phone: null, message: "Other org", stockSlug: null, handledAt: null, createdAt: new Date() });
      const res = await staff("GET", "/enquiries", "MANAGER");
      expect(res.json().data.total).toBe(2);
      expect(res.json().data.rows[0]).toMatchObject({ name: "Second Visitor", handled: false });
      expect(Object.keys(res.json().data.rows[0]).sort()).toEqual(["createdAt", "email", "handled", "id", "message", "name", "phone", "stockSlug"]);
      expect(res.body).not.toContain("Other org");
      expect((await staff("GET", "/enquiries", "ADMINISTRATOR", undefined, ORG_B)).json().data.total).toBe(1);
    });

    it("marks handled and reopens with ActivityLog, filters by status, and another org's id is a 404", async () => {
      const id = rows("enquiry")[0]!["id"] as string;
      expect((await staff("POST", `/enquiries/${id}/handled`, "MANAGER", { handled: true })).json()).toEqual({ data: { id, handled: true } });
      expect((await staff("GET", "/enquiries?status=handled", "MANAGER")).json().data.rows.map((r: { id: string }) => r.id)).toEqual([id]);
      expect((await staff("GET", "/enquiries?status=open", "MANAGER")).json().data.total).toBe(1);
      await staff("POST", `/enquiries/${id}/handled`, "MANAGER", { handled: false });
      expect(logs("HANDLE_ENQUIRY")).toHaveLength(1);
      expect(logs("REOPEN_ENQUIRY")).toHaveLength(1);
      expect(JSON.stringify(rows("activityLog"))).not.toContain("still available");

      expect((await staff("POST", `/enquiries/${id}/handled`, "MANAGER", { handled: true }, ORG_B)).statusCode).toBe(404);
      for (const bad of [{}, { handled: "yes" }, { handled: true, extra: 1 }]) expect((await staff("POST", `/enquiries/${id}/handled`, "MANAGER", bad)).statusCode).toBe(400);
      for (const q of ["status=nope", "pageSize=51", "orgId=x"]) expect((await staff("GET", `/enquiries?${q}`, "MANAGER")).statusCode, q).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("staff stock: access", () => {
  const ROUTES: [string, string, unknown?][] = [
    ["GET", "/stock"],
    ["POST", "/stock", { make: "A", model: "B" }],
    ["GET", "/stock/sv1"],
    ["PATCH", "/stock/sv1", { colour: "Red" }],
    ["DELETE", "/stock/sv1"],
    ["POST", "/stock/sv1/publish", {}],
    ["POST", "/stock/sv1/unpublish", {}],
    ["POST", "/stock/sv1/mark-sold", {}],
    ["POST", "/stock/sv1/images/presign", { contentType: "image/jpeg", fileSize: 1000 }],
    ["POST", "/stock/sv1/images", { key: "stock/aaaaaaaaaaaaaaaa/x.jpg" }],
    ["POST", "/stock/sv1/images/reorder", { imageIds: ["a"] }],
    ["PATCH", "/stock/sv1/images/i1", { altText: "x" }],
    ["DELETE", "/stock/sv1/images/i1"],
    ["GET", "/enquiries"],
    ["POST", "/enquiries/e1/handled", { handled: true }],
  ];

  it("the roles are in one constant", () => {
    expect([...STOCK_ROLES]).toEqual(["ADMINISTRATOR", "MANAGER"]);
  });

  describe.each(ROUTES)("%s %s", (method, path, body) => {
    it("is 401 without a token and with a customer token", async () => {
      expect((await staff(method as "GET", path, null, body)).statusCode).toBe(401);
      const asCustomer = await app.inject({ method: method as "GET", url: `/api/v1${path}`, headers: await bearerFor("cust_a1"), ...(body === undefined ? {} : { payload: body as object }) });
      expect(asCustomer.statusCode).toBe(401);
    });
    it.each(ALL_ROLES.filter((r) => !STOCK_ROLES.includes(r)))("is 403 for %s and changes nothing", async (role) => {
      stock({ id: "sv1" });
      const before = JSON.stringify([rows("stockVehicle"), rows("stockImage"), rows("enquiry"), rows("activityLog")]);
      expect((await staff(method as "GET", path, role, body)).statusCode).toBe(403);
      expect(JSON.stringify([rows("stockVehicle"), rows("stockImage"), rows("enquiry"), rows("activityLog")])).toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("staff stock: management", () => {
  const draftBody = { make: "Gamma", model: "Three 1.5", year: 2019, price: 4500, mileageKm: 55000, bodyType: "Hatchback", fuel: "Petrol", transmission: "AT", colour: "Blue", description: "One owner." };

  async function createDraft(body: Record<string, unknown> = draftBody) {
    const res = await staff("POST", "/stock", "MANAGER", body);
    return { res, id: res.json().data?.id as string };
  }
  const addImage = async (id: string, n = 1) => {
    for (let i = 0; i < n; i += 1) {
      const { orgSegment } = await import("../src/lib/public-stock-storage.js");
      const key = `stock/${orgSegment(ORG_A)}/${randomUUID()}.jpg`;
      void i;
      expect((await staff("POST", `/stock/${id}/images`, "MANAGER", { key, altText: `Photo ${i}` })).statusCode).toBe(201);
    }
  };

  it("creates a DRAFT with a generated slug, never published, and logs it", async () => {
    const { res, id } = await createDraft();
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data).toMatchObject({ status: "DRAFT", make: "Gamma", model: "Three 1.5", price: { amount: 4500, currency: "LKR" }, publishedAt: null, images: [] });
    expect(data.slug).toMatch(/^gamma-three-1-5-2019-[0-9a-f]{6}$/);
    expect(row("stockVehicle", id)["org_id"]).toBe(ORG_A);
    expect(logs("CREATE_STOCK")).toMatchObject([{ actorId: "staff_a1", entityId: id, org_id: ORG_A }]);
    expect((await pub("GET", `/stock/${data.slug}`)).statusCode).toBe(404); // a draft is invisible
  });

  it.each([
    ["no make", { model: "x" }],
    ["an empty model", { make: "x", model: " " }],
    ["a year out of range", { make: "x", model: "y", year: 1800 }],
    ["a negative price", { make: "x", model: "y", price: -1 }],
    ["a zero price", { make: "x", model: "y", price: 0 }],
    ["a price with a fraction", { make: "x", model: "y", price: 4500.5 }],
    ["a text price", { make: "x", model: "y", price: "5" }],
    ["a price above the ceiling", { make: "x", model: "y", price: 2_000_000_001 }],
    ["a price with its currency", { make: "x", model: "y", price: { amount: 5, currency: "LKR" } }],
    ["the historical field name", { make: "x", model: "y", priceFob: 5000 }],
    ["a currency", { make: "x", model: "y", price: 5000, currency: "USD" }],
    ["a status", { make: "x", model: "y", status: "PUBLISHED" }],
    ["a slug", { make: "x", model: "y", slug: "mine" }],
    ["an org id", { make: "x", model: "y", org_id: ORG_B }],
    ["a long description", { make: "x", model: "y", description: "d".repeat(5001) }],
  ])("refuses to create with %s", async (_n, body) => {
    expect((await staff("POST", "/stock", "MANAGER", body)).statusCode).toBe(400);
    expect(rows("stockVehicle")).toHaveLength(0);
  });

  it("edits fields, clears them with null, logs before and after; status and slug cannot be edited", async () => {
    const { id } = await createDraft();
    const res = await staff("PATCH", `/stock/${id}`, "MANAGER", { colour: "Red", price: null, description: "" });
    expect(res.json().data).toMatchObject({ colour: "Red", price: null, description: null });
    expect(logs("UPDATE_STOCK")[0]).toMatchObject({ before: { colour: "Blue", price: 4500 }, after: { colour: "Red", price: null } });
    // a new price, and the old field name is refused
    expect((await staff("PATCH", `/stock/${id}`, "MANAGER", { price: 3_500_000 })).json().data.price).toEqual({ amount: 3_500_000, currency: "LKR" });
    expect((await staff("PATCH", `/stock/${id}`, "MANAGER", { priceFob: 3500000 })).statusCode).toBe(400);
    expect(row("stockVehicle", id)["priceFob"]).toBe(3_500_000);
    for (const bad of [{}, { status: "PUBLISHED" }, { slug: "x" }, { org_id: ORG_B }, { make: "" }, { year: "2020" }]) {
      expect((await staff("PATCH", `/stock/${id}`, "MANAGER", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("another org's stock is a 404 for every action, and nothing changes", async () => {
    const other = stock({ id: "sv_b", org_id: ORG_B });
    fake.seed("stockImage", { id: "img_b", org_id: ORG_B, stockVehicleId: other, key: "stock/bbbbbbbbbbbbbbbb/x.jpg", altText: null, sortOrder: 5, createdAt: new Date() });
    const before = JSON.stringify([rows("stockVehicle"), rows("stockImage")]);
    for (const [method, path, body] of [
      ["GET", `/stock/${other}`],
      ["PATCH", `/stock/${other}`, { colour: "Red" }],
      ["DELETE", `/stock/${other}`],
      ["POST", `/stock/${other}/publish`, {}],
      ["POST", `/stock/${other}/unpublish`, {}],
      ["POST", `/stock/${other}/mark-sold`, {}],
      ["POST", `/stock/${other}/images/presign`, { contentType: "image/jpeg", fileSize: 1000 }],
      ["POST", `/stock/${other}/images`, { key: "stock/aaaaaaaaaaaaaaaa/0123456789abcdef0123456789abcdef0123.jpg" }],
      ["POST", `/stock/${other}/images/reorder`, { imageIds: ["img_b"] }],
      ["PATCH", `/stock/${other}/images/img_b`, { altText: "x" }],
      ["DELETE", `/stock/${other}/images/img_b`],
    ] as [string, string, unknown?][]) {
      expect((await staff(method as "GET", path, "ADMINISTRATOR", body)).statusCode, `${method} ${path}`).toBe(404);
    }
    expect(JSON.stringify([rows("stockVehicle"), rows("stockImage")])).toBe(before);
    expect(rows("activityLog")).toHaveLength(0);
  });

  it("an image id that belongs to a different listing is a 404", async () => {
    const a = stock({ id: "sv_a" });
    const b = stock({ id: "sv_b2" });
    expect((await staff("PATCH", `/stock/${a}/images/img_${b}_1`, "MANAGER", { altText: "x" })).statusCode).toBe(404);
    expect((await staff("DELETE", `/stock/${a}/images/img_${b}_1`, "MANAGER")).statusCode).toBe(404);
    expect(rows("stockImage").some((i) => i["id"] === `img_${b}_1`)).toBe(true);
  });

  describe("publishing is an explicit action", () => {
    it("a draft with no image cannot be published", async () => {
      const { id } = await createDraft();
      const res = await staff("POST", `/stock/${id}/publish`, "MANAGER", {});
      expect(res.statusCode).toBe(400);
      expect(res.json().error.fieldErrors.images).toBeTruthy();
      expect(row("stockVehicle", id)["status"]).toBe("DRAFT");
    });

    it("draft -> published -> sold -> draft, each logged; only PUBLISHED is public", async () => {
      const { id, res } = await createDraft();
      const slug = res.json().data.slug as string;
      await addImage(id);
      const published = await staff("POST", `/stock/${id}/publish`, "MANAGER", {});
      expect(published.json().data).toMatchObject({ status: "PUBLISHED" });
      expect(published.json().data.publishedAt).toBeTruthy();
      expect((await pub("GET", `/stock/${slug}`)).statusCode).toBe(200);

      expect((await staff("POST", `/stock/${id}/mark-sold`, "MANAGER", {})).json().data.status).toBe("SOLD");
      expect((await pub("GET", `/stock/${slug}`)).statusCode).toBe(404);
      expect((await pub("GET", "/stock")).json().data.total).toBe(0);

      expect((await staff("POST", `/stock/${id}/unpublish`, "MANAGER", {})).json().data).toMatchObject({ status: "DRAFT", publishedAt: null });
      expect(logs("PUBLISH_STOCK")).toHaveLength(1);
      expect(logs("MARK_STOCK_SOLD")).toHaveLength(1);
      expect(logs("UNPUBLISH_STOCK")).toHaveLength(1);
    });

    it("an impossible change is a 409: publish twice, sell a draft", async () => {
      const { id } = await createDraft();
      await addImage(id);
      await staff("POST", `/stock/${id}/publish`, "MANAGER", {});
      expect((await staff("POST", `/stock/${id}/publish`, "MANAGER", {})).statusCode).toBe(409);
      const { id: draft } = await createDraft();
      expect((await staff("POST", `/stock/${draft}/mark-sold`, "MANAGER", {})).statusCode).toBe(409);
    });

    it("tells interested customers only when asked to, honouring their switches", async () => {
      fake.seed("user", { id: "cust_off", org_id: ORG_A, userType: "CUSTOMER", name: "Off", email: "off@example.test", loginEnabled: true, emailVerifiedAt: new Date(), deletedAt: null });
      fake.seed("notificationPreference", { id: "p1", org_id: ORG_A, userId: "cust_off", events: { NEW_STOCK: false }, departureLeadDays: 7, pushEnabled: true, emailEnabled: true, whatsappEnabled: false });
      const quiet = await createDraft();
      await addImage(quiet.id);
      await staff("POST", `/stock/${quiet.id}/publish`, "MANAGER", {});
      expect(rows("notification").filter((n) => n["event"] === "NEW_STOCK")).toHaveLength(0);

      const loud = await createDraft();
      await addImage(loud.id);
      expect((await staff("POST", `/stock/${loud.id}/publish`, "MANAGER", { notifyCustomers: true })).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      const sent = rows("notification").filter((n) => n["event"] === "NEW_STOCK");
      expect(sent.map((n) => n["userId"])).toEqual(["cust_a1"]);
      expect(sent[0]).toMatchObject({ title: "New stock", body: "Gamma Three 1.5 (2019) has just been added." });
      expect((await staff("POST", `/stock/${loud.id}/unpublish`, "MANAGER", { notifyCustomers: true })).statusCode).toBe(400);
    });
  });

  describe("images", () => {
    const store = () => {
      const calls: { presign: unknown[]; deleted: string[] } = { presign: [], deleted: [] };
      const impl: ObjectStore = {
        presignPut: async (args) => (calls.presign.push(args), `https://upload.example.test/${args.key}?sig=1`),
        getObject: async () => ({ kind: "missing" }),
        putObject: async () => undefined,
        deleteKey: async (key) => void calls.deleted.push(key),
      };
      setPublicStockStore(impl);
      return calls;
    };

    it("presigns an upload into this org's public stock prefix only, for image types only, with the size pinned", async () => {
      const calls = store();
      const { id } = await createDraft();
      const res = await staff("POST", `/stock/${id}/images/presign`, "MANAGER", { contentType: "image/webp", fileSize: 123456 });
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.key).toMatch(/^stock\/[0-9a-f]{16}\/[0-9a-f-]{36}\.webp$/);
      expect(data.key).not.toContain(ORG_A);
      expect(data.publicUrl).toBe(`${IMAGE_BASE}/${data.key}`);
      expect(data.expiresInSeconds).toBe(300);
      expect(calls.presign).toMatchObject([{ key: data.key, contentType: "image/webp", contentLength: 123456, expiresInSeconds: 300 }]);
      for (const bad of [
        { contentType: "image/svg+xml", fileSize: 10 },
        { contentType: "text/html", fileSize: 10 },
        { contentType: "application/pdf", fileSize: 10 },
        { contentType: "image/jpeg", fileSize: 9 * 1024 * 1024 },
        { contentType: "image/jpeg", fileSize: 0 },
        { contentType: "image/jpeg", fileSize: 10, key: "stock/x" },
      ]) {
        expect((await staff("POST", `/stock/${id}/images/presign`, "MANAGER", bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
    });

    it("refuses to presign when public image storage is not configured", async () => {
      const { id } = await createDraft();
      const res = await staff("POST", `/stock/${id}/images/presign`, "MANAGER", { contentType: "image/jpeg", fileSize: 1000 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe("Stock image uploads are not configured.");
    });

    it("registers only keys this API issued for this org; another org's, a private file's and a made-up key are refused", async () => {
      const { orgSegment } = await import("../src/lib/public-stock-storage.js");
      const { id } = await createDraft();
      const uuid = "0123456789abcdef0123456789abcdef0123";
      const good = `stock/${orgSegment(ORG_A)}/${uuid}.jpg`;
      for (const bad of [
        `stock/${orgSegment(ORG_B)}/${uuid}.jpg`,
        `org/${ORG_A}/vehicles/v1/photos/x.jpg`,
        `stock/${orgSegment(ORG_A)}/../${uuid}.jpg`,
        `stock/${orgSegment(ORG_A)}/${uuid}.svg`,
        `stock/${orgSegment(ORG_A)}/${uuid}.html`,
        `stock/${orgSegment(ORG_A)}/short.jpg`,
        "https://evil.test/a.jpg",
        "",
      ]) {
        expect((await staff("POST", `/stock/${id}/images`, "MANAGER", { key: bad })).statusCode, bad).toBe(400);
      }
      expect(rows("stockImage")).toHaveLength(0);
      expect((await staff("POST", `/stock/${id}/images`, "MANAGER", { key: good, altText: "Front" })).statusCode).toBe(201);
      expect((await staff("POST", `/stock/${id}/images`, "MANAGER", { key: good })).statusCode).toBe(409); // already in use
    });

    it("orders images, edits alt text, reorders (exactly the listing's own images), and deletes with the object", async () => {
      const calls = store();
      const { id } = await createDraft();
      await addImage(id, 3);
      const listing = (await staff("GET", `/stock/${id}`, "MANAGER")).json().data;
      expect(listing.images.map((i: { sortOrder: number }) => i.sortOrder)).toEqual([0, 1, 2]);
      const [first, second, third] = listing.images.map((i: { id: string }) => i.id) as string[];

      await staff("PATCH", `/stock/${id}/images/${first}`, "MANAGER", { altText: "  Rear view  " });
      expect(row("stockImage", first!)["altText"]).toBe("Rear view");

      const reordered = await staff("POST", `/stock/${id}/images/reorder`, "MANAGER", { imageIds: [third, first, second] });
      expect(reordered.json().data.images.map((i: { id: string }) => i.id)).toEqual([third, first, second]);
      for (const bad of [{ imageIds: [first, second] }, { imageIds: [first, first, second] }, { imageIds: [first, second, "other"] }, { imageIds: [] }]) {
        expect((await staff("POST", `/stock/${id}/images/reorder`, "MANAGER", bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }

      const key = row("stockImage", second!)["key"] as string;
      expect((await staff("DELETE", `/stock/${id}/images/${second}`, "MANAGER")).json().data.images).toHaveLength(2);
      expect(calls.deleted).toEqual([key]);
      expect(logs("ADD_STOCK_IMAGE")).toHaveLength(3);
      expect(logs("UPDATE_STOCK_IMAGE")).toHaveLength(1);
      expect(logs("REORDER_STOCK_IMAGES")).toHaveLength(1);
      expect(logs("DELETE_STOCK_IMAGE")).toHaveLength(1);
    });

    it("a published listing keeps at least one image, and a listing has at most 20", async () => {
      const { id } = await createDraft();
      await addImage(id);
      await staff("POST", `/stock/${id}/publish`, "MANAGER", {});
      const imageId = rows("stockImage")[0]!["id"] as string;
      expect((await staff("DELETE", `/stock/${id}/images/${imageId}`, "MANAGER")).statusCode).toBe(409);
      const { id: full } = await createDraft();
      await addImage(full, 20);
      const { orgSegment } = await import("../src/lib/public-stock-storage.js");
      const extra = `stock/${orgSegment(ORG_A)}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg`;
      expect((await staff("POST", `/stock/${full}/images`, "MANAGER", { key: extra })).statusCode).toBe(409);
    });

    it("deleting a listing deletes its images and their objects", async () => {
      const calls = store();
      const { id } = await createDraft();
      await addImage(id, 2);
      expect((await staff("DELETE", `/stock/${id}`, "MANAGER")).json()).toEqual({ data: { deleted: true } });
      expect(rows("stockVehicle")).toHaveLength(0);
      expect(rows("stockImage")).toHaveLength(0);
      expect(calls.deleted).toHaveLength(2);
      expect(logs("DELETE_STOCK")).toHaveLength(1);
    });
  });

  it("the staff list shows every status; the status filter and paging work", async () => {
    stock({ id: "p1" });
    stock({ id: "d1", status: "DRAFT", publishedAt: null });
    stock({ id: "s1", status: "SOLD" });
    stock({ id: "o1", org_id: ORG_B });
    expect((await staff("GET", "/stock", "MANAGER")).json().data.total).toBe(3);
    expect((await staff("GET", "/stock?status=DRAFT", "MANAGER")).json().data.rows.map((r: { id: string }) => r.id)).toEqual(["d1"]);
    expect((await staff("GET", "/stock?pageSize=2", "MANAGER")).json().data.rows).toHaveLength(2);
    for (const q of ["status=NOPE", "pageSize=51", "orgId=x"]) expect((await staff("GET", `/stock?${q}`, "MANAGER")).statusCode, q).toBe(400);
  });
});
