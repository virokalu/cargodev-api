// The route inventory: every route the API registers is classified, once, in tests/route-inventory.table.ts, and the
// real routes are compared with that table in BOTH directions. Then, for every route that is not public, the access rules
// are checked against the running app: 401 without a token, 401 for the other zone's token, 403 for every role not in the list.
// Fake data only.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ORG_A } from "./helpers/fixtures.js";
import { bearerFor, newCustomerFake } from "./helpers/customer-fixtures.js";
import { ROUTE_TABLE, type RouteEntry } from "./route-inventory.table.js";

vi.setConfig({ testTimeout: 60_000 });

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as { client: unknown }).client }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { setTrustTokenClaimsForTests } from "../src/lib/staff-auth-seam.js";
import { clearStaffAuthCache } from "../src/services/staff-auth-state.service.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const ROLES: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];
// One real user per role, so the chat scope (which reads the database) sees the same role as the token.
const USER: Record<Role, string> = { ADMINISTRATOR: "staff_admin", MANAGER: "staff_mgr", OPERATOR: "staff_op", VIEWER: "staff_vw" };

let app: FastifyInstance;
const registered: { method: string; url: string }[] = [];

beforeAll(async () => {
  // Every staff route here is checked against the DATABASE (role and active flag), not the token's claims.
  setTrustTokenClaimsForTests(false);
  clearStaffAuthCache();
  const fake = newCustomerFake();
  for (const role of ROLES) fake.seed("user", { id: USER[role], org_id: ORG_A, userType: "STAFF", role, name: role, loginEnabled: true });
  fake.seed("user", { id: "staff_off", org_id: ORG_A, userType: "STAFF", role: "ADMINISTRATOR", name: "Disabled Admin", loginEnabled: false });
  state.fake = fake;
  app = await buildApp({ rateLimit: false, publicStockEnabled: true, onRoute: (route) => registered.push(route) });
});
afterAll(async () => {
  await app.close();
  setTrustTokenClaimsForTests(true);
});

const key = (method: string, path: string) => `${method} ${path}`;
// HEAD is added automatically for every GET, and OPTIONS is the CORS preflight: neither is a route of ours.
const realRoutes = () => [...new Set(registered.filter((r) => r.method !== "HEAD" && r.method !== "OPTIONS").map((r) => key(r.method, r.url)))].sort();

const fill = (url: string) => url.replace(/:type\b/g, "BOUGHT").replace(/:[A-Za-z]+/g, "x1");

const staffHeaders = async (role: Role) => ({
  authorization: `Bearer ${await signAccessToken({ sub: USER[role], orgId: ORG_A, role, name: role, email: null })}`,
});

function send(entry: RouteEntry, headers: Record<string, string>) {
  return app.inject({
    method: entry.method as "GET",
    url: fill(entry.path),
    headers,
    ...(["POST", "PUT", "PATCH"].includes(entry.method) ? { payload: {} } : {}),
  });
}

