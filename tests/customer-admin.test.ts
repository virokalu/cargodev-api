// Staff tools for customers (slice 4): access matrix on every route, then behaviour. Fake data only.

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { bearerFor, newCustomerFake } from "./helpers/customer-fixtures.js";
import { dayOffset, newVehicleFake, vehicleRow } from "./helpers/vehicle-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));

import { buildApp } from "../src/app.js";
import { ARRIVAL_ROLES, CUSTOMER_ADMIN_ROLES, LINK_REQUEST_DECIDERS } from "../src/config/roles.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";
import { runDailyVehicleChecks } from "../src/services/reminder.service.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const ALL_ROLES: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];

let app: FastifyInstance;
let fake: FakePrisma;
const rows = (model: string) => fake.rows(model);
const row = (model: string, id: string) => rows(model).find((r) => r["id"] === id)!;
const logs = (action?: string) => rows("activityLog").filter((l) => !action || l["action"] === action);

const staff = async (role: Role, orgId = ORG_A) => ({
  authorization: `Bearer ${await signAccessToken({ sub: "staff_a1", orgId, role, name: `Test ${role}`, email: null })}`,
});
const call = async (method: string, url: string, role: Role | null, body?: unknown, orgId = ORG_A) =>
  app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: role ? await staff(role, orgId) : {}, ...(body === undefined ? {} : { payload: body as object }) });

