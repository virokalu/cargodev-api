// docs/staff-frontend-integration.md cannot drift from the code:
//  - every `json example:<id> <status>` block is compared, key set for key set, with what the REAL route returns for fake data
//    (recipes in tests/helpers/staff-contract-examples.ts);
//  - every /api/v1 route of the route inventory must be in the doc's role matrix (and have its own section), and the roles in the
//    matrix and in each section must equal the roles of the inventory table;
//  - the numbers in the `facts` block equal the constants in the code.
// Fake data only.

import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { EXAMPLES, installFakeStorage, makeCtx, newContractWorld, removeFakeStorage } from "./helpers/staff-contract-examples.js";
import { ROUTE_TABLE } from "./route-inventory.table.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const state = vi.hoisted(() => {
  process.env["R2_PUBLIC_URL"] = "https://files.example.test";
  return { fake: undefined as unknown };
});
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { buildApp, GLOBAL_RATE_LIMIT } from "../src/app.js";
import { FILE_LINK_RATE_LIMIT } from "../src/config/file-link-rate-limits.js";
import { MAX_IMAGES_PER_STOCK, MAX_STOCK_IMAGE_BYTES } from "../src/config/public-stock.js";
import { MAX_MESSAGE_LENGTH } from "../src/config/chat.js";
import { HTTP_STATUS } from "../src/lib/errors.js";
import { ACCESS_TOKEN_TTL_SECONDS } from "../src/lib/mobile-jwt.js";
import { UPLOAD_URL_TTL_SECONDS } from "../src/lib/object-storage.js";
import { STREAM_RECHECK_MS } from "../src/lib/sse-route.js";
import { setTrustTokenClaimsForTests } from "../src/lib/staff-auth-seam.js";
import { clearStaffAuthCache } from "../src/services/staff-auth-state.service.js";
import { paginationQuerySchema } from "../src/validation/pagination.schema.js";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from "../src/validation/shared.js";
import { UPLOAD_LIMITS } from "../src/validation/upload.schema.js";
import { vehicleListQuerySchema } from "../src/validation/vehicle.schema.js";

const DOC = readFileSync("docs/staff-frontend-integration.md", "utf8");
const ROLES = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"] as const;

// ---- reading the doc -------------------------------------------------------------------------------------------------------

interface DocExample {
  id: string;
  status: number;
  json: unknown;
}

function docExamples(): DocExample[] {
  const found: DocExample[] = [];
  const lines = DOC.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^```json example:(\S+) (\d{3})$/.exec(lines[i] ?? "");
    if (!open) continue;
    const body: string[] = [];
    i += 1;
    while (i < lines.length && lines[i] !== "```") {
      body.push(lines[i] ?? "");
      i += 1;
    }
    found.push({ id: open[1]!, status: Number(open[2]), json: JSON.parse(body.join("\n")) });
  }
  return found;
}

function docFacts(): Record<string, unknown> {
  const match = /```json facts\r?\n([\s\S]*?)\r?\n```/.exec(DOC);
  if (!match) throw new Error("the doc has no `json facts` block");
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

/** `| GET | `/api/v1/x` | yes | yes | — | — |` -> key, cells */
function docMatrix(): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of DOC.split(/\r?\n/)) {
    const m = /^\| (GET|POST|PUT|PATCH|DELETE) \| `(\/api\/v1\/[^`]*)` \| (.+) \|$/.exec(line);
    if (m) rows.set(`${m[1]} ${m[2]}`, m[3]!.split(" | ").map((c) => c.trim()));
  }
  return rows;
}

/** `#### GET /api/v1/x` followed by `**Roles:** ...` */
function docSections(): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = DOC.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const h = /^#### (GET|POST|PUT|PATCH|DELETE) (\/\S+)$/.exec(lines[i] ?? "");
    if (!h) continue;
    const next = lines.slice(i + 1, i + 4).find((l) => l.startsWith("**Roles:**"));
    sections.set(`${h[1]} ${h[2]}`, next ?? "");
  }
  return sections;
}

