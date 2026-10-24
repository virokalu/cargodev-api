import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const ALL_ROLES: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];
const PASSWORD = "example-Route-Passw0rd";

let app: FastifyInstance;
let fake: FakePrisma;

const tokenFor = (role: Role, orgId = ORG_A, name = `Test ${role}`) =>
  signAccessToken({ sub: `user_${role.toLowerCase()}`, orgId, role, name, email: `${role.toLowerCase()}@example.test` });

const bearer = async (role: Role, orgId = ORG_A) => ({ authorization: `Bearer ${await tokenFor(role, orgId)}` });

function seed() {
  const staff = (id: string, org_id: string, name: string, role: Role) => ({
    id, org_id, name, role, userType: "STAFF", email: `${id}@example.test`, phone: null,
    loginEnabled: true, lastActiveAt: null, failedLoginAttempts: 0, lockoutUntil: null,
    password: bcrypt.hashSync(PASSWORD, 4),
  });
  fake.seed(
    "user",
    staff("user_administrator", ORG_A, "Test ADMINISTRATOR", "ADMINISTRATOR"),
    staff("user_manager", ORG_A, "Test MANAGER", "MANAGER"),
    staff("staff_b1", ORG_B, "Org B Staff", "MANAGER"),
    { id: "cust_a1", org_id: ORG_A, userType: "CUSTOMER", name: "Buyer A", email: null, phone: null, country: null, address: null },
    { id: "cust_b1", org_id: ORG_B, userType: "CUSTOMER", name: "Buyer B", email: null, phone: null, country: null, address: null }
  );
  fake.seed("brand", { id: "brand_a1", org_id: ORG_A, name: "Brand A" }, { id: "brand_b1", org_id: ORG_B, name: "Brand B" });
  fake.seed("vehicleModelRef", { id: "model_b1", org_id: ORG_B, brand_id: "brand_b1", name: "Model B" });
  fake.seed("grade", { id: "grade_b1", org_id: ORG_B, model_id: "model_b1", name: "Grade B" });
  fake.seed("freightAgent", { id: "fa_b1", org_id: ORG_B, name: "Agent B", offersRoro: true, offersContainer: true });
  fake.seed("organization", { id: ORG_A, name: "Org A Name" });
}

beforeEach(async () => {
  resetShadowLockouts();
  fake = createFakePrisma({ relations: { activityLog: { actor: { model: "user", fk: "actorId" } } } });
  state.fake = fake;
  seed();
  app = await buildApp({ rateLimit: false });
});

afterEach(async () => {
  await app.close();
});

interface RouteSpec {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  roles: Role[] | "ANY";
}