describe("the table and the real routes are the same set", () => {
  it("every registered route is in the table", () => {
    const table = new Set(ROUTE_TABLE.map((e) => key(e.method, e.path)));
    const missing = realRoutes().filter((route) => !table.has(route));
    expect(missing, `Routes with no classification (add them to tests/route-inventory.table.ts on purpose):\n${missing.join("\n")}`).toEqual([]);
  });

  it("every table entry has a route", () => {
    const real = new Set(realRoutes());
    const stale = ROUTE_TABLE.map((e) => key(e.method, e.path)).filter((route) => !real.has(route));
    expect(stale, `Table entries with no route:\n${stale.join("\n")}`).toEqual([]);
  });

  it("no entry is listed twice", () => {
    const keys = ROUTE_TABLE.map((e) => key(e.method, e.path));
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it("a staff entry has a role list, and the other kinds have none", () => {
    for (const e of ROUTE_TABLE) {
      if (e.kind === "staff") expect(e.roles?.length, key(e.method, e.path)).toBeGreaterThan(0);
      else expect(e.roles, key(e.method, e.path)).toBeUndefined();
    }
  });

  it("the zones follow the prefixes: customer routes live under /api/customer/v1, staff routes under /api/v1", () => {
    for (const e of ROUTE_TABLE) {
      if (e.kind === "customer") expect(e.path.startsWith("/api/customer/v1/"), e.path).toBe(true);
      if (e.kind === "staff") expect(e.path.startsWith("/api/v1/"), e.path).toBe(true);
    }
  });

  it("public routes are only: health, sign-in / refresh / logout, the customer sign-up and password flows, the version check, and the website API", () => {
    const allowed = [
      /^GET \/health$/,
      /^POST \/api\/v1\/auth\/(login|refresh|logout)$/,
      /^POST \/api\/customer\/v1\/auth\/(register|verify-email|resend-verification|login|refresh|logout|forgot-password|reset-password)$/,
      /^GET \/api\/customer\/v1\/app\/min-version$/,
      /^(GET|POST) \/api\/public\//,
    ];
    const unexpected = ROUTE_TABLE.filter((e) => e.kind === "public").map((e) => key(e.method, e.path)).filter((k) => !allowed.some((re) => re.test(k)));
    expect(unexpected).toEqual([]);
  });
});

describe("public routes need no token", () => {
  it.each(ROUTE_TABLE.filter((e) => e.kind === "public").map((e) => [key(e.method, e.path), e] as const))("%s", async (_name, entry) => {
    expect((await send(entry, {})).statusCode).not.toBe(401);
    expect((await send(entry, {})).statusCode).not.toBe(403);
  });
});

describe("customer routes", () => {
  it.each(ROUTE_TABLE.filter((e) => e.kind === "customer").map((e) => [key(e.method, e.path), e] as const))("%s", async (_name, entry) => {
    expect((await send(entry, {})).statusCode, "no token").toBe(401);
    expect((await send(entry, { authorization: "Bearer not.a.token" })).statusCode, "garbage token").toBe(401);
    expect((await send(entry, await staffHeaders("ADMINISTRATOR"))).statusCode, "a staff token").toBe(401);
    if (!entry.stream) {
      const status = (await send(entry, await bearerFor("cust_a1"))).statusCode;
      expect([401, 403], "a customer token passes the guard").not.toContain(status);
    }
  });
});

describe("staff routes", () => {
  it.each(ROUTE_TABLE.filter((e) => e.kind === "staff").map((e) => [key(e.method, e.path), e] as const))("%s", async (_name, entry) => {
    const roles = entry.roles!;
    expect((await send(entry, {})).statusCode, "no token").toBe(401);
    expect((await send(entry, { authorization: "Bearer not.a.token" })).statusCode, "garbage token").toBe(401);
    expect((await send(entry, await bearerFor("cust_a1"))).statusCode, "a customer token").toBe(401);
    if (entry.stream) return; // an accepted stream never ends; the guard is the same authenticate() call
    for (const role of ROLES) {
      const status = (await send(entry, await staffHeaders(role))).statusCode;
      if (roles.includes(role)) expect([401, 403], `${role} is allowed`).not.toContain(status);
      else expect(status, `${role} is NOT allowed`).toBe(403);
    }
  });
});

describe("staff routes take the role and the active flag from the database, not the token", () => {
  const staffEntries = ROUTE_TABLE.filter((e) => e.kind === "staff").map((e) => [key(e.method, e.path), e] as const);
  const claim = async (sub: string, role: Role) => ({
    authorization: `Bearer ${await signAccessToken({ sub, orgId: ORG_A, role, name: sub, email: null })}`,
  });

  it.each(staffEntries)("%s: a deactivated user and an unknown user are 401, even with an admin claim", async (_name, entry) => {
    expect((await send(entry, await claim("staff_off", "ADMINISTRATOR"))).statusCode, "deactivated").toBe(401);
    expect((await send(entry, await claim("staff_nobody", "ADMINISTRATOR"))).statusCode, "unknown").toBe(401);
  });

  it.each(staffEntries.filter(([, e]) => !e.stream))("%s: a role the database does not give is 403 whatever the token claims", async (_name, entry) => {
    for (const role of ROLES) {
      if (entry.roles!.includes(role)) continue;
      // The token claims the strongest role the route allows; the database says `role`.
      const status = (await send(entry, await claim(USER[role], entry.roles![0]!))).statusCode;
      expect(status, `${role} claiming ${entry.roles![0]}`).toBe(403);
    }
  });
});

describe('routes marked "scoped to assigned customers"', () => {
  const scoped = ROUTE_TABLE.filter((e) => e.scoped === "assigned customers");

  it("are exactly the chat routes an operator may use", () => {
    expect(scoped.map((e) => key(e.method, e.path)).sort()).toEqual(
      [
        "GET /api/v1/chat/conversations",
        "GET /api/v1/chat/conversations/:id/messages",
        "POST /api/v1/chat/conversations/:id/handled",
        "POST /api/v1/chat/conversations/:id/messages",
      ].sort()
    );
    for (const e of scoped) expect(e.roles).toContain("OPERATOR");
  });

  it("an operator with no assigned customers gets an empty inbox, and a 404 (not a 403) for any conversation id", async () => {
    for (const entry of scoped) {
      // a valid body, so the answer comes from the scope and not from validation
      const body = entry.path.endsWith("/messages") ? { body: "hello" } : entry.path.endsWith("/handled") ? { handled: true } : {};
      const res = await app.inject({ method: entry.method as "GET", url: fill(entry.path), headers: await staffHeaders("OPERATOR"), ...(entry.method === "POST" ? { payload: body } : {}) });
      if (entry.path.includes(":id")) {
        expect(res.statusCode, key(entry.method, entry.path)).toBe(404);
      } else {
        expect(res.statusCode).toBe(200);
        expect(res.json().data.rows).toEqual([]);
      }
    }
  });

  it("a viewer is 403 on every one of them", async () => {
    for (const entry of scoped) expect((await send(entry, await staffHeaders("VIEWER"))).statusCode, key(entry.method, entry.path)).toBe(403);
  });
});