// ---- comparing shapes ------------------------------------------------------------------------------------------------------

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Every difference in the KEY SETS of two JSON values ("" means the same). Values are not compared; null may stand for a nested object. */
function keyDiff(doc: unknown, real: unknown, path = "$"): string[] {
  if (doc === null || real === null) return path === "$" && doc !== real ? [`${path}: ${kind(doc)} vs ${kind(real)}`] : [];
  if (Array.isArray(doc) || Array.isArray(real)) {
    if (!Array.isArray(doc) || !Array.isArray(real)) return [`${path}: ${kind(doc)} vs ${kind(real)}`];
    if (doc.length === 0 || real.length === 0) return [];
    return keyDiff(doc[0], real[0], `${path}[0]`);
  }
  if (typeof doc === "object" && typeof real === "object") {
    const a = Object.keys(doc as object).sort();
    const b = Object.keys(real as object).sort();
    const out: string[] = [];
    for (const k of a) if (!b.includes(k)) out.push(`${path}.${k}: in the doc, not in the response`);
    for (const k of b) if (!a.includes(k)) out.push(`${path}.${k}: in the response, not in the doc`);
    for (const k of a) if (b.includes(k)) out.push(...keyDiff((doc as Record<string, unknown>)[k], (real as Record<string, unknown>)[k], `${path}.${k}`));
    return out;
  }
  return kind(doc) === kind(real) ? [] : [`${path}: ${kind(doc)} vs ${kind(real)}`];
}

// ---- the app ---------------------------------------------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
  setTrustTokenClaimsForTests(false); // roles come from the database rows, like in production
  installFakeStorage();
  state.fake = newContractWorld();
  app = await buildApp({ rateLimit: false, publicStockEnabled: true });
});
afterAll(async () => {
  await app.close();
  removeFakeStorage();
  setTrustTokenClaimsForTests(true);
});

describe("the examples in the doc are what the routes return", () => {
  const blocks = docExamples();

  it("the doc has examples, each with a recipe, and every recipe is shown", () => {
    expect(blocks.length).toBeGreaterThan(50);
    const recipes = new Set(EXAMPLES.map((e) => e.id));
    expect(blocks.filter((b) => !recipes.has(b.id)).map((b) => b.id), "blocks with no recipe").toEqual([]);
    const shown = new Set(blocks.map((b) => b.id));
    expect(EXAMPLES.filter((e) => !shown.has(e.id)).map((e) => e.id), "recipes the doc does not show").toEqual([]);
    expect(new Set(blocks.map((b) => b.id)).size, "an example id is used twice").toBe(blocks.length);
  });

  it.each(blocks.map((b) => [b.id, b] as const))("%s", async (_id, block) => {
    const recipe = EXAMPLES.find((e) => e.id === block.id)!;
    const fake = newContractWorld();
    state.fake = fake;
    clearStaffAuthCache();
    const reply = await recipe.run(makeCtx(app, fake));
    expect(reply.status, "the route's status").toBe(recipe.status);
    expect(block.status, "the status written in the doc").toBe(reply.status);
    expect(keyDiff(block.json, reply.body), `the doc's example ${block.id} differs from the real response`).toEqual([]);
  });
});

