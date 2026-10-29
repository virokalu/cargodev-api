// docs/website-integration.md is the contract the website is built against. This test reads the JSON examples out of that
// document (each one a fenced block whose info string is `json contract:<name>`) and compares them with what the real code
// returns for fake data, so the document fails CI the moment the API and the doc disagree. Fake data only.
//
//  - Response examples: the SHAPE must match (every key path and every value type, arrays by their first element).
//  - Error examples: the whole body must match exactly (code, message, fieldErrors).
//  - `limits`: every number the website developer is told must equal the one the code enforces.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { createFakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A } from "./helpers/fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { buildApp } from "../src/app.js";
import { ENQUIRY_BODY_LIMIT_BYTES, PUBLIC_CACHE_SECONDS, PUBLIC_DEFAULT_PAGE_SIZE, PUBLIC_MAX_PAGE_SIZE, PUBLIC_RATE_LIMITS, STOCK_PRICE_CURRENCY } from "../src/config/public-stock.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { PUBLIC_SORTS } from "../src/validation/stock.schema.js";

const DOC_PATH = fileURLToPath(new URL("../docs/website-integration.md", import.meta.url));
const DOC = readFileSync(DOC_PATH, "utf8");
const WEBSITE = "https://www.example.test";

/** Every ```json contract:<name> block in the document, parsed. A name used twice, or a block that is not JSON, fails. */
function docExamples(): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  for (const match of DOC.matchAll(/^```json contract:([a-z0-9-]+)\r?\n([\s\S]*?)\r?\n```/gm)) {
    const name = match[1]!;
    if (name in found) throw new Error(`contract example "${name}" appears twice in the document`);
    try {
      found[name] = JSON.parse(match[2]!);
    } catch {
      throw new Error(`contract example "${name}" is not valid JSON`);
    }
  }
  return found;
}

/** Every key path with the type of its value; arrays are described by their first element ("[]"), so the example may be short. */
function shape(value: unknown, path = "$", out: Record<string, string> = {}): Record<string, string> {
  if (Array.isArray(value)) {
    out[path] = "array";
    if (value.length > 0) shape(value[0], `${path}[]`, out);
  } else if (value !== null && typeof value === "object") {
    out[path] = "object";
    for (const [key, inner] of Object.entries(value)) shape(inner, `${path}.${key}`, out);
  } else {
    out[path] = value === null ? "null" : typeof value;
  }
  return out;
}

let app: FastifyInstance;
let fake: FakePrisma;
const examples = docExamples();
const example = (name: string): unknown => {
  if (!(name in examples)) throw new Error(`the document has no \`json contract:${name}\` block`);
  return examples[name];
};

function seedStock(over: Record<string, unknown> = {}) {
  fake.seed("stockVehicle", {
    id: "sv1",
    org_id: ORG_A,
    slug: "example-make-example-model-2020-a1b2c3",
    make: "Example Make",
    model: "Example Model",
    year: 2020,
    priceFob: 8500000,
    mileageKm: 42000,
    bodyType: "Sedan",
    fuel: "Petrol",
    transmission: "Automatic",
    colour: "White",
    description: "A clean example with a full service history.",
    status: "PUBLISHED",
    publishedAt: new Date("2026-01-15T09:30:00.000Z"),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  fake.seed(
    "stockImage",
    { id: "img1", org_id: ORG_A, stockVehicleId: "sv1", key: "stock/aaaaaaaaaaaaaaaa/11111111-1111-1111-1111-111111111111.jpg", altText: "Front view", sortOrder: 0, createdAt: new Date() },
    { id: "img2", org_id: ORG_A, stockVehicleId: "sv1", key: "stock/aaaaaaaaaaaaaaaa/22222222-2222-2222-2222-222222222222.jpg", altText: null, sortOrder: 1, createdAt: new Date() }
  );
}

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url: `/api/public${url}`, headers });
const post = (body: unknown, remoteAddress = "10.9.0.1") => app.inject({ method: "POST", url: "/api/public/enquiries", payload: body as object, remoteAddress });
const valid = { name: "Example Visitor", email: "visitor@example.test", message: "Is this still available?" };