const ROUTES: RouteSpec[] = [
  { method: "GET", url: "/api/v1/customers", roles: "ANY" },
  { method: "GET", url: "/api/v1/customers/search?q=a", roles: "ANY" },
  { method: "GET", url: "/api/v1/customers/cust_a1", roles: "ANY" },
  { method: "POST", url: "/api/v1/customers", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/customers/cust_a1", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "GET", url: "/api/v1/staff", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/staff", roles: ["ADMINISTRATOR"] },
  { method: "PATCH", url: "/api/v1/staff/user_manager", roles: ["ADMINISTRATOR"] },
  { method: "POST", url: "/api/v1/staff/user_manager/active", roles: ["ADMINISTRATOR"] },
  { method: "GET", url: "/api/v1/profile", roles: "ANY" },
  { method: "PATCH", url: "/api/v1/profile", roles: "ANY" },
  { method: "POST", url: "/api/v1/profile/password", roles: "ANY" },
  { method: "GET", url: "/api/v1/organization", roles: "ANY" },
  { method: "GET", url: "/api/v1/dashboard/stats", roles: "ANY" },
  { method: "GET", url: "/api/v1/dashboard/trends", roles: "ANY" },
  { method: "GET", url: "/api/v1/reports/by-customer", roles: "ANY" },
  { method: "GET", url: "/api/v1/reports/by-auction-hall", roles: "ANY" },
  { method: "GET", url: "/api/v1/reports/by-destination", roles: "ANY" },
  { method: "GET", url: "/api/v1/reports/by-freight-agent", roles: "ANY" },
  { method: "GET", url: "/api/v1/activity-log", roles: ["ADMINISTRATOR"] },
  { method: "GET", url: "/api/v1/activity-log/filters", roles: ["ADMINISTRATOR"] },
  { method: "GET", url: "/api/v1/lookups/brands", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/brands/brand_a1", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/auction-halls", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/suppliers", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/transport-companies", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/inspection-companies", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/inspection-by", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/packing-agents", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/vehicle-locations", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/models?brandId=brand_a1", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/grades?modelId=model_a1", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/freight-agents", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/freight-agents/search", roles: "ANY" },
  { method: "GET", url: "/api/v1/lookups/row-colour-statuses", roles: "ANY" },
  { method: "GET", url: "/api/v1/notifications", roles: "ANY" },
  { method: "GET", url: "/api/v1/notifications/unread-count", roles: "ANY" },
  { method: "POST", url: "/api/v1/notifications/read-all", roles: "ANY" },
  { method: "POST", url: "/api/v1/notifications/some_id/read", roles: "ANY" },
  { method: "POST", url: "/api/v1/device-tokens", roles: "ANY" },
  { method: "DELETE", url: "/api/v1/device-tokens", roles: "ANY" },
  { method: "POST", url: "/api/v1/lookups/brands", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/brands/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/lookups/auction-halls", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/auction-halls/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/lookups/suppliers", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/suppliers/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/lookups/transport-companies", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/transport-companies/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/lookups/inspection-companies", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/inspection-companies/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/lookups/inspection-by", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/inspection-by/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/lookups/packing-agents", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/packing-agents/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/lookups/vehicle-locations", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/vehicle-locations/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/lookups/models", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/models/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/lookups/grades", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/grades/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "POST", url: "/api/v1/lookups/freight-agents", roles: ["ADMINISTRATOR", "MANAGER"] },
  { method: "PATCH", url: "/api/v1/lookups/freight-agents/some_id", roles: ["ADMINISTRATOR", "MANAGER"] },
];

const label = (r: RouteSpec) => `${r.method} ${r.url}`;

describe.each(ROUTES.map((r) => [label(r), r] as const))("%s", (_label, route) => {
  const send = (headers: Record<string, string> = {}) =>
    app.inject({ method: route.method, url: route.url, headers, ...(route.method !== "GET" ? { payload: {} } : {}) });

  it("returns 401 without a token, in the error envelope", async () => {
    const res = await send();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns 401 for a malformed or forged token", async () => {
    const res = await send({ authorization: "Bearer not.a.token" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  const disallowed = route.roles === "ANY" ? [] : ALL_ROLES.filter((r) => !route.roles.includes(r));
  const allowed = route.roles === "ANY" ? ALL_ROLES : route.roles;

  for (const role of disallowed) {
    it(`returns 403 for ${role}`, async () => {
      const res = await send(await bearer(role));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
      expect(res.headers["cache-control"]).toBe("no-store");
    });
  }

  it(`lets ${allowed.join(", ")} through the auth hook`, async () => {
    for (const role of allowed) {
      const res = await send(await bearer(role));
      expect([401, 403], `${role} was rejected by auth`).not.toContain(res.statusCode);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = res.json();
      expect("data" in body || "error" in body).toBe(true);
    }
  });
});

describe("cross-org access returns 404, never 403 or data", () => {
  const cases: Array<[string, "GET" | "PATCH" | "POST", string, object?]> = [
    ["customer by id", "GET", "/api/v1/customers/cust_b1"],
    ["customer update", "PATCH", "/api/v1/customers/cust_b1", { name: "Hijack" }],
    ["staff update", "PATCH", "/api/v1/staff/staff_b1", { name: "Hijack", email: "h@example.test", role: "MANAGER", active: true }],
    ["staff deactivate", "POST", "/api/v1/staff/staff_b1/active", { active: false }],
    ["brand by id", "GET", "/api/v1/lookups/brands/brand_b1"],
    ["model by id", "GET", "/api/v1/lookups/models/model_b1"],
    ["grade by id", "GET", "/api/v1/lookups/grades/grade_b1"],
    ["freight agent by id", "GET", "/api/v1/lookups/freight-agents/fa_b1"],
    ["brand rename", "PATCH", "/api/v1/lookups/brands/brand_b1", { name: "Hijack" }],
    ["model rename", "PATCH", "/api/v1/lookups/models/model_b1", { name: "Hijack" }],
    ["grade rename", "PATCH", "/api/v1/lookups/grades/grade_b1", { name: "Hijack" }],
    ["freight agent update", "PATCH", "/api/v1/lookups/freight-agents/fa_b1", { name: "Hijack", offersRoro: true, offersContainer: true }],
    ["model create under their brand", "POST", "/api/v1/lookups/models", { brandId: "brand_b1", name: "Sneaky" }],
    ["grade create under their model", "POST", "/api/v1/lookups/grades", { modelId: "model_b1", name: "Sneaky" }],
  ];

  it.each(cases)("%s", async (_name, method, url, payload) => {
    const res = await app.inject({
      method,
      url,
      headers: await bearer("ADMINISTRATOR"),
      ...(payload ? { payload } : {}),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(res.json())).not.toContain("Org B");
  });

  it("never mutates the other org's row", async () => {
    await app.inject({ method: "PATCH", url: "/api/v1/customers/cust_b1", headers: await bearer("ADMINISTRATOR"), payload: { name: "Hijack" } });
    await app.inject({ method: "POST", url: "/api/v1/staff/staff_b1/active", headers: await bearer("ADMINISTRATOR"), payload: { active: false } });
    expect(fake.rows("user").find((r) => r["id"] === "cust_b1")?.["name"]).toBe("Buyer B");
    expect(fake.rows("user").find((r) => r["id"] === "staff_b1")?.["loginEnabled"]).toBe(true);
  });

  it("an org B token cannot read org A data either", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/customers/cust_a1", headers: await bearer("ADMINISTRATOR", ORG_B) });
    expect(res.statusCode).toBe(404);
  });

  it("takes the org from the token, ignoring any orgId in the request", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/customers?orgId=${ORG_B}&org_id=${ORG_B}`,
      headers: { ...(await bearer("ADMINISTRATOR")), "x-org-id": ORG_B },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((c: { id: string }) => c.id)).toEqual(["cust_a1"]);
  });
});

describe("validation returns 400 with fieldErrors", () => {
  const admin = () => bearer("ADMINISTRATOR");

  it("POST /customers with a blank name", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/customers", headers: await admin(), payload: { name: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "VALIDATION", fieldErrors: { name: "Name is required" } });
  });

  it("POST /staff with a short password and bad email", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/staff", headers: await admin(),
      payload: { name: "X", email: "nope", role: "OPERATOR", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().error.fieldErrors)).toEqual(expect.arrayContaining(["email", "password"]));
  });

  it("POST /staff/:id/active without a boolean", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/staff/user_manager/active", headers: await admin(), payload: { active: "yes" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("GET /lookups/models without brandId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/lookups/models", headers: await admin() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors).toHaveProperty("brandId");
  });

  it("GET /reports/by-customer with an unknown track", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/reports/by-customer?track=XX", headers: await admin() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors).toHaveProperty("track");
  });

  it("GET /activity-log with a bad date", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/activity-log?dateFrom=not-a-date", headers: await admin() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors).toHaveProperty("dateFrom");
  });

  it("malformed JSON is a 400 VALIDATION envelope", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/customers",
      headers: { ...(await admin()), "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("login with an invalid body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "nope", password: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });
});

describe("lookup writes", () => {
  const manager = () => bearer("MANAGER");

  it("POST creates a row in the token's org and writes one ActivityLog row", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/lookups/brands", headers: await manager(), payload: { name: " New Brand " } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe("New Brand");
    expect(fake.rows("brand").find((r) => r["name"] === "New Brand")?.["org_id"]).toBe(ORG_A);
    expect(fake.rows("activityLog")).toHaveLength(1);
    expect(fake.rows("activityLog")[0]).toMatchObject({ org_id: ORG_A, action: "CREATE_BRAND" });
  });

  it("POST with an existing name returns that row without a duplicate or a log", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/lookups/brands", headers: await manager(), payload: { name: "brand a" } });
    expect(res.json().data.id).toBe("brand_a1");
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  it("PATCH renames and logs before/after", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/v1/lookups/brands/brand_a1", headers: await manager(), payload: { name: "Renamed" } });
    expect(res.json().data).toEqual({ id: "brand_a1", name: "Renamed" });
    expect(fake.rows("activityLog")[0]).toMatchObject({ action: "RENAME_BRAND", before: { name: "Brand A" }, after: { name: "Renamed" } });
  });

  it("a duplicate rename is 409 CONFLICT", async () => {
    fake.seed("brand", { id: "brand_a2", org_id: ORG_A, name: "Taken" });
    const res = await app.inject({ method: "PATCH", url: "/api/v1/lookups/brands/brand_a1", headers: await manager(), payload: { name: "taken" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it.each([
    ["missing name", "/api/v1/lookups/brands", {}],
    ["non-string name", "/api/v1/lookups/brands", { name: 5 }],
    ["blank name", "/api/v1/lookups/brands", { name: "   " }],
    ["model without brandId", "/api/v1/lookups/models", { name: "X" }],
    ["grade without modelId", "/api/v1/lookups/grades", { name: "X" }],
    ["freight agent without capability flags", "/api/v1/lookups/freight-agents", { name: "X" }],
    ["freight agent with neither capability", "/api/v1/lookups/freight-agents", { name: "X", offersRoro: false, offersContainer: false }],
  ])("POST %s is 400 VALIDATION", async (_n, url, payload) => {
    const res = await app.inject({ method: "POST", url, headers: await manager(), payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  it("an org id in the body is ignored", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/lookups/brands", headers: await manager(),
      payload: { name: "Mine", org_id: ORG_B, orgId: ORG_B },
    });
    expect(res.statusCode).toBe(200);
    expect(fake.rows("brand").find((r) => r["name"] === "Mine")?.["org_id"]).toBe(ORG_A);
  });

  it("OPERATOR and VIEWER cannot write", async () => {
    for (const role of ["OPERATOR", "VIEWER"] as Role[]) {
      const res = await app.inject({ method: "POST", url: "/api/v1/lookups/brands", headers: await bearer(role), payload: { name: "X" } });
      expect(res.statusCode).toBe(403);
    }
    expect(fake.rows("brand")).toHaveLength(2);
  });
});

describe("notifications and device tokens over HTTP", () => {
  const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
  const note = (id: string, org_id: string, userId: string, isRead = false) => ({
    id, org_id, userId, isRead, event: "SHIPPED", title: "t", body: "b", vehicleId: null, createdAt: new Date(),
  });

  beforeEach(() => {
    fake.seed(
      "notification",
      note("n_mine", ORG_A, "user_manager"),
      note("n_theirs", ORG_A, "user_administrator"),
      note("n_other_org", ORG_B, "user_manager")
    );
  });

  it("lists only the callers own notifications", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: await bearer("MANAGER") });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rows.map((r: { id: string }) => r.id)).toEqual(["n_mine"]);
    expect(res.json().data).toMatchObject({ total: 1, page: 1 });
  });

  it("reports the unread count for the caller only", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/notifications/unread-count", headers: await bearer("MANAGER") });
    expect(res.json()).toEqual({ data: { count: 1 } });
  });

  it("marking someone elses or another orgs notification read changes nothing", async () => {
    for (const id of ["n_theirs", "n_other_org"]) {
      const res = await app.inject({ method: "POST", url: `/api/v1/notifications/${id}/read`, headers: await bearer("MANAGER") });
      expect(res.json()).toEqual({ data: { read: true } });
    }
    expect(fake.rows("notification").every((r) => r["isRead"] === false)).toBe(true);
    await app.inject({ method: "POST", url: "/api/v1/notifications/n_mine/read", headers: await bearer("MANAGER") });
    expect(fake.rows("notification").find((r) => r["id"] === "n_mine")?.["isRead"]).toBe(true);
  });

  it("rejects bad pagination with a 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/notifications?page=0&pageSize=500", headers: await bearer("MANAGER") });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().error.fieldErrors)).toEqual(expect.arrayContaining(["page", "pageSize"]));
  });

  it("registers and unregisters a device token for the token's own user", async () => {
    const reg = await app.inject({
      method: "POST", url: "/api/v1/device-tokens", headers: await bearer("MANAGER"),
      payload: { expoPushToken: TOKEN, platform: "ios" },
    });
    expect(reg.statusCode).toBe(200);
    expect(fake.rows("deviceToken")[0]).toMatchObject({ org_id: ORG_A, userId: "user_manager" });

    const other = await app.inject({
      method: "DELETE", url: "/api/v1/device-tokens", headers: await bearer("ADMINISTRATOR"),
      payload: { expoPushToken: TOKEN },
    });
    expect(other.statusCode).toBe(200);
    expect(fake.rows("deviceToken")).toHaveLength(1); // not the admin's token

    const mine = await app.inject({
      method: "DELETE", url: "/api/v1/device-tokens", headers: await bearer("MANAGER"),
      payload: { expoPushToken: TOKEN },
    });
    expect(mine.json()).toEqual({ data: { unregistered: true } });
    expect(fake.rows("deviceToken")).toHaveLength(0);
  });

  it("rejects an invalid device token with 400 and fieldErrors", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/device-tokens", headers: await bearer("MANAGER"),
      payload: { expoPushToken: "nope", platform: "ios" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors).toHaveProperty("expoPushToken");
  });
});

describe("response contract", () => {
  it("success is { data } with no-store and ISO dates", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/customers", headers: await bearer("VIEWER") });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(["data"]);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().data[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("create returns 201", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/customers", headers: await bearer("MANAGER"), payload: { name: "New Buyer" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ name: "New Buyer" });
    expect(fake.rows("activityLog")).toHaveLength(1);
  });

  it("unknown routes use the error envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found." } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("does not leak the message of an unexpected error", async () => {
    const original = fake.client as unknown as { user: { findMany: unknown } };
    original.user.findMany = async () => {
      throw new Error("connection to db-host-internal failed: password=hunter2");
    };
    const res = await app.inject({ method: "GET", url: "/api/v1/customers", headers: await bearer("VIEWER") });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "INTERNAL", message: "Something went wrong." } });
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("db-host-internal");
  });

  it("GET /health is public", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { status: "ok" } });
  });
});

describe("auth flow over HTTP", () => {
  it("login, use the access token, refresh, then logout", async () => {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "user_manager@example.test", password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const { accessToken, refreshToken, user } = login.json().data;
    expect(user).toMatchObject({ id: "user_manager", orgId: ORG_A, role: "MANAGER" });

    const me = await app.inject({ method: "GET", url: "/api/v1/profile", headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.id).toBe("user_manager");

    const refreshed = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken } });
    expect(refreshed.statusCode).toBe(200);
    const next = refreshed.json().data.refreshToken;

    const reuse = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken } });
    expect(reuse.statusCode).toBe(403);

    const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", payload: { refreshToken: next } });
    expect(logout.json()).toEqual({ data: { loggedOut: true } });
    const after = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken: next } });
    expect(after.statusCode).toBe(403);
  });

  it("wrong password is a generic 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "user_manager@example.test", password: "example-wrong" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Invalid email or password.");
  });

  it("an account locked after repeated failures answers 403", async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "user_manager@example.test", password: "example-wrong" } });
    }
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "user_manager@example.test", password: PASSWORD } });
    expect(res.statusCode).toBe(403);
  });
});

describe("per-IP rate limiting", () => {
  it("limits login attempts with a 429 envelope", async () => {
    const limited = await buildApp({ rateLimit: true });
    try {
      let last = 0;
      for (let i = 0; i < 11; i++) {
        const res = await limited.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "nobody@example.test", password: "x" } });
        last = res.statusCode;
        if (i === 10) expect(res.json().error.code).toBe("RATE_LIMITED");
      }
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe("CORS", () => {
  it("echoes an allow-listed origin and never sends *", async () => {
    const a = await buildApp({ rateLimit: false, corsOrigins: ["https://app.example.test"] });
    try {
      const res = await a.inject({ method: "GET", url: "/health", headers: { origin: "https://app.example.test" } });
      expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.test");
    } finally {
      await a.close();
    }
  });

  it("sends no CORS headers for an unlisted origin", async () => {
    const a = await buildApp({ rateLimit: false, corsOrigins: ["https://app.example.test"] });
    try {
      const res = await a.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example.test" } });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      const preflight = await a.inject({
        method: "OPTIONS", url: "/api/v1/customers",
        headers: { origin: "https://evil.example.test", "access-control-request-method": "GET" },
      });
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await a.close();
    }
  });

  it("allows nothing by default", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://anything.example.test" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("logging", () => {
  it("never writes the bearer token to the logs", async () => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
    const logged = await buildApp({ logger: true, logStream: stream, rateLimit: false });
    try {
      const token = await tokenFor("ADMINISTRATOR");
      await logged.inject({ method: "GET", url: "/api/v1/customers", headers: { authorization: `Bearer ${token}` } });
      (fake.client as unknown as { user: { findMany: unknown } }).user.findMany = async () => {
        throw new Error("boom");
      };
      await logged.inject({ method: "GET", url: "/api/v1/customers", headers: { authorization: `Bearer ${token}` } });
      expect(chunks.join("")).not.toContain(token);
    } finally {
      await logged.close();
    }
  });
});