describe("every staff route is in the doc, with the roles the code allows", () => {
  const staffRoutes = ROUTE_TABLE.filter((e) => e.path.startsWith("/api/v1/"));
  const matrix = docMatrix();
  const sections = docSections();
  const keyOf = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

  it("the role matrix has exactly the /api/v1 routes of the inventory", () => {
    const wanted = staffRoutes.map(keyOf).sort();
    const have = [...matrix.keys()].sort();
    expect(wanted.filter((k) => !matrix.has(k)), "routes missing from the doc's role matrix").toEqual([]);
    expect(have.filter((k) => !wanted.includes(k)), "matrix rows with no route").toEqual([]);
  });

  it("each matrix row says what the inventory says, role by role", () => {
    const wrong: string[] = [];
    for (const e of staffRoutes) {
      const cells = matrix.get(keyOf(e));
      if (!cells) continue;
      const expected = ROLES.map((r) => (e.kind === "public" ? "public" : e.roles?.includes(r) ? (e.scoped ? "scoped" : "yes") : "—"));
      if (cells.join("|") !== expected.join("|")) wrong.push(`${keyOf(e)}: doc ${cells.join(",")} / code ${expected.join(",")}`);
    }
    expect(wrong).toEqual([]);
  });

  it("every route (except the lookup family, which the matrix covers) has its own section with a Roles line", () => {
    const missing = staffRoutes.filter((e) => !e.path.startsWith("/api/v1/lookups/") && !sections.has(keyOf(e))).map(keyOf);
    expect(missing, "routes with no `#### METHOD path` section").toEqual([]);
    const lookups = staffRoutes.filter((e) => e.path.startsWith("/api/v1/lookups/row-colour-statuses") && !sections.has(keyOf(e)));
    expect(lookups.map(keyOf)).toEqual([]);
    const stale = [...sections.keys()].filter((k) => !staffRoutes.some((e) => keyOf(e) === k));
    expect(stale, "sections for routes that do not exist").toEqual([]);
  });

  it("the Roles line of each section equals the inventory's roles", () => {
    const wrong: string[] = [];
    for (const e of staffRoutes) {
      const line = sections.get(keyOf(e));
      if (line === undefined) continue;
      const named = ROLES.filter((r) => new RegExp(`\\b${r}\\b`).test(line));
      const expected = e.kind === "public" ? [] : ROLES.filter((r) => e.roles?.includes(r));
      const scopedInDoc = /scoped/.test(line);
      if (named.join() !== expected.join() || scopedInDoc !== Boolean(e.scoped) || (e.kind === "public") !== /none \(public/.test(line)) {
        wrong.push(`${keyOf(e)}: doc "${line}" / code ${expected.join(",") || "public"}${e.scoped ? " scoped" : ""}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("the role rules written in prose still hold in the table", () => {
    const find = (m: string, p: string) => ROUTE_TABLE.find((e) => e.method === m && e.path === p)!;
    // OPERATOR is scoped on chat, VIEWER has no chat, administrators and managers see everything
    expect(find("GET", "/api/v1/chat/conversations").scoped).toBe("assigned customers");
    expect(find("GET", "/api/v1/chat/conversations").roles).toEqual(["ADMINISTRATOR", "MANAGER", "OPERATOR"]);
    // the activity log, the serial correction and the admin job are administrator-only
    for (const [m, p] of [["GET", "/api/v1/activity-log"], ["PATCH", "/api/v1/vehicles/:id/serial"], ["POST", "/api/v1/admin/jobs/daily-checks"], ["POST", "/api/v1/staff"]] as const) {
      expect(find(m, p).roles).toEqual(["ADMINISTRATOR"]);
    }
  });
});

describe("the facts block equals the code", () => {
  const facts = docFacts();

  it("limits and constants", () => {
    const page = paginationQuerySchema.parse({});
    expect(paginationQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ pageSize: 100 }).success).toBe(true);
    expect(facts).toMatchObject({
      accessTokenSeconds: ACCESS_TOKEN_TTL_SECONDS,
      globalRateLimitPerMinute: GLOBAL_RATE_LIMIT.max,
      fileLinkRateLimitPerMinute: FILE_LINK_RATE_LIMIT.max,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordBytes: MAX_PASSWORD_BYTES,
      defaultPageSize: page.pageSize,
      maxPageSize: 100,
      uploadUrlSeconds: UPLOAD_URL_TTL_SECONDS,
      maxImageBytes: UPLOAD_LIMITS.VEHICLE_PHOTO.maxBytes,
      maxDocumentBytes: UPLOAD_LIMITS.VEHICLE_DOCUMENT.maxBytes,
      maxStockImageBytes: MAX_STOCK_IMAGE_BYTES,
      maxImagesPerStockListing: MAX_IMAGES_PER_STOCK,
      maxChatMessageLength: MAX_MESSAGE_LENGTH,
      streamRecheckSeconds: STREAM_RECHECK_MS / 1000,
    });
    expect(UPLOAD_LIMITS.AUCTION_SHEET.maxBytes).toBe(UPLOAD_LIMITS.VEHICLE_PHOTO.maxBytes);
  });

  it("the error codes and their statuses", () => {
    expect(facts["errorStatuses"]).toEqual(HTTP_STATUS);
  });

  it("the vehicle list defaults: track FC, sort serial, direction desc", async () => {
    const parsed = vehicleListQuerySchema.parse({});
    expect(parsed.track).toBe(facts["defaultVehicleTrack"]);
    expect(parsed.sortBy).toBe(facts["defaultVehicleSort"]);
    expect(parsed.sortDir).toBe(facts["defaultVehicleSortDirection"]);
    // and the running route really orders that way (highest serial number first, converted vehicles included in FC)
    state.fake = newContractWorld();
    clearStaffAuthCache();
    const reply = await makeCtx(app, state.fake as FakePrisma).call("VIEWER", "GET", "/api/v1/vehicles?pageSize=100");
    const serials = (reply.body as { data: { rows: Array<{ serial: string }> } }).data.rows.map((r) => Number(r.serial.replace(/\D/g, "")));
    expect(serials.length).toBeGreaterThan(3);
    expect(serials).toEqual([...serials].sort((a, b) => b - a));
  });
});

describe("the document itself", () => {
  it("names its contract version and date at the top", () => {
    expect(DOC.split(/\r?\n/).slice(0, 5).join("\n")).toMatch(/\*\*Contract version:\*\* \d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\)/);
  });

  it("is linked from docs/api-contract.md", () => {
    expect(readFileSync("docs/api-contract.md", "utf8")).toContain("staff-frontend-integration.md");
  });

  it("contains no real-looking secret, host or token", () => {
    expect(DOC).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // a JWT
    expect(DOC).not.toMatch(/r2\.dev|r2\.cloudflarestorage|cloudflare|amazonaws|supabase|onrender\.com/i);
    expect(DOC).not.toMatch(/sig=[A-Za-z0-9_-]{20,}/); // a real signature
    const hosts = [...DOC.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase());
    expect(hosts.filter((h) => !h.endsWith("example.test") && h !== "localhost"), "hosts that are not placeholders").toEqual([]);
  });
});

describe("vehicle create and update answer with the detail shape", () => {
  const FORBIDDEN_KEYS = ["org_id", "orgId", "serialPrefix", "serialNumber", "deletedAt", "createdAt", "updatedAt"];

  async function detailKeys(fake: FakePrisma, serial: string): Promise<string[]> {
    const reply = await makeCtx(app, fake).call("MANAGER", "GET", `/api/v1/vehicles/${serial}`);
    expect(reply.status).toBe(200);
    return Object.keys((reply.body as { data: object }).data).sort();
  }

  it.each(["vehicles.create", "vehicles.update"])("%s returns exactly the keys of GET /vehicles/:serial", async (id) => {
    const fake = newContractWorld();
    state.fake = fake;
    clearStaffAuthCache();
    const reply = await EXAMPLES.find((e) => e.id === id)!.run(makeCtx(app, fake));
    const data = (reply.body as { data: Record<string, unknown> }).data;
    // create adds exactly one key to the detail shape: serialReused (since 1.8.0); update adds none
    const extra = id === "vehicles.create" ? ["serialReused"] : [];
    expect(Object.keys(data).sort()).toEqual([...(await detailKeys(fake, String(data["serial"]))), ...extra].sort());
    if (id === "vehicles.create") expect(typeof data["serialReused"]).toBe("boolean");
    for (const key of FORBIDDEN_KEYS) expect(data, `${id} leaks ${key}`).not.toHaveProperty(key);
  });
});

describe("exposed response headers", () => {
  it("the doc names exactly the headers the API exposes to browsers", async () => {
    const { CORS_EXPOSED_HEADERS } = await import("../src/app.js");
    const line = DOC.split(/\r?\n/).find((l) => l.startsWith("**CORS.**")) ?? "";
    for (const header of CORS_EXPOSED_HEADERS) expect(line, header).toContain(`\`${header}\``);
    expect(DOC).toContain("`X-Request-Id`");
    // written out on purpose: the expectation must not be derived from the code it checks
    expect([...CORS_EXPOSED_HEADERS].sort()).toEqual(["Retry-After", "X-Contract-Version", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "X-Request-Id"]);
  });
});

describe("the trusted forwarder section", () => {
  it("its worked example is the real signature for its fake secret, address and time", async () => {
    const { signForwardedAddress } = await import("../src/lib/trusted-forwarder.js");
    const match = /```json forwarder-example\r?\n([\s\S]*?)\r?\n```/.exec(DOC);
    expect(match, "the doc has no `json forwarder-example` block").not.toBeNull();
    const ex = JSON.parse(match![1]!) as { secret: string; ip: string; timestamp: number; signedText: string; signature: string; headers: Record<string, string> };
    expect(ex.signedText).toBe(`v1|${ex.ip}|${ex.timestamp}`);
    expect(ex.signature).toBe(signForwardedAddress(ex.secret, ex.ip, ex.timestamp));
    expect(ex.headers).toEqual({ "X-Client-IP": ex.ip, "X-Forwarder-Timestamp": String(ex.timestamp), "X-Forwarder-Signature": ex.signature });
  });

  it("the facts block carries the time windows the code enforces", async () => {
    const { FORWARDER_MAX_AGE_SECONDS, FORWARDER_MAX_FUTURE_SECONDS } = await import("../src/lib/trusted-forwarder.js");
    const facts = docFacts();
    expect(facts["forwarderMaxAgeSeconds"]).toBe(FORWARDER_MAX_AGE_SECONDS);
    expect(facts["forwarderMaxFutureSeconds"]).toBe(FORWARDER_MAX_FUTURE_SECONDS);
  });
});