beforeEach(async () => {
  fake = newVehicleFake();
  for (const r of newCustomerFake().rows("user")) {
    const existing = fake.rows("user").find((u) => u["id"] === r["id"]);
    if (existing) Object.assign(existing, r);
    else fake.seed("user", r);
  }
  state.fake = fake;
  identifierLimiter.reset();
  resetShadowLockouts();
  fake.seed("user", { id: "agent_1", org_id: ORG_A, userType: "STAFF", role: "OPERATOR", loginEnabled: true, name: "Agent One" }, { id: "agent_off", org_id: ORG_A, userType: "STAFF", role: "OPERATOR", loginEnabled: false, name: "Agent Off" }, { id: "agent_b", org_id: ORG_B, userType: "STAFF", role: "OPERATOR", loginEnabled: true, name: "Agent B" });

  const v = (id: string, serial: string, over: Record<string, unknown> = {}) => fake.seed("vehicle", vehicleRow({ id, org_id: ORG_A, serial, modelId: "model_a1", ...over }));
  v("sv_own", "FC601", { customerId: "cust_a1", customerVisible: false });
  v("sv_free", "FC602");
  v("sv_taken", "FC603", { customerId: "cust_a2" });
  v("sv_fl", "FL604", { serialPrefix: "FL", customerId: "cust_a1" });
  fake.seed("vehicle", vehicleRow({ id: "sv_b", org_id: ORG_B, serial: "FC601", customerId: "cust_b1", modelId: "model_b1" }));

  fake.seed(
    "vehiclePhoto",
    { id: "sp1", vehicleId: "sv_own", url: "https://files.example.test/org/x/a.jpg", visibleToCustomer: false, uploadedById: "staff_a1" },
    { id: "sp2", vehicleId: "sv_own", url: "https://files.example.test/org/x/b.jpg", visibleToCustomer: false, uploadedById: "staff_a1" },
    { id: "sp_other", vehicleId: "sv_free", url: "https://files.example.test/org/x/c.jpg", visibleToCustomer: false, uploadedById: "staff_a1" }
  );
  fake.seed(
    "vehicleDocument",
    { id: "sd1", vehicleId: "sv_own", url: "https://files.example.test/org/x/d.pdf", name: "d.pdf", documentType: "OTHER", visibleToCustomer: false, uploadedById: "staff_a1" },
    { id: "sd_other", vehicleId: "sv_free", url: "https://files.example.test/org/x/e.pdf", name: "e.pdf", documentType: "OTHER", visibleToCustomer: false, uploadedById: "staff_a1" }
  );
  fake.seed(
    "vehicleLinkRequest",
    { id: "lr1", org_id: ORG_A, customerId: "cust_a1", serialEntered: "FC602", status: "PENDING", createdAt: new Date(2026, 5, 2), vehicleId: null, decidedById: null, decidedAt: null },
    { id: "lr2", org_id: ORG_A, customerId: "cust_a2", serialEntered: "FC999", status: "PENDING", createdAt: new Date(2026, 5, 1), vehicleId: null, decidedById: null, decidedAt: null },
    { id: "lr_done", org_id: ORG_A, customerId: "cust_a1", serialEntered: "FC603", status: "REJECTED", createdAt: new Date(2026, 4, 1), vehicleId: null, decidedById: "staff_a1", decidedAt: new Date() },
    { id: "lr_b", org_id: ORG_B, customerId: "cust_b1", serialEntered: "FC601", status: "PENDING", createdAt: new Date(2026, 5, 1), vehicleId: null, decidedById: null, decidedAt: null }
  );
  fake.seed("faq", { id: "faq1", org_id: ORG_A, question: "Q1?", answer: "A1", sortOrder: 1, published: true, createdAt: new Date(2026, 0, 1) }, { id: "faq_b", org_id: ORG_B, question: "QB?", answer: "AB", sortOrder: 1, published: true, createdAt: new Date(2026, 0, 1) });

  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe("the role lists live in one place", () => {
  it("are exactly the intended roles", () => {
    expect([...CUSTOMER_ADMIN_ROLES]).toEqual(["ADMINISTRATOR", "MANAGER"]);
    expect([...LINK_REQUEST_DECIDERS]).toEqual(["ADMINISTRATOR", "MANAGER"]);
    expect([...ARRIVAL_ROLES]).toEqual(["ADMINISTRATOR", "MANAGER", "OPERATOR"]);
  });
});

type Case = { name: string; method: string; url: string; body?: unknown; roles: readonly Role[]; foreign?: string };
const ADMIN = ["ADMINISTRATOR", "MANAGER"] as const;
const CASES: Case[] = [
  { name: "login access", method: "PATCH", url: "/customers/cust_a1/login-access", body: { loginEnabled: false }, roles: ADMIN },
  { name: "agent", method: "PATCH", url: "/customers/cust_a1/agent", body: { agentId: "agent_1" }, roles: ADMIN },
  { name: "active customers", method: "GET", url: "/staff/customers/active", roles: ADMIN },
  { name: "link requests list", method: "GET", url: "/link-requests", roles: ADMIN },
  { name: "approve", method: "POST", url: "/link-requests/lr1/approve", body: {}, roles: ADMIN },
  { name: "reject", method: "POST", url: "/link-requests/lr2/reject", body: {}, roles: ADMIN },
  { name: "faq list", method: "GET", url: "/faqs", roles: ADMIN },
  { name: "faq create", method: "POST", url: "/faqs", body: { question: "New?", answer: "Yes." }, roles: ADMIN },
  { name: "faq update", method: "PATCH", url: "/faqs/faq1", body: { published: false }, roles: ADMIN },
  { name: "faq delete", method: "DELETE", url: "/faqs/faq1", roles: ADMIN },
  { name: "vehicle visibility", method: "PATCH", url: "/vehicles/sv_own/customer-visibility", body: { customerVisible: true }, roles: ADMIN },
  { name: "vehicle customer info", method: "PATCH", url: "/vehicles/sv_own/customer-info", body: { voyageNo: "V1" }, roles: ADMIN },
  { name: "document release", method: "PATCH", url: "/vehicles/sv_own/documents/sd1", body: { visibleToCustomer: true }, roles: ADMIN },
  { name: "photo release", method: "PATCH", url: "/vehicles/sv_own/photos/sp1", body: { visibleToCustomer: true }, roles: ADMIN },
  { name: "photos release (bulk)", method: "PATCH", url: "/vehicles/sv_own/photos", body: { visibleToCustomer: true, photoIds: ["sp1"] }, roles: ADMIN },
  { name: "release readiness", method: "GET", url: "/vehicles/sv_own/release-readiness", roles: ["ADMINISTRATOR", "MANAGER", "OPERATOR"] },
  { name: "mark arrived", method: "POST", url: "/vehicles/sv_own/mark-arrived", body: {}, roles: ARRIVAL_ROLES },
  { name: "mark delivered", method: "POST", url: "/vehicles/sv_own/mark-delivered", body: {}, roles: ARRIVAL_ROLES },
];

describe.each(CASES)("access: $name ($method $url)", ({ method, url, body, roles }) => {
  it("is 401 without a token, and with a customer token", async () => {
    expect((await call(method, url, null, body)).statusCode).toBe(401);
    const asCustomer = await app.inject({ method: method as "GET", url: `/api/v1${url}`, headers: await bearerFor("cust_a1"), ...(body === undefined ? {} : { payload: body as object }) });
    expect(asCustomer.statusCode).toBe(401);
  });

  it.each(ALL_ROLES.filter((r) => !roles.includes(r)))("is 403 for %s, and changes nothing", async (role) => {
    const before = JSON.stringify([rows("user"), rows("vehicle"), rows("vehicleLinkRequest"), rows("faq"), rows("vehiclePhoto"), rows("vehicleDocument"), rows("vehicleMilestone"), rows("activityLog")]);
    const res = await call(method, url, role, body);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(JSON.stringify([rows("user"), rows("vehicle"), rows("vehicleLinkRequest"), rows("faq"), rows("vehiclePhoto"), rows("vehicleDocument"), rows("vehicleMilestone"), rows("activityLog")])).toBe(before);
  });

  it.each(roles)("lets %s past the guard", async (role) => {
    const res = await call(method, url, role, body);
    expect([401, 403]).not.toContain(res.statusCode);
  });
});

describe("another org's id is 404, never 403, and nothing changes", () => {
  const FOREIGN: [string, string, string, unknown?][] = [
    ["PATCH", "/customers/cust_b1/login-access", "customer", { loginEnabled: false }],
    ["PATCH", "/customers/cust_b1/agent", "customer", { agentId: null }],
    ["POST", "/link-requests/lr_b/approve", "link request", {}],
    ["POST", "/link-requests/lr_b/reject", "link request", {}],
    ["PATCH", "/faqs/faq_b", "faq", { published: false }],
    ["DELETE", "/faqs/faq_b", "faq"],
    ["PATCH", "/vehicles/sv_b/customer-visibility", "vehicle", { customerVisible: false }],
    ["PATCH", "/vehicles/sv_b/customer-info", "vehicle", { voyageNo: "X" }],
    ["PATCH", "/vehicles/sv_b/documents/sd1", "vehicle", { visibleToCustomer: true }],
    ["PATCH", "/vehicles/sv_b/photos/sp1", "vehicle", { visibleToCustomer: true }],
    ["PATCH", "/vehicles/sv_b/photos", "vehicle", { visibleToCustomer: true, photoIds: ["sp1"] }],
    ["GET", "/vehicles/sv_b/release-readiness", "vehicle"],
    ["POST", "/vehicles/sv_b/mark-arrived", "vehicle", {}],
    ["POST", "/vehicles/sv_b/mark-delivered", "vehicle", {}],
  ];

  it.each(FOREIGN)("%s %s", async (method, url, _what, body) => {
    const before = JSON.stringify([rows("user"), rows("vehicle"), rows("vehicleLinkRequest"), rows("faq"), rows("vehiclePhoto"), rows("vehicleDocument"), rows("vehicleMilestone")]);
    const res = await call(method, url, "ADMINISTRATOR", body);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(JSON.stringify([rows("user"), rows("vehicle"), rows("vehicleLinkRequest"), rows("faq"), rows("vehiclePhoto"), rows("vehicleDocument"), rows("vehicleMilestone")])).toBe(before);
    expect(logs()).toHaveLength(0);
  });

  it("an org B administrator cannot touch org A's records either", async () => {
    for (const [method, url, body] of [["PATCH", "/customers/cust_a1/login-access", { loginEnabled: false }], ["POST", "/link-requests/lr1/approve", {}], ["PATCH", "/faqs/faq1", { published: false }], ["PATCH", "/vehicles/sv_own/customer-visibility", { customerVisible: true }]] as const) {
      expect((await call(method, url, "ADMINISTRATOR", body, ORG_B)).statusCode, url).toBe(404);
    }
    expect(row("user", "cust_a1")["loginEnabled"]).toBe(true);
  });

  it("an id that is not a customer (staff, deleted, unknown) is the same 404", async () => {
    for (const id of ["staff_a1", "cust_deleted", "nope"]) {
      expect((await call("PATCH", `/customers/${id}/login-access`, "ADMINISTRATOR", { loginEnabled: false })).statusCode, id).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("customer sign-in access", () => {
  const login = async (email = "a1@example.test") =>
    app.inject({ method: "POST", url: "/api/customer/v1/auth/login", payload: { email, password: "example-Password-12345" } });

  it("disabling ends every session at once, removes device tokens, stops the existing access token, and is logged", async () => {
    fake.seed("deviceToken", { id: "dt1", org_id: ORG_A, userId: "cust_a1", expoPushToken: "ExponentPushToken[a]" }, { id: "dt2", org_id: ORG_A, userId: "cust_a2", expoPushToken: "ExponentPushToken[b]" });
    const session = (await login()).json().data;
    const other = (await login("a2@example.test")).json().data;
    const headers = { authorization: `Bearer ${session.accessToken}` };
    expect((await app.inject({ method: "GET", url: "/api/customer/v1/me", headers })).statusCode).toBe(200);

    const res = await call("PATCH", "/customers/cust_a1/login-access", "MANAGER", { loginEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { id: "cust_a1", loginEnabled: false } });

    expect(rows("customerSession").filter((s) => s["userId"] === "cust_a1").every((s) => s["revokedAt"] != null)).toBe(true);
    expect(rows("customerSession").filter((s) => s["userId"] === "cust_a2").every((s) => s["revokedAt"] == null)).toBe(true);
    expect(rows("deviceToken").map((d) => d["userId"])).toEqual(["cust_a2"]);
    expect(logs("DISABLE_CUSTOMER_LOGIN")).toMatchObject([{ actorId: "staff_a1", entityId: "cust_a1", org_id: ORG_A, before: { loginEnabled: true }, after: { loginEnabled: false } }]);

    expect((await app.inject({ method: "GET", url: "/api/customer/v1/me", headers })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/customer/v1/auth/refresh", payload: { refreshToken: session.refreshToken } })).statusCode).toBe(403);
    expect((await login()).statusCode).toBe(400);
    // the other customer is untouched
    expect((await app.inject({ method: "GET", url: "/api/customer/v1/me", headers: { authorization: `Bearer ${other.accessToken}` } })).statusCode).toBe(200);
  });

  it("enabling lets a customer staff created sign in through the reset flow, and is logged; needs an email address", async () => {
    Object.assign(row("user", "cust_invited"), { loginEnabled: false });
    expect((await call("PATCH", "/customers/cust_invited/login-access", "ADMINISTRATOR", { loginEnabled: true })).statusCode).toBe(200);
    expect(row("user", "cust_invited")["loginEnabled"]).toBe(true);
    expect(logs("ENABLE_CUSTOMER_LOGIN")).toHaveLength(1);

    Object.assign(row("user", "cust_disabled"), { email: null, loginEnabled: false });
    const res = await call("PATCH", "/customers/cust_disabled/login-access", "ADMINISTRATOR", { loginEnabled: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.loginEnabled).toMatch(/no email/);
    expect(row("user", "cust_disabled")["loginEnabled"]).toBe(false);
  });

  it.each([{}, { loginEnabled: "yes" }, { loginEnabled: true, extra: 1 }, { loginEnabled: null }])("rejects the body %j", async (body) => {
    expect((await call("PATCH", "/customers/cust_a1/login-access", "ADMINISTRATOR", body)).statusCode).toBe(400);
    expect(row("user", "cust_a1")["loginEnabled"]).toBe(true);
  });
});

describe("assigned agent", () => {
  it("assigns an active staff member of the org, clears with null, and logs before and after", async () => {
    expect((await call("PATCH", "/customers/cust_a1/agent", "MANAGER", { agentId: "agent_1" })).json()).toEqual({ data: { id: "cust_a1", assignedAgentId: "agent_1" } });
    expect(row("user", "cust_a1")["assignedAgentId"]).toBe("agent_1");
    expect((await call("PATCH", "/customers/cust_a1/agent", "MANAGER", { agentId: null })).statusCode).toBe(200);
    expect(row("user", "cust_a1")["assignedAgentId"]).toBeNull();
    expect(logs("ASSIGN_CUSTOMER_AGENT")).toMatchObject([{ before: { assignedAgentId: null }, after: { assignedAgentId: "agent_1" } }, { before: { assignedAgentId: "agent_1" }, after: { assignedAgentId: null } }]);
  });

  it.each([["a staff member who cannot sign in", "agent_off"], ["a staff member of another org", "agent_b"], ["a customer", "cust_a2"], ["an unknown id", "nope"]])("refuses %s", async (_n, agentId) => {
    const res = await call("PATCH", "/customers/cust_a1/agent", "ADMINISTRATOR", { agentId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.agentId).toBeTruthy();
    expect(row("user", "cust_a1")["assignedAgentId"] ?? null).toBeNull();
  });

  it.each([{}, { agentId: 5 }, { agentId: "agent_1", orgId: ORG_B }, { agentId: "../x" }])("rejects the body %j", async (body) => {
    expect((await call("PATCH", "/customers/cust_a1/agent", "ADMINISTRATOR", body)).statusCode).toBe(400);
  });
});

describe("who is online", () => {
  it("lists customers seen in the last 5 minutes, newest first, with only the whitelisted fields", async () => {
    Object.assign(row("user", "cust_a1"), { lastActiveAt: new Date(Date.now() - 60_000), companyName: "Example Trading" });
    Object.assign(row("user", "cust_a2"), { lastActiveAt: new Date(Date.now() - 10_000) });
    Object.assign(row("user", "cust_disabled"), { lastActiveAt: new Date(Date.now() - 6 * 60_000) });
    Object.assign(row("user", "cust_deleted"), { lastActiveAt: new Date() });
    Object.assign(row("user", "cust_b1"), { lastActiveAt: new Date() });
    Object.assign(row("user", "staff_a1"), { lastActiveAt: new Date() });
    const res = await call("GET", "/staff/customers/active", "MANAGER");
    expect(res.json().data.map((c: { id: string }) => c.id)).toEqual(["cust_a2", "cust_a1"]);
    for (const c of res.json().data) expect(Object.keys(c).sort()).toEqual(["companyName", "id", "lastActiveAt", "name"]);
    expect(res.body).not.toMatch(/email|password|loginEnabled/);
  });

  it("is empty when nobody is online", async () => {
    expect((await call("GET", "/staff/customers/active", "MANAGER")).json().data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("link requests", () => {
  it("lists pending requests newest first with the customer, and whether the typed serial matches a vehicle", async () => {
    const res = await call("GET", "/link-requests", "MANAGER");
    const { rows: list, total } = res.json().data;
    expect(total).toBe(2);
    expect(list.map((r: { id: string }) => r.id)).toEqual(["lr1", "lr2"]);
    expect(Object.keys(list[0]).sort()).toEqual(["createdAt", "customer", "decidedAt", "id", "matchedVehicle", "serialEntered", "status", "vehicle"]);
    expect(list[0].customer).toEqual({ id: "cust_a1", name: "Customer cust_a1", email: "a1@example.test", companyName: "Example Trading" });
    expect(list[0].matchedVehicle).toEqual({ id: "sv_free", serial: "FC602", ownedByThisCustomer: false, ownedByAnotherCustomer: false });
    expect(list[1].matchedVehicle).toBeNull();
    expect(res.body).not.toContain("lr_b");
  });

  it("filters by status, pages, and is strict about parameters", async () => {
    expect((await call("GET", "/link-requests?status=REJECTED", "MANAGER")).json().data.rows.map((r: { id: string }) => r.id)).toEqual(["lr_done"]);
    expect((await call("GET", "/link-requests?pageSize=1&page=2", "MANAGER")).json().data.rows.map((r: { id: string }) => r.id)).toEqual(["lr2"]);
    for (const q of ["status=ALL", "pageSize=51", "page=0", "orgId=org_b", "x=1"]) expect((await call("GET", `/link-requests?${q}`, "MANAGER")).statusCode, q).toBe(400);
  });

  it("approving links the vehicle to the customer, marks the request, tells the customer and logs it; it does NOT release the vehicle", async () => {
    const res = await call("POST", "/link-requests/lr1/approve", "MANAGER", {});
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ id: "lr1", status: "APPROVED", vehicle: { id: "sv_free", serial: "FC602" } });
    expect(row("vehicle", "sv_free")).toMatchObject({ customerId: "cust_a1" });
    expect(row("vehicle", "sv_free")["customerVisible"] ?? false).toBe(false);
    expect(row("vehicleLinkRequest", "lr1")).toMatchObject({ status: "APPROVED", vehicleId: "sv_free", decidedById: "staff_a1" });
    expect(row("vehicleLinkRequest", "lr1")["decidedAt"]).toBeInstanceOf(Date);
    expect(rows("notification")).toMatchObject([{ userId: "cust_a1", event: "LINK_REQUEST_APPROVED", org_id: ORG_A, body: "Your request to link FC602 was approved." }]);
    expect(logs("APPROVE_LINK_REQUEST")).toMatchObject([{ actorId: "staff_a1", entityId: "lr1" }]);
  });

  it("a staff member can name the vehicle when the typed serial matches none", async () => {
    expect((await call("POST", "/link-requests/lr2/approve", "MANAGER", {})).statusCode).toBe(400);
    expect(row("vehicleLinkRequest", "lr2")["status"]).toBe("PENDING");
    const res = await call("POST", "/link-requests/lr2/approve", "MANAGER", { vehicleId: "sv_free" });
    expect(res.statusCode).toBe(200);
    expect(row("vehicle", "sv_free")["customerId"]).toBe("cust_a2");
  });

  it.each([["a vehicle of another org", "sv_b"], ["a vehicle that does not exist", "nope"]])("refuses %s as the target and leaves the request pending", async (_n, vehicleId) => {
    const res = await call("POST", "/link-requests/lr2/approve", "MANAGER", { vehicleId });
    expect(res.statusCode).toBe(400);
    expect(row("vehicleLinkRequest", "lr2")["status"]).toBe("PENDING");
    expect(rows("notification")).toHaveLength(0);
  });

  it("will not take a vehicle that belongs to another customer (409), and changes nothing", async () => {
    Object.assign(row("vehicleLinkRequest", "lr1"), { serialEntered: "FC603" });
    const res = await call("POST", "/link-requests/lr1/approve", "MANAGER", {});
    expect(res.statusCode).toBe(409);
    expect(row("vehicle", "sv_taken")["customerId"]).toBe("cust_a2");
    expect(row("vehicleLinkRequest", "lr1")["status"]).toBe("PENDING");
    expect(rows("notification")).toHaveLength(0);
  });

  it("a request already decided can not be decided again (409), either way", async () => {
    expect((await call("POST", "/link-requests/lr_done/approve", "MANAGER", {})).statusCode).toBe(409);
    expect((await call("POST", "/link-requests/lr_done/reject", "MANAGER", {})).statusCode).toBe(409);
    await call("POST", "/link-requests/lr1/approve", "MANAGER", {});
    expect((await call("POST", "/link-requests/lr1/approve", "MANAGER", {})).statusCode).toBe(409);
    expect((await call("POST", "/link-requests/lr1/reject", "MANAGER", {})).statusCode).toBe(409);
    expect(rows("notification")).toHaveLength(1);
  });

  it("an approval for a customer who deleted their account is refused", async () => {
    Object.assign(row("user", "cust_a1"), { deletedAt: new Date() });
    expect((await call("POST", "/link-requests/lr1/approve", "MANAGER", {})).statusCode).toBe(400);
    expect(row("vehicle", "sv_free")["customerId"] ?? null).toBeNull();
  });

  it("rejecting marks it, tells the customer WITHOUT a reason or any hint about the vehicle, and leaves vehicles alone", async () => {
    const res = await call("POST", "/link-requests/lr1/reject", "MANAGER", {});
    expect(res.json().data).toEqual({ id: "lr1", status: "REJECTED" });
    expect(row("vehicleLinkRequest", "lr1")).toMatchObject({ status: "REJECTED", decidedById: "staff_a1" });
    expect(row("vehicle", "sv_free")["customerId"] ?? null).toBeNull();
    const [n] = rows("notification");
    expect(n).toMatchObject({ userId: "cust_a1", event: "LINK_REQUEST_REJECTED", body: "Your request to link FC602 could not be approved." });
    expect(JSON.stringify(n)).not.toMatch(/exist|not found|owned|another/i);
    expect(logs("REJECT_LINK_REQUEST")).toHaveLength(1);
  });

  it("the bodies are strict", async () => {
    expect((await call("POST", "/link-requests/lr1/approve", "MANAGER", { vehicleId: "sv_free", customerId: "cust_a2" })).statusCode).toBe(400);
    expect((await call("POST", "/link-requests/lr1/reject", "MANAGER", { extra: "because" })).statusCode).toBe(400);
  });
});

describe("FAQs", () => {
  it("creates, lists (drafts included), updates and deletes, with a log row for each, and customers see only published ones", async () => {
    const created = await call("POST", "/faqs", "MANAGER", { question: " How long? ", answer: "About a month.", sortOrder: 2, published: false });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id;
    expect(created.json().data).toMatchObject({ question: "How long?", published: false, sortOrder: 2 });
    expect((await call("GET", "/faqs", "MANAGER")).json().data.map((f: { id: string }) => f.id)).toEqual(["faq1", id]);
    expect((await app.inject({ method: "GET", url: "/api/customer/v1/help/faqs", headers: await bearerFor("cust_a1") })).json().data.map((f: { id: string }) => f.id)).toEqual(["faq1"]);

    expect((await call("PATCH", `/faqs/${id}`, "MANAGER", { published: true, answer: "About 4 weeks." })).json().data).toMatchObject({ published: true, answer: "About 4 weeks." });
    expect((await app.inject({ method: "GET", url: "/api/customer/v1/help/faqs", headers: await bearerFor("cust_a1") })).json().data).toHaveLength(2);

    expect((await call("DELETE", `/faqs/${id}`, "MANAGER")).json()).toEqual({ data: { deleted: true } });
    expect(rows("faq").some((f) => f["id"] === id)).toBe(false);
    expect(logs().map((l) => l["action"])).toEqual(["CREATE_FAQ", "UPDATE_FAQ", "DELETE_FAQ"]);
    expect(logs("DELETE_FAQ")[0]!["before"]).toMatchObject({ question: "How long?" });
  });

  it.each([
    ["a missing question", { answer: "x" }],
    ["an empty answer", { question: "q", answer: "  " }],
    ["a huge question", { question: "q".repeat(501), answer: "a" }],
    ["a huge answer", { question: "q", answer: "a".repeat(5001) }],
    ["a bad sort order", { question: "q", answer: "a", sortOrder: -1 }],
    ["a text sort order", { question: "q", answer: "a", sortOrder: "first" }],
    ["an org id", { question: "q", answer: "a", org_id: ORG_B }],
  ])("rejects %s", async (_n, body) => {
    expect((await call("POST", "/faqs", "MANAGER", body)).statusCode).toBe(400);
    expect(rows("faq")).toHaveLength(2);
  });

  it("an empty update is a 400", async () => {
    expect((await call("PATCH", "/faqs/faq1", "MANAGER", {})).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------

describe("releasing a vehicle", () => {
  it("shows it to its customer, and hiding it takes it away again; both are logged", async () => {
    const list = async () => (await app.inject({ method: "GET", url: "/api/customer/v1/vehicles", headers: await bearerFor("cust_a1") })).json().data.rows.map((r: { id: string }) => r.id);
    expect(await list()).toEqual([]);
    const res = await call("PATCH", "/vehicles/sv_own/customer-visibility", "MANAGER", { customerVisible: true });
    expect(res.json()).toEqual({ data: { id: "sv_own", customerVisible: true } });
    expect(await list()).toEqual(["sv_own"]);
    await call("PATCH", "/vehicles/sv_own/customer-visibility", "MANAGER", { customerVisible: false });
    expect(await list()).toEqual([]);
    expect(logs("SET_CUSTOMER_VISIBILITY")).toMatchObject([{ before: { customerVisible: false }, after: { customerVisible: true } }, { before: { customerVisible: true }, after: { customerVisible: false } }]);
  });

  it("a vehicle with no customer, or a local (FL) vehicle, cannot be released", async () => {
    for (const id of ["sv_free", "sv_fl"]) {
      const res = await call("PATCH", `/vehicles/${id}/customer-visibility`, "MANAGER", { customerVisible: true });
      expect(res.statusCode, id).toBe(400);
      expect(res.json().error.fieldErrors.customerVisible).toBeTruthy();
      expect(row("vehicle", id)["customerVisible"] ?? false).toBe(false);
    }
  });

  it("a deleted vehicle is a 404", async () => {
    Object.assign(row("vehicle", "sv_own"), { deletedAt: new Date() });
    expect((await call("PATCH", "/vehicles/sv_own/customer-visibility", "MANAGER", { customerVisible: true })).statusCode).toBe(404);
  });

  it.each([{}, { customerVisible: "yes" }, { customerVisible: true, customerId: "cust_a2" }])("rejects the body %j", async (body) => {
    expect((await call("PATCH", "/vehicles/sv_own/customer-visibility", "MANAGER", body)).statusCode).toBe(400);
  });
});

describe("customer-facing details", () => {
  it("sets the ports and voyage, shows them to the customer once released, clears them with null, and logs before and after", async () => {
    const res = await call("PATCH", "/vehicles/sv_own/customer-info", "MANAGER", { portOfLoading: " Port L ", portOfDischarge: "Port D", voyageNo: "V9" });
    expect(res.json().data).toEqual({ portOfLoading: "Port L", portOfDischarge: "Port D", voyageNo: "V9" });
    await call("PATCH", "/vehicles/sv_own/customer-visibility", "MANAGER", { customerVisible: true });
    const seen = (await app.inject({ method: "GET", url: "/api/customer/v1/vehicles/sv_own", headers: await bearerFor("cust_a1") })).json().data;
    expect(seen).toMatchObject({ portOfLoading: "Port L", voyageNo: "V9" });

    const cleared = await call("PATCH", "/vehicles/sv_own/customer-info", "MANAGER", { voyageNo: "" });
    expect(cleared.json().data).toEqual({ portOfLoading: "Port L", portOfDischarge: "Port D", voyageNo: null });
    expect(logs("SET_CUSTOMER_INFO")).toHaveLength(2);
    expect(Object.values(logs("SET_CUSTOMER_INFO")[0]!["before"] as object).every((v) => v == null)).toBe(true);
  });

  it("the staff vehicle detail shows the ports and voyage, and no customer amount", async () => {
    await call("PATCH", "/vehicles/sv_own/customer-info", "MANAGER", { portOfLoading: "P" });
    const detail = (await call("GET", "/vehicles/FC601", "VIEWER")).json().data;
    expect(detail).toMatchObject({ customerVisible: false, portOfLoading: "P", voyageNo: null });
    expect(detail).not.toHaveProperty("customerAmount");
    expect(detail).not.toHaveProperty("customerAmountCurrency");
  });

  it.each([
    ["a customer amount", { customerAmount: 5 }],
    ["a customer amount currency", { customerAmountCurrency: "USD" }],
    ["an amount with its currency", { customerAmount: 5, customerAmountCurrency: "USD" }],
    ["a null amount", { customerAmount: null, customerAmountCurrency: null }],
    ["an empty change", {}],
    ["a long port name", { portOfLoading: "p".repeat(101) }],
    ["an internal field", { sellingPrice: 5 }],
    ["an org id", { voyageNo: "x", org_id: ORG_B }],
  ])("rejects %s as an unknown or empty change, and nothing is logged", async (_n, body) => {
    expect((await call("PATCH", "/vehicles/sv_own/customer-info", "MANAGER", body)).statusCode).toBe(400);
    expect(logs("SET_CUSTOMER_INFO")).toHaveLength(0);
  });

  it("amounts already stored in the unused database columns never reach a customer or a staff response", async () => {
    Object.assign(row("vehicle", "sv_own"), { customerAmount: 424242, customerAmountCurrency: "XSC", customerVisible: true });
    const customerSide = await app.inject({ method: "GET", url: "/api/customer/v1/vehicles/sv_own", headers: await bearerFor("cust_a1") });
    const customerList = await app.inject({ method: "GET", url: "/api/customer/v1/vehicles", headers: await bearerFor("cust_a1") });
    const staffSide = await call("GET", "/vehicles/FC601", "MANAGER");
    for (const res of [customerSide, customerList, staffSide]) expect(res.body).not.toMatch(/424242|XSC|customerAmount/);
  });
});

describe("releasing documents and photos", () => {
  it("sets a document's type and release flag, scoped to the vehicle", async () => {
    const res = await call("PATCH", "/vehicles/sv_own/documents/sd1", "MANAGER", { documentType: "BL", visibleToCustomer: true });
    expect(res.json().data).toEqual({ id: "sd1", documentType: "BL", visibleToCustomer: true });
    expect(logs("SET_DOCUMENT_RELEASE")).toMatchObject([{ entityId: "sd1", before: { documentType: "OTHER", visibleToCustomer: false }, after: { documentType: "BL", visibleToCustomer: true } }]);
    // a document of another vehicle, through this vehicle's URL, is a 404
    expect((await call("PATCH", "/vehicles/sv_own/documents/sd_other", "MANAGER", { visibleToCustomer: true })).statusCode).toBe(404);
    expect(row("vehicleDocument", "sd_other")["visibleToCustomer"]).toBe(false);
  });

  it.each([{}, { documentType: "SVG" }, { visibleToCustomer: "yes" }, { name: "x" }])("rejects the document body %j", async (body) => {
    expect((await call("PATCH", "/vehicles/sv_own/documents/sd1", "MANAGER", body)).statusCode).toBe(400);
  });

  it("releases and hides a single photo, scoped to the vehicle", async () => {
    expect((await call("PATCH", "/vehicles/sv_own/photos/sp1", "MANAGER", { visibleToCustomer: true })).json().data).toEqual({ id: "sp1", visibleToCustomer: true });
    expect(row("vehiclePhoto", "sp1")["visibleToCustomer"]).toBe(true);
    expect((await call("PATCH", "/vehicles/sv_own/photos/sp_other", "MANAGER", { visibleToCustomer: true })).statusCode).toBe(404);
    expect(row("vehiclePhoto", "sp_other")["visibleToCustomer"]).toBe(false);
  });

  it("releases a chosen set in one step; any id that is not this vehicle's changes NOTHING; repeated ids count once", async () => {
    const res = await call("PATCH", "/vehicles/sv_own/photos", "MANAGER", { visibleToCustomer: true, photoIds: ["sp1", "sp2", "sp1"] });
    expect(res.json().data).toEqual({ updated: 2, visibleToCustomer: true });
    expect(logs("SET_PHOTOS_RELEASE")).toHaveLength(1);

    const refused = await call("PATCH", "/vehicles/sv_own/photos", "MANAGER", { visibleToCustomer: false, photoIds: ["sp1", "sp_other"] });
    expect(refused.statusCode).toBe(404);
    expect(row("vehiclePhoto", "sp1")["visibleToCustomer"]).toBe(true);
    expect(row("vehiclePhoto", "sp_other")["visibleToCustomer"]).toBe(false);
  });

  it.each([{ visibleToCustomer: true }, { visibleToCustomer: true, photoIds: [] }, { visibleToCustomer: true, photoIds: "sp1" }, { photoIds: ["sp1"] }, { visibleToCustomer: true, photoIds: Array.from({ length: 201 }, (_, i) => `p${i}`) }, { visibleToCustomer: true, photoIds: ["sp1"], all: true }])(
    "rejects the bulk body %j (releasing 'all' is never implied)",
    async (body) => {
      expect((await call("PATCH", "/vehicles/sv_own/photos", "MANAGER", body)).statusCode).toBe(400);
      expect(row("vehiclePhoto", "sp1")["visibleToCustomer"]).toBe(false);
    }
  );

  it("a released photo and document show up for the customer, and hiding them removes them", async () => {
    await call("PATCH", "/vehicles/sv_own/customer-visibility", "MANAGER", { customerVisible: true });
    await call("PATCH", "/vehicles/sv_own/photos/sp1", "MANAGER", { visibleToCustomer: true });
    await call("PATCH", "/vehicles/sv_own/documents/sd1", "MANAGER", { visibleToCustomer: true, documentType: "EC" });
    const headers = await bearerFor("cust_a1");
    expect((await app.inject({ method: "GET", url: "/api/customer/v1/vehicles/sv_own/photos", headers })).json().data.map((p: { id: string }) => p.id)).toEqual(["sp1"]);
    expect((await app.inject({ method: "GET", url: "/api/customer/v1/documents", headers })).json().data.rows).toMatchObject([{ id: "sd1", type: "EC" }]);
    await call("PATCH", "/vehicles/sv_own/photos", "MANAGER", { visibleToCustomer: false, photoIds: ["sp1"] });
    expect((await app.inject({ method: "GET", url: "/api/customer/v1/vehicles/sv_own/photos", headers })).json().data).toEqual([]);
  });
});

describe("release readiness (read-only)", () => {
  const readiness = (role: Role = "OPERATOR", id = "sv_own") => call("GET", `/vehicles/${id}/release-readiness`, role);

  it("gives booleans and counts only, with exactly these keys", async () => {
    const res = await readiness();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ customerLinked: true, customerVisible: false, photosReleased: 0, photosHidden: 2, documentsReleased: 0, documentsHidden: 1 });
    expect(Object.keys(res.json().data).sort()).toEqual(["customerLinked", "customerVisible", "documentsHidden", "documentsReleased", "photosHidden", "photosReleased"]);
    expect(res.body).not.toMatch(/https?:|sp1|sd1|cust_a1|org_test|files\.example/);
  });

  it("follows the releases, and a vehicle with no customer says so", async () => {
    await call("PATCH", "/vehicles/sv_own/customer-visibility", "MANAGER", { customerVisible: true });
    await call("PATCH", "/vehicles/sv_own/photos/sp1", "MANAGER", { visibleToCustomer: true });
    await call("PATCH", "/vehicles/sv_own/documents/sd1", "MANAGER", { visibleToCustomer: true });
    expect((await readiness("MANAGER")).json().data).toEqual({ customerLinked: true, customerVisible: true, photosReleased: 1, photosHidden: 1, documentsReleased: 1, documentsHidden: 0 });
    expect((await readiness("ADMINISTRATOR", "sv_free")).json().data).toMatchObject({ customerLinked: false, customerVisible: false, photosReleased: 0, photosHidden: 1 });
  });

  it("changes nothing and writes no log", async () => {
    const before = JSON.stringify([rows("vehicle"), rows("vehiclePhoto"), rows("vehicleDocument")]);
    await readiness();
    expect(JSON.stringify([rows("vehicle"), rows("vehiclePhoto"), rows("vehicleDocument")])).toBe(before);
    expect(logs("SET_CUSTOMER_VISIBILITY")).toHaveLength(0);
  });

  it("a deleted or unknown vehicle is a 404", async () => {
    Object.assign(row("vehicle", "sv_free"), { deletedAt: new Date() });
    expect((await readiness("MANAGER", "sv_free")).statusCode).toBe(404);
    expect((await readiness("MANAGER", "nope")).statusCode).toBe(404);
  });
});

describe("mark arrived / mark delivered", () => {
  it("records the milestone for the vehicle with the staff member who did it, and the customer's status follows", async () => {
    await call("PATCH", "/vehicles/sv_own/customer-visibility", "MANAGER", { customerVisible: true });
    const headers = await bearerFor("cust_a1");
    const status = async () => (await app.inject({ method: "GET", url: "/api/customer/v1/vehicles/sv_own", headers })).json().data.status;
    expect(await status()).toBe("PENDING");

    const arrived = await call("POST", "/vehicles/sv_own/mark-arrived", "OPERATOR", { occurredAt: "2026-10-01" });
    expect(arrived.json().data).toMatchObject({ type: "ARRIVED", occurredAt: "2026-10-01T00:00:00.000Z" });
    expect(rows("vehicleMilestone")).toMatchObject([{ vehicleId: "sv_own", type: "ARRIVED", recordedById: "staff_a1" }]);
    expect(await status()).toBe("ARRIVED");

    await call("POST", "/vehicles/sv_own/mark-delivered", "MANAGER", {});
    expect(await status()).toBe("DELIVERED");
    expect(logs("SET_MILESTONE")).toHaveLength(2);
  });

  it.each([{ occurredAt: "2999-01-01" }, { occurredAt: "nope" }, { type: "SHIPPED" }])("rejects the body %j", async (body) => {
    expect((await call("POST", "/vehicles/sv_own/mark-arrived", "MANAGER", body)).statusCode).toBe(400);
    expect(rows("vehicleMilestone")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("reminder: shipped long ago, arrival not recorded", () => {
  const days = (n: number) => dayOffset(-n);
  const shipped = (vehicleId: string, daysAgo: number) =>
    fake.seed("vehicleMilestone", { id: `m_${vehicleId}_s`, org_id: ORG_A, vehicleId, type: "SHIPPED", occurredAt: days(daysAgo), recordedById: null });
  const reminders = () => rows("notification").filter((n) => n["event"] === "ARRIVAL_NOT_RECORDED");

  beforeEach(() => {
    fake.seed("user", { id: "mgr_r", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "M" });
  });

  it("fires on the 45th day after shipping, then every 7th day, to the people who can act on it", async () => {
    for (const [daysAgo, expected] of [[44, 0], [45, 1], [46, 0], [51, 0], [52, 1], [59, 1], [60, 0]] as const) {
      rows("notification").length = 0;
      rows("vehicleMilestone").length = 0;
      shipped("sv_own", daysAgo);
      const summary = await runDailyVehicleChecks(ORG_A);
      expect(summary.errors, `day ${daysAgo}`).toEqual([]);
      expect(summary.arrivalReminders, `day ${daysAgo}`).toBe(expected);
      expect(reminders().length > 0, `day ${daysAgo}`).toBe(expected === 1);
    }
  });

  it("is sent once per vehicle per day: a second run the same day sends nothing more", async () => {
    shipped("sv_own", 45);
    await runDailyVehicleChecks(ORG_A);
    const first = reminders().length;
    expect(first).toBeGreaterThan(0);
    expect((await runDailyVehicleChecks(ORG_A)).arrivalReminders).toBe(0);
    expect(reminders()).toHaveLength(first);
    expect(reminders()[0]).toMatchObject({ title: "Arrival not recorded", body: "FC601 shipped 45 days ago and has no arrival recorded.", vehicleId: "sv_own", org_id: ORG_A });
  });

  it("never for a vehicle that has arrived or been delivered, that is cancelled, local, deleted, or in another org", async () => {
    shipped("sv_own", 45);
    fake.seed("vehicleMilestone", { id: "m_arr", org_id: ORG_A, vehicleId: "sv_own", type: "ARRIVED", occurredAt: days(2), recordedById: "staff_a1" });
    shipped("sv_free", 45);
    Object.assign(row("vehicle", "sv_free"), { rowColourStatusId: "rc_cancel" });
    shipped("sv_fl", 45);
    shipped("sv_taken", 45);
    Object.assign(row("vehicle", "sv_taken"), { deletedAt: new Date() });
    fake.seed("vehicleMilestone", { id: "m_b", org_id: ORG_B, vehicleId: "sv_b", type: "SHIPPED", occurredAt: days(45), recordedById: null });
    expect((await runDailyVehicleChecks(ORG_A)).arrivalReminders).toBe(0);
    expect(reminders()).toHaveLength(0);
  });
});

describe("a link request that is ignored leaves a masked warning (the customer's answer is unchanged)", () => {
  const request = async (serial: string) =>
    app.inject({ method: "POST", url: "/api/customer/v1/vehicles/link-requests", headers: await bearerFor("cust_a1"), payload: { serial } });

  it("a duplicate logs the customer id only, never the serial", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = await request("FC4242");
    const again = await request("fc4242");
    expect(again.json()).toEqual(first.json());
    const text = warn.mock.calls.flat().join(" ");
    expect(text).toContain("customer link request ignored (duplicate): customer=cust_a1");
    expect(text).not.toMatch(/4242|FC/);
  });

  it("hitting the pending cap logs it too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 1; i <= 21; i++) {
      identifierLimiter.reset();
      await request(`FC${5000 + i}`);
    }
    const text = warn.mock.calls.flat().join(" ");
    expect(text).toContain("customer link request ignored (cap): customer=cust_a1");
    expect(text).not.toMatch(/FC\d/);
  });

  it("a request that is accepted logs nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await request("FC7001");
    expect(warn).not.toHaveBeenCalled();
  });
});