beforeEach(async () => {
  fake = createFakePrisma();
  state.fake = fake;
  identifierLimiter.reset();
  app = await buildApp({ rateLimit: false, publicStockEnabled: true, publicOrigins: [WEBSITE] });
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("docs/website-integration.md: header", () => {
  it("states a contract version and date at the top", () => {
    const head = DOC.split("\n").slice(0, 12).join("\n");
    expect(head).toMatch(/Contract version:\s*\*{0,2}\s*\d+\.\d+\.\d+/);
    expect(head).toMatch(/Date:\s*\*{0,2}\s*\d{4}-\d{2}-\d{2}/);
  });

  it("contains no hostnames, secrets or ids it should not (only example.test and placeholders)", () => {
    const hosts = [...DOC.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase());
    for (const host of hosts) expect(host, host).toMatch(/(^|\.)example\.test$|^challenges\.cloudflare\.com$/);
    expect(DOC).not.toMatch(/r2\.dev|r2\.cloudflarestorage|supabase|onrender|[0-9a-f]{32}/i);
  });
});

describe("docs/website-integration.md: success examples match the real DTOs", () => {
  it("stock list: the envelope, the card and the price and image objects have the documented keys and types", async () => {
    seedStock();
    const res = await get("/stock");
    expect(res.statusCode).toBe(200);
    expect(shape(example("stock-list"))).toEqual(shape(res.json()));
  });

  it("stock detail: the card keys plus description and images", async () => {
    seedStock();
    const res = await get("/stock/example-make-example-model-2020-a1b2c3");
    expect(res.statusCode).toBe(200);
    expect(shape(example("stock-detail"))).toEqual(shape(res.json()));
  });

  it("the card key set is exactly the documented one and the detail adds exactly description and images", async () => {
    seedStock();
    const card = (await get("/stock")).json().data.rows[0];
    const detail = (await get("/stock/example-make-example-model-2020-a1b2c3")).json().data;
    expect(Object.keys((example("stock-list") as { data: { rows: object[] } }).data.rows[0]!).sort()).toEqual(Object.keys(card).sort());
    expect(Object.keys(detail).filter((k) => !(k in card)).sort()).toEqual(["description", "images"]);
  });

  it("a listing without a price, image or optional text still has every key (null, never missing)", async () => {
    seedStock({ priceFob: null, year: null, mileageKm: null, bodyType: null, fuel: null, transmission: null, colour: null, description: null });
    fake.rows("stockImage").splice(0);
    const detail = (await get("/stock/example-make-example-model-2020-a1b2c3")).json().data;
    const full = (example("stock-detail") as { data: Record<string, unknown> }).data;
    expect(Object.keys(detail).sort()).toEqual(Object.keys(full).sort());
    expect(detail.price).toBeNull();
    expect(detail.image).toBeNull();
    expect(detail.images).toEqual([]);
  });

  it("enquiry accepted", async () => {
    const res = await post(valid);
    expect(res.statusCode).toBe(202);
    expect(example("enquiry-accepted")).toEqual(res.json());
  });

  it("the example values follow the documented rules (LKR, whole-rupee number, ISO date, ordered images)", () => {
    const detail = (example("stock-detail") as { data: { price: { amount: number; currency: string }; publishedAt: string; image: { url: string }; images: { url: string }[]; slug: string } }).data;
    expect(detail.price.currency).toBe(STOCK_PRICE_CURRENCY);
    expect(Number.isInteger(detail.price.amount)).toBe(true);
    expect(new Date(detail.publishedAt).toISOString()).toBe(detail.publishedAt);
    expect(detail.image).toEqual(detail.images[0]);
    expect(detail.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("docs/website-integration.md: error examples are exactly what the API sends", () => {
  it("400 VALIDATION on a bad query, with fieldErrors per field", async () => {
    const res = await get("/stock?pageSize=99&sort=cheapest");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(example("error-validation-query"));
  });

  it("400 VALIDATION on a bad enquiry, with fieldErrors per field", async () => {
    const res = await post({ name: "", email: "not-an-email", message: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(example("error-validation-enquiry"));
  });

  it("400 VALIDATION on an unknown field has an empty fieldErrors object", async () => {
    const res = await post({ ...valid, role: "ADMINISTRATOR" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(example("error-validation-unknown-field"));
  });

  it("400 'Invalid request.' for a body over 8 KB (there is no 413) and for malformed JSON", async () => {
    const big = await post({ ...valid, message: "x".repeat(ENQUIRY_BODY_LIMIT_BYTES + 1) });
    expect(big.statusCode).toBe(400);
    expect(big.json()).toEqual(example("error-invalid-request"));
    const broken = await app.inject({ method: "POST", url: "/api/public/enquiries", headers: { "content-type": "application/json" }, payload: "{" });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toEqual(example("error-invalid-request"));
  });

  it("404 for an unknown, malformed, draft or sold listing: the same body each time", async () => {
    seedStock({ id: "sv9", slug: "draft-one", status: "DRAFT" });
    for (const slug of ["no-such-listing", "Not%20A%20Slug", "draft-one"]) {
      const res = await get(`/stock/${slug}`);
      expect(res.statusCode, slug).toBe(404);
      expect(res.json(), slug).toEqual(example("error-not-found"));
      expect(res.headers["cache-control"], slug).toBe("no-store");
    }
  });

  it("404 'Route not found.' for every public path when PUBLIC_STOCK_ENABLED is off", async () => {
    await app.close();
    app = await buildApp({ rateLimit: false, publicStockEnabled: false });
    for (const res of [await get("/stock"), await get("/stock/x"), await post(valid)]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(example("error-disabled"));
    }
  });

  it("429 RATE_LIMITED with Retry-After and the rate-limit headers", async () => {
    await app.close();
    app = await buildApp({ rateLimit: true, publicStockEnabled: true, publicOrigins: [WEBSITE] });
    const codes: number[] = [];
    let limited;
    for (let i = 0; i <= PUBLIC_RATE_LIMITS.enquiryIpBurst.max; i += 1) {
      const res = await post({ ...valid, email: `v${i}@example.test` }, "10.9.1.1");
      codes.push(res.statusCode);
      if (res.statusCode === 429) limited = res;
    }
    expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
    expect(limited!.json()).toEqual(example("error-rate-limited"));
    expect(limited!.headers["retry-after"]).toBe("60");
    expect(limited!.headers["x-ratelimit-limit"]).toBe(String(PUBLIC_RATE_LIMITS.enquiryIpBurst.max));
    expect(limited!.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited!.headers["x-ratelimit-reset"]).toBeDefined();
    expect(limited!.headers["cache-control"]).toBe("no-store");
  });

  it("400 'Verification failed.' when TURNSTILE_SECRET is set and the token is missing or wrong", async () => {
    await app.close();
    vi.stubEnv("TURNSTILE_SECRET", "test-turnstile-secret");
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })));
    const { buildApp: build } = await import("../src/app.js");
    app = await build({ rateLimit: false, publicStockEnabled: true, publicOrigins: [WEBSITE] });
    for (const body of [valid, { ...valid, turnstileToken: "wrong-token" }]) {
      const res = await post(body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual(example("error-verification-failed"));
    }
  });
});

describe("docs/website-integration.md: the numbers match the code", () => {
  type Limits = {
    pagination: { defaultPageSize: number; maxPageSize: number; maxPage: number };
    sorts: string[];
    cacheMaxAgeSeconds: number;
    searchMaxLength: number;
    enquiry: Record<string, number>;
    bodyLimitBytes: number;
    rateLimits: Record<string, { max: number; windowSeconds: number }>;
  };
  const limits = () => example("limits") as Limits;

  it("pagination, sort keys, cache lifetime, body limit and rate limits equal the configuration", () => {
    const l = limits();
    expect(l.pagination).toEqual({ defaultPageSize: PUBLIC_DEFAULT_PAGE_SIZE, maxPageSize: PUBLIC_MAX_PAGE_SIZE, maxPage: 10000 });
    expect(l.sorts).toEqual([...PUBLIC_SORTS]);
    expect(l.cacheMaxAgeSeconds).toBe(PUBLIC_CACHE_SECONDS);
    expect(l.bodyLimitBytes).toBe(ENQUIRY_BODY_LIMIT_BYTES);
    const seconds = (w: { windowMs: number }) => w.windowMs / 1000;
    const r = PUBLIC_RATE_LIMITS;
    expect(l.rateLimits).toEqual({
      read: { max: r.read.max, windowSeconds: seconds(r.read) },
      enquiryIpBurst: { max: r.enquiryIpBurst.max, windowSeconds: seconds(r.enquiryIpBurst) },
      enquiryIpHour: { max: r.enquiryIpHour.max, windowSeconds: seconds(r.enquiryIpHour) },
      enquiryEmailHour: { max: r.enquiryEmailHour.max, windowSeconds: seconds(r.enquiryEmailHour) },
    });
  });

  it("the page-size limits are enforced as documented", async () => {
    const { defaultPageSize, maxPageSize, maxPage } = limits().pagination;
    expect((await get(`/stock?pageSize=${maxPageSize}`)).json().data.pageSize).toBe(maxPageSize);
    expect((await get(`/stock?pageSize=${maxPageSize + 1}`)).statusCode).toBe(400);
    expect((await get("/stock?pageSize=0")).statusCode).toBe(400);
    expect((await get("/stock")).json().data.pageSize).toBe(defaultPageSize);
    expect((await get(`/stock?page=${maxPage}`)).statusCode).toBe(200);
    expect((await get(`/stock?page=${maxPage + 1}`)).statusCode).toBe(400);
    expect((await get("/stock?page=0")).statusCode).toBe(400);
  });

  it("every documented sort key is accepted and any other is refused", async () => {
    for (const sort of limits().sorts) expect((await get(`/stock?sort=${sort}`)).statusCode, sort).toBe(200);
    expect((await get("/stock?sort=random")).statusCode).toBe(400);
  });

  it("the search text is cut at the documented length, not refused", async () => {
    const max = limits().searchMaxLength;
    expect((await get(`/stock?q=${"a".repeat(max + 50)}`)).statusCode).toBe(200);
  });

  it("the enquiry field limits are enforced at exactly the documented size", async () => {
    const l = limits().enquiry;
    let n = 0;
    // A fresh address and email each time, so the per-IP and per-email hourly limits never interfere.
    const ok = async (field: string, value: string) => {
      n += 1;
      return (await post({ ...valid, email: `visitor${n}@example.test`, [field]: value }, `10.9.${Math.floor(n / 200)}.${(n % 200) + 1}`)).statusCode;
    };
    // local part 40 + "@" + a two-label domain: exactly `length` characters, every label within the 63 limit.
    const emailOfLength = (length: number) => `${"a".repeat(40)}@${"b".repeat(60)}.${"c".repeat(length - 41 - 60 - 1 - 5)}.test`;
    expect(await ok("name", "n".repeat(l["nameMax"]!))).toBe(202);
    expect(await ok("name", "n".repeat(l["nameMax"]! + 1))).toBe(400);
    expect(await ok("message", "m".repeat(l["messageMax"]!))).toBe(202);
    expect(await ok("message", "m".repeat(l["messageMax"]! + 1))).toBe(400);
    expect(await ok("email", emailOfLength(l["emailMax"]!))).toBe(202);
    expect(await ok("email", emailOfLength(l["emailMax"]! + 1))).toBe(400);
    expect(await ok("phone", "1".repeat(l["phoneMin"]!))).toBe(202);
    expect(await ok("phone", "1".repeat(l["phoneMin"]! - 1))).toBe(400);
    expect(await ok("phone", "1".repeat(l["phoneMax"]!))).toBe(202);
    expect(await ok("phone", "1".repeat(l["phoneMax"]! + 1))).toBe(400);
    expect(await ok("website", "w".repeat(l["websiteMax"]!))).toBe(202);
    expect(await ok("website", "w".repeat(l["websiteMax"]! + 1))).toBe(400);
    expect(await ok("turnstileToken", "t".repeat(l["turnstileTokenMax"]!))).toBe(202);
    expect(await ok("turnstileToken", "t".repeat(l["turnstileTokenMax"]! + 1))).toBe(400);
    expect(await ok("stockSlug", "s".repeat(l["stockSlugMax"]!))).toBe(202);
    expect(await ok("stockSlug", "s".repeat(l["stockSlugMax"]! + 1))).toBe(400);
  });
});

describe("docs/website-integration.md: headers", () => {
  it("successful GETs are public, max-age=<documented>; the POST and errors are no-store; there is no ETag; Vary is Origin", async () => {
    seedStock();
    const maxAge = (example("limits") as { cacheMaxAgeSeconds: number }).cacheMaxAgeSeconds;
    for (const res of [await get("/stock"), await get("/stock/example-make-example-model-2020-a1b2c3")]) {
      expect(res.headers["cache-control"]).toBe(`public, max-age=${maxAge}`);
      expect(res.headers["etag"]).toBeUndefined();
      expect(res.headers["vary"]).toBe("Origin");
    }
    expect((await post(valid)).headers["cache-control"]).toBe("no-store");
    expect((await get("/stock?sort=x")).headers["cache-control"]).toBe("no-store");
  });

  it("CORS: an allow-listed origin is echoed (never *), anything else gets no CORS header, preflight allows GET, POST, OPTIONS and Content-Type only", async () => {
    const allowed = await get("/stock", { origin: WEBSITE });
    expect(allowed.headers["access-control-allow-origin"]).toBe(WEBSITE);
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
    expect((await get("/stock", { origin: "https://other.example.test" })).headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await app.inject({ method: "OPTIONS", url: "/api/public/enquiries", headers: { origin: WEBSITE, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    expect(pre.headers["access-control-allow-headers"]).toBe("Content-Type");
    expect(pre.headers["access-control-max-age"]).toBe("600");
  });
});
