// The ORIGINAL mobile API contract (docs/legacy/mobile-api-reference.md) facts that must not change, pinned with fake data. A client
// built for that document keeps working only while these hold. Each block names the lines of the legacy document it pins.
// Behaviour the legacy document does not specify (response key sets of most reads, the missing-body message, ...) is NOT pinned here;
// docs/legacy-parity-report.md lists it as UNKNOWN.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { STAFF_PASSWORD, installFakeStorage, makeCtx, newContractWorld, removeFakeStorage, type Ctx } from "./helpers/staff-contract-examples.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const state = vi.hoisted(() => {
  process.env["R2_PUBLIC_URL"] = "https://files.example.test";
  return { fake: undefined as unknown, sent: [] as Array<Array<Record<string, unknown>>> };
});
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
// The Expo SDK is replaced by a recorder, so the REAL message building in src/lib/expo-push.ts runs and the wire messages can be read.
vi.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(token: unknown): boolean {
      return typeof token === "string" && /^Expo(nent)?PushToken\[.+\]$/.test(token);
    }
    chunkPushNotifications(messages: unknown[]): unknown[][] {
      return [messages];
    }
    async sendPushNotificationsAsync(chunk: Array<Record<string, unknown>>) {
      state.sent.push(chunk);
      return chunk.map(() => ({ status: "ok", id: "ticket" }));
    }
  }
  return { Expo };
});

import { buildApp } from "../src/app.js";
import { HTTP_STATUS } from "../src/lib/errors.js";
import { setTrustTokenClaimsForTests } from "../src/lib/staff-auth-seam.js";
import { SORT_KEYS } from "../src/lib/vehicle-list-url.js";
import { emit, notifyRealtime } from "../src/services/notification.service.js";
import { clearStaffAuthCache } from "../src/services/staff-auth-state.service.js";
import { vehicleListQuerySchema } from "../src/validation/vehicle.schema.js";

let app: FastifyInstance;
let fake: FakePrisma;
let ctx: Ctx;
type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; fieldErrors?: Record<string, string> } };
const call = async (as: Parameters<Ctx["call"]>[0], method: string, url: string, payload?: unknown) => {
  const res = await ctx.call(as, method, url, payload);
  return { status: res.status, headers: res.headers, body: res.body as Body };
};
const MANAGER = "manager@example.test";
const login = async (email = MANAGER, password = STAFF_PASSWORD) => call(null, "POST", "/api/v1/auth/login", { email, password });
const tokens = async (email = MANAGER) => {
  const res = await login(email);
  expect(res.status).toBe(200);
  return res.body.data as { accessToken: string; refreshToken: string };
};
const refresh = (refreshToken: unknown) => call(null, "POST", "/api/v1/auth/refresh", { refreshToken });
const WRONG = ["wrong", "guess"].join("-");

beforeAll(async () => {
  setTrustTokenClaimsForTests(false);
  installFakeStorage();
  state.fake = newContractWorld();
  app = await buildApp({ rateLimit: false, publicStockEnabled: true });
});
afterAll(async () => {
  await app.close();
  removeFakeStorage();
  setTrustTokenClaimsForTests(true);
});
beforeEach(() => {
  fake = newContractWorld();
  state.fake = fake;
  state.sent.length = 0;
  clearStaffAuthCache();
  ctx = makeCtx(app, fake);
});

// ---- legacy lines 85-109: the envelope, the codes, no-store ------------------------------------------------------------------

describe("the envelope and the error codes (legacy lines 85-109)", () => {
  it("a success is exactly { data }; an error is { error: { code, message, fieldErrors? } }", async () => {
    const ok = await call("MANAGER", "GET", "/api/v1/profile");
    expect(Object.keys(ok.body)).toEqual(["data"]);
    const bad = await call(null, "POST", "/api/v1/auth/login", { email: "not-an-email", password: "" });
    expect(Object.keys(bad.body)).toEqual(["error"]);
    expect(Object.keys(bad.body.error!).sort()).toEqual(["code", "fieldErrors", "message"]);
    for (const value of Object.values(bad.body.error!.fieldErrors!)) expect(typeof value).toBe("string"); // { "field": "..." }
    const missing = await call("MANAGER", "GET", "/api/v1/vehicles/FC999999");
    expect(Object.keys(missing.body.error!).sort()).toEqual(["code", "message"]); // fieldErrors only on VALIDATION
  });

  it("the codes and their statuses: VALIDATION 400, FORBIDDEN 403, NOT_FOUND 404, CONFLICT 409, INTERNAL 500 (UNAUTHENTICATED 401 is proven over HTTP below)", () => {
    expect({ VALIDATION: HTTP_STATUS.VALIDATION, FORBIDDEN: HTTP_STATUS.FORBIDDEN, NOT_FOUND: HTTP_STATUS.NOT_FOUND, CONFLICT: HTTP_STATUS.CONFLICT, INTERNAL: HTTP_STATUS.INTERNAL }).toEqual({
      VALIDATION: 400,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      INTERNAL: 500,
    });
  });

  it("401 UNAUTHENTICATED for a missing or malformed access token", async () => {
    const none = await call(null, "GET", "/api/v1/vehicles");
    expect([none.status, none.body.error?.code]).toEqual([401, "UNAUTHENTICATED"]);
    const garbage = await ctx.app.inject({ method: "GET", url: "/api/v1/vehicles", headers: { authorization: "Bearer not.a.token" } });
    expect([garbage.statusCode, (garbage.json() as Body).error?.code]).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("403 FORBIDDEN when the role does not allow the endpoint", async () => {
    for (const role of ["OPERATOR", "VIEWER"] as const) {
      const res = await call(role, "GET", "/api/v1/staff");
      expect([role, res.status, res.body.error?.code]).toEqual([role, 403, "FORBIDDEN"]);
    }
  });

  it("404 NOT_FOUND for a missing resource and for another organisation's, with the same body (never 403, never distinguished)", async () => {
    const unknown = await call("MANAGER", "GET", "/api/v1/vehicles/FC999999");
    const otherOrg = await call("MANAGER", "GET", "/api/v1/vehicles/FC900"); // exists, in the other organisation
    expect(unknown.status).toBe(404);
    expect(otherOrg.status).toBe(404);
    expect(otherOrg.body).toEqual(unknown.body);
    expect(unknown.body.error?.code).toBe("NOT_FOUND");
  });

  it("every answer carries Cache-Control: no-store (success, error, sign-in)", async () => {
    for (const res of [await call("MANAGER", "GET", "/api/v1/profile"), await call(null, "GET", "/api/v1/profile"), await call("MANAGER", "GET", "/api/v1/vehicles/FC999999"), await login()]) {
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });
});

// ---- legacy lines 23-83: sign-in, refresh, logout, session invalidation ------------------------------------------------------

describe("sign-in (legacy lines 32-56)", () => {
  it("200 with exactly accessToken, accessTokenExpiresIn (1200), refreshToken, refreshTokenExpiresAt (about 30 days) and user { id, name, email, role, orgId }", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["accessToken", "accessTokenExpiresIn", "refreshToken", "refreshTokenExpiresAt", "user"]);
    expect(data["accessTokenExpiresIn"]).toBe(1200);
    const days = (new Date(String(data["refreshTokenExpiresAt"])).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(Object.keys(data["user"] as object).sort()).toEqual(["email", "id", "name", "orgId", "role"]);
  });

  it("a wrong password is 400 VALIDATION", async () => {
    const res = await login(MANAGER, WRONG);
    expect([res.status, res.body.error?.code]).toEqual([400, "VALIDATION"]);
  });

  it("an unknown email is the SAME 400 VALIDATION answer as a wrong password (nothing tells the two apart)", async () => {
    const wrong = await login(MANAGER, WRONG);
    const unknown = await login("nobody@example.test", WRONG);
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("a bad request shape is 400 VALIDATION with fieldErrors", async () => {
    const res = await call(null, "POST", "/api/v1/auth/login", { email: "not-an-email", password: "" });
    expect([res.status, res.body.error?.code]).toEqual([400, "VALIDATION"]);
    expect(Object.keys(res.body.error!.fieldErrors!).sort()).toEqual(["email", "password"]);
  });

  it("five wrong attempts lock the account: the sixth, even with the right password, is 403 FORBIDDEN", async () => {
    for (let i = 0; i < 5; i += 1) expect((await login("viewer@example.test", WRONG)).status).toBe(400);
    const locked = await login("viewer@example.test");
    expect([locked.status, locked.body.error?.code]).toEqual([403, "FORBIDDEN"]);
  });
});

describe("refresh (legacy lines 58-69)", () => {
  it("200 with the same shape as sign-in, a NEW pair, and the token that was sent stops working", async () => {
    const first = await tokens();
    const res = await refresh(first.refreshToken);
    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["accessToken", "accessTokenExpiresIn", "refreshToken", "refreshTokenExpiresAt", "user"]);
    expect(data["refreshToken"]).not.toBe(first.refreshToken);
    expect((await refresh(first.refreshToken)).status).toBe(403);
  });

  it("every failure is 403 FORBIDDEN 'Session expired. Please sign in again.': unknown, expired, used, revoked, deactivated", async () => {
    const expected = (res: Awaited<ReturnType<typeof refresh>>, what: string) =>
      expect([what, res.status, res.body.error?.code, res.body.error?.message]).toEqual([what, 403, "FORBIDDEN", "Session expired. Please sign in again."]);

    expected(await refresh("a-token-nobody-ever-issued"), "unknown");

    const used = await tokens();
    await refresh(used.refreshToken);
    expected(await refresh(used.refreshToken), "already used");

    const expiring = await tokens();
    for (const row of fake.rows("refreshToken")) row["expiresAt"] = new Date(Date.now() - 1000);
    expected(await refresh(expiring.refreshToken), "expired");

    const loggedOut = await tokens("operator@example.test");
    await call(null, "POST", "/api/v1/auth/logout", { refreshToken: loggedOut.refreshToken });
    expected(await refresh(loggedOut.refreshToken), "revoked by logout");

    const gone = await tokens("viewer@example.test");
    const person = fake.rows("user").find((u) => u["email"] === "viewer@example.test")!;
    person["loginEnabled"] = false;
    expected(await refresh(gone.refreshToken), "account deactivated");
  });
});

describe("refresh, two at once (legacy line 29: single-use)", () => {
  it("two simultaneous refreshes with the same token: one wins (200), the other is the same 403 'Session expired. Please sign in again.'", async () => {
    const t = await tokens();
    const [a, b] = await Promise.all([refresh(t.refreshToken), refresh(t.refreshToken)]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    const loser = a.status === 403 ? a : b;
    expect(loser.body.error).toEqual({ code: "FORBIDDEN", message: "Session expired. Please sign in again." });
  });
});

describe("logout (legacy lines 71-76)", () => {
  it("200 { data: { loggedOut: true } }, and idempotent: the same token again, and an unknown token, are still 200", async () => {
    const t = await tokens();
    const first = await call(null, "POST", "/api/v1/auth/logout", { refreshToken: t.refreshToken });
    expect([first.status, first.body]).toEqual([200, { data: { loggedOut: true } }]);
    const again = await call(null, "POST", "/api/v1/auth/logout", { refreshToken: t.refreshToken });
    expect([again.status, again.body]).toEqual([200, { data: { loggedOut: true } }]);
    const unknown = await call(null, "POST", "/api/v1/auth/logout", { refreshToken: "a-token-nobody-ever-issued" });
    expect([unknown.status, unknown.body]).toEqual([200, { data: { loggedOut: true } }]);
  });
});

describe("session invalidation (legacy lines 78-83)", () => {
  it("deactivating the account by an admin revokes its refresh token: the next refresh is 403", async () => {
    const t = await tokens("operator@example.test");
    expect((await call("ADMINISTRATOR", "PATCH", "/api/v1/staff/staff_op", { active: false })).status).toBe(200);
    // Revoked outright, not merely refused later (the refresh also re-checks the account, which would hide a missing revocation).
    expect(fake.rows("refreshToken").filter((r) => r["userId"] === "staff_op" && r["revokedAt"] == null)).toHaveLength(0);
    expect((await refresh(t.refreshToken)).status).toBe(403);
  });

  it("changing the password revokes it too: by the user ...", async () => {
    const t = await tokens();
    const next = ["another", "Example", "Pass", "67890"].join("-");
    const changed = await call("MANAGER", "POST", "/api/v1/profile/password", { currentPassword: STAFF_PASSWORD, newPassword: next, confirmPassword: next });
    expect(changed.status).toBe(200);
    expect(fake.rows("refreshToken").filter((r) => r["userId"] === "staff_mgr" && r["revokedAt"] == null)).toHaveLength(0);
    expect((await refresh(t.refreshToken)).status).toBe(403);
  });

  it("... and by an admin", async () => {
    const t = await tokens("operator@example.test");
    const next = ["admin", "Set", "Example", "Pass", "13579"].join("-");
    expect((await call("ADMINISTRATOR", "PATCH", "/api/v1/staff/staff_op", { password: next })).status).toBe(200);
    expect((await refresh(t.refreshToken)).status).toBe(403);
  });
});

// ---- legacy lines 111-137: the vehicle list defaults and bounds ---------------------------------------------------------------

describe("pagination and list defaults (legacy lines 115-137, 253, 342)", () => {
  it("the vehicle list answers { rows, total, page, pageSize, totalPages } with page 1 and pageSize 50 by default", async () => {
    const res = await call("VIEWER", "GET", "/api/v1/vehicles");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data!).sort()).toEqual(["page", "pageSize", "rows", "total", "totalPages"]);
    expect([res.body.data!["page"], res.body.data!["pageSize"]]).toEqual([1, 50]);
  });

  it("pageSize 1 to 100 is accepted; 0, 101 and a page below 1 are 400 VALIDATION (never silently clamped)", async () => {
    for (const ok of ["1", "50", "100"]) expect((await call("VIEWER", "GET", `/api/v1/vehicles?pageSize=${ok}`)).status, ok).toBe(200);
    for (const bad of ["pageSize=0", "pageSize=101", "page=0", "page=-1", "pageSize=abc"]) {
      const res = await call("VIEWER", "GET", `/api/v1/vehicles?${bad}`);
      expect([bad, res.status, res.body.error?.code]).toEqual([bad, 400, "VALIDATION"]);
    }
  });

  it("an invalid filter value is a 400 (unlike the web filter bar, which falls back), and an unknown sort key too", async () => {
    for (const bad of ["billPaid=MAYBE", "track=XX", "sort=price", "dir=sideways", "status=GONE", "etdFrom=yesterday"]) {
      const res = await call("VIEWER", "GET", `/api/v1/vehicles?${bad}`);
      expect([bad, res.status, res.body.error?.code]).toEqual([bad, 400, "VALIDATION"]);
    }
  });

  it("the defaults the legacy document lists: track FC, sort serial, dir desc, no filters (held until the old route handler is checked)", () => {
    const parsed = vehicleListQuerySchema.parse({});
    expect([parsed.page, parsed.pageSize, parsed.track, parsed.sortBy, parsed.sortDir]).toEqual([1, 50, "FC", "serial", "desc"]);
  });

  it("every legacy sort key is still accepted", () => {
    const legacy = ["serial", "chassisNo", "model", "yom", "shipmentStatus", "purchaseDate", "etd", "eta", "destination", "docsArrivedDate", "nameChangeDeadline", "massoDate", "docSentDate", "recycleDate"];
    for (const key of legacy) {
      expect(SORT_KEYS as string[], key).toContain(key);
      expect(() => vehicleListQuerySchema.parse({ sort: key }), key).not.toThrow();
    }
  });

  it("exactly 17 sort keys are accepted (the 14 of the legacy document plus vesselName, deliveryDate and sellingPrice), nothing else", () => {
    const expected = ["serial", "chassisNo", "model", "yom", "shipmentStatus", "purchaseDate", "etd", "eta", "destination", "docsArrivedDate", "nameChangeDeadline", "massoDate", "docSentDate", "recycleDate", "vesselName", "deliveryDate", "sellingPrice"];
    expect([...SORT_KEYS].sort()).toEqual([...expected].sort());
    for (const key of expected) expect(() => vehicleListQuerySchema.parse({ sort: key }), key).not.toThrow();
    for (const bad of ["price", "id", "createdAt", "SERIAL", ""]) expect(() => vehicleListQuerySchema.parse({ sort: bad }), bad).toThrow();
  });

  it("the notification and activity-log lists paginate the same way (default 1 and 50; 1 to 100)", async () => {
    const notifications = await call("MANAGER", "GET", "/api/v1/notifications");
    expect([notifications.body.data!["page"], notifications.body.data!["pageSize"]]).toEqual([1, 50]);
    expect(Object.keys(notifications.body.data!).sort()).toEqual(["page", "pageSize", "rows", "total", "totalPages"]);
    expect((await call("MANAGER", "GET", "/api/v1/notifications?pageSize=100")).status).toBe(200);
    expect((await call("MANAGER", "GET", "/api/v1/notifications?pageSize=101")).status).toBe(400);
    const log = await call("ADMINISTRATOR", "GET", "/api/v1/activity-log");
    expect([log.body.data!["page"], log.body.data!["pageSize"]]).toEqual([1, 50]);
    expect((await call("ADMINISTRATOR", "GET", "/api/v1/activity-log?pageSize=101")).status).toBe(400);
  });

  it("filter-options is exactly the legacy object (lines 150-167)", async () => {
    const res = await call("VIEWER", "GET", "/api/v1/vehicles/filter-options");
    expect(res.body.data).toEqual({
      tracks: [{ value: "FC", label: "FC — Export" }, { value: "FL", label: "FL — Local" }],
      shipmentStatuses: [
        { value: "PENDING", label: "Pending" },
        { value: "BOOKING_RECEIVED", label: "Booking Received" },
        { value: "SHIPPED", label: "Shipped" },
        { value: "CANCELLED", label: "Shipment Cancelled" },
      ],
      shippingMethods: ["RORO", "CONTAINER"],
      triStateValues: ["YES", "NO", "BLANK"],
      twoStateValues: ["YES", "NO"],
      soldCurrencies: ["JPY", "LKR", "USD"],
    });
  });
});

describe("field notes (legacy lines 349-359)", () => {
  it("a tri-state field that was never entered is null, not false; dates are ISO 8601 strings", async () => {
    const d = (await call("VIEWER", "GET", "/api/v1/vehicles/FC101")).body.data!;
    expect([d["auctionBillPaid"], d["logBook"], d["extraKey"]]).toEqual([null, null, null]);
    expect(String(d["purchaseDate"])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("org_id is never read from the request: a body or query naming another organisation changes nothing and is not used", async () => {
    const res = await call("MANAGER", "GET", "/api/v1/vehicles?orgId=org_other&org_id=org_other");
    expect(res.status).toBe(200);
    const serials = ((res.body.data!["rows"] as Array<{ serial: string }>) ?? []).map((r) => r.serial);
    expect(serials).not.toContain("FC900"); // the other organisation's vehicle
  });
});

describe("who may call what (legacy lines 113, 315, 323)", () => {
  it("every authenticated staff role reads vehicles, customers, lookups, reports, dashboard, notifications, profile and organization", async () => {
    for (const url of ["/vehicles", "/customers", "/customers/search?q=a", "/lookups/brands", "/reports/by-customer", "/dashboard/stats", "/dashboard/trends", "/notifications", "/notifications/unread-count", "/profile", "/organization"]) {
      for (const role of ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"] as const) {
        const res = await call(role, "GET", `/api/v1${url}`);
        expect([role, url, res.status]).toEqual([role, url, 200]);
      }
    }
  });

  it("GET /staff is Administrator or Manager only", async () => {
    const statuses = [];
    for (const role of ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"] as const) statuses.push((await call(role, "GET", "/api/v1/staff")).status);
    expect(statuses).toEqual([200, 200, 403, 403]);
  });

  it("both activity-log endpoints are Administrator only", async () => {
    for (const url of ["/activity-log", "/activity-log/filters"]) {
      const statuses = [];
      for (const role of ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"] as const) statuses.push((await call(role, "GET", `/api/v1${url}`)).status);
      expect([url, ...statuses]).toEqual([url, 200, 403, 403, 403]);
    }
  });
});

// ---- legacy lines 247-264: notifications -------------------------------------------------------------------------------------

describe("notifications (legacy lines 247-264)", () => {
  const unread = async () => ((await call("MANAGER", "GET", "/api/v1/notifications/unread-count")).body.data as { count: number }).count;
  const row = (id: string) => fake.rows("notification").find((n) => n["id"] === id)!;

  it("unread-count is { count }", async () => {
    expect(Object.keys((await call("MANAGER", "GET", "/api/v1/notifications/unread-count")).body.data!)).toEqual(["count"]);
    expect(await unread()).toBe(1);
  });

  it("marking one read answers { read: true } and is idempotent: again, an unknown id, and another person's id are all 200 { read: true }, never 404", async () => {
    fake.seed("notification", { id: "n_admin", org_id: "org_test_a", userId: "staff_admin", event: "SHIPPED", title: "t", body: "b", isRead: false, vehicleId: null, createdAt: new Date() });
    const first = await call("MANAGER", "POST", "/api/v1/notifications/n_1/read");
    expect([first.status, first.body]).toEqual([200, { data: { read: true } }]);
    expect(await unread()).toBe(0);
    for (const id of ["n_1", "n_never_existed", "n_admin"]) {
      const res = await call("MANAGER", "POST", `/api/v1/notifications/${id}/read`);
      expect([id, res.status, res.body]).toEqual([id, 200, { data: { read: true } }]);
    }
    expect(row("n_admin")["isRead"]).toBe(false); // someone else's notification is never touched
  });

  it("read-all marks every unread notification of the caller and nobody else's", async () => {
    fake.seed(
      "notification",
      { id: "n_2", org_id: "org_test_a", userId: "staff_mgr", event: "SHIPPED", title: "t", body: "b", isRead: false, vehicleId: null, createdAt: new Date() },
      { id: "n_admin", org_id: "org_test_a", userId: "staff_admin", event: "SHIPPED", title: "t", body: "b", isRead: false, vehicleId: null, createdAt: new Date() }
    );
    expect(await unread()).toBe(2);
    expect((await call("MANAGER", "POST", "/api/v1/notifications/read-all")).status).toBe(200);
    expect(await unread()).toBe(0);
    expect(row("n_admin")["isRead"]).toBe(false);
  });

  it("the list only ever holds the caller's own notifications", async () => {
    fake.seed("notification", { id: "n_admin", org_id: "org_test_a", userId: "staff_admin", event: "SHIPPED", title: "t", body: "b", isRead: false, vehicleId: null, createdAt: new Date() });
    const rows = (await call("MANAGER", "GET", "/api/v1/notifications")).body.data!["rows"] as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["n_1"]);
  });
});

// ---- legacy lines 266-307: device tokens and the push payload ---------------------------------------------------------------

describe("device tokens (legacy lines 272-282)", () => {
  const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

  it("a real Expo token registers, a made-up one is 400 VALIDATION, and re-registering it under another user moves it", async () => {
    expect((await call("MANAGER", "POST", "/api/v1/device-tokens", { expoPushToken: TOKEN, platform: "ios" })).status).toBe(200);
    const bad = await call("MANAGER", "POST", "/api/v1/device-tokens", { expoPushToken: "not-a-token", platform: "ios" });
    expect([bad.status, bad.body.error?.code]).toEqual([400, "VALIDATION"]);
    expect((await call("OPERATOR", "POST", "/api/v1/device-tokens", { expoPushToken: TOKEN, platform: "android" })).status).toBe(200);
    const owners = fake.rows("deviceToken").filter((t) => t["expoPushToken"] === TOKEN).map((t) => t["userId"]);
    expect(owners).toEqual(["staff_op"]);
  });

  it("unregistering answers { unregistered: true } and is idempotent (an unknown token too)", async () => {
    await call("MANAGER", "POST", "/api/v1/device-tokens", { expoPushToken: TOKEN, platform: "ios" });
    for (let i = 0; i < 2; i += 1) {
      const res = await call("MANAGER", "DELETE", "/api/v1/device-tokens", { expoPushToken: TOKEN });
      expect([res.status, res.body]).toEqual([200, { data: { unregistered: true } }]);
    }
    const unknown = await call("MANAGER", "DELETE", "/api/v1/device-tokens", { expoPushToken: "ExponentPushToken[zzzzzzzzzzzzzzzzzzzzzz]" });
    expect([unknown.status, unknown.body]).toEqual([200, { data: { unregistered: true } }]);
  });
});

describe("the push payload `data` (legacy lines 289-307)", () => {
  const TOKEN = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
  const params = (over: Record<string, unknown> = {}) => ({ orgId: "org_test_a", event: "BOOKING_RECEIVED" as const, title: "Push check title", body: "FC102 now has a booking.", vehicleId: "v_fc_booked_future", recipientUserIds: ["staff_mgr"], ...over });

  beforeEach(() => {
    fake.seed("deviceToken", { id: "dt_1", org_id: "org_test_a", userId: "staff_mgr", expoPushToken: TOKEN });
  });

  it("is exactly { event, vehicleId, vehicleSerial, notificationId }, and notificationId is the id of the recipient's own notification row", async () => {
    const p = params();
    await emit(fake.client, p);
    notifyRealtime(p);
    await vi.waitFor(() => expect(state.sent).toHaveLength(1));
    const message = state.sent[0]!.find((m) => m["to"] === TOKEN)!; // the world already holds an older device of the same person
    expect(message).toBeDefined();
    expect(message["title"]).toBe("Push check title");
    expect(message["body"]).toBe("FC102 now has a booking.");
    const data = message["data"] as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["event", "notificationId", "vehicleId", "vehicleSerial"]);
    expect(data["event"]).toBe("BOOKING_RECEIVED");
    expect(data["vehicleId"]).toBe("v_fc_booked_future");
    expect(data["vehicleSerial"]).toBe("FC102");
    const own = fake.rows("notification").find((n) => n["userId"] === "staff_mgr" && n["title"] === "Push check title");
    expect(own).toBeDefined();
    expect(data["notificationId"]).toBe(own!["id"]);
  });

  it("a notification with no vehicle carries null vehicleId and null vehicleSerial (the keys stay)", async () => {
    const { vehicleId: _none, ...p } = params(); // no vehicle at all
    await emit(fake.client, p);
    notifyRealtime(p);
    await vi.waitFor(() => expect(state.sent).toHaveLength(1));
    const data = state.sent[0]!.find((m) => m["to"] === TOKEN)!["data"] as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["event", "notificationId", "vehicleId", "vehicleSerial"]);
    expect([data["vehicleId"], data["vehicleSerial"]]).toEqual([null, null]);
    expect(typeof data["notificationId"]).toBe("string");
  });
});

// ---- legacy lines 176-347: the read endpoints whose behaviour the legacy document does state --------------------------------

describe("lookups, customers, reports, organization and activity log: the behaviour the legacy document states", () => {
  it("customers: search items are { id, name }, one customer is { id, name } and an unknown id is 404", async () => {
    const search = await call("VIEWER", "GET", "/api/v1/customers/search?q=alpha");
    expect((search.body.data as unknown as Array<object>).map((r) => Object.keys(r).sort())).toEqual([["id", "name"]]);
    expect(Object.keys((await call("VIEWER", "GET", "/api/v1/customers/cust_1")).body.data!).sort()).toEqual(["id", "name"]);
    const missing = await call("VIEWER", "GET", "/api/v1/customers/cust_nobody");
    expect([missing.status, missing.body.error?.code]).toEqual([404, "NOT_FOUND"]);
  });

  it("customers: the full list carries vehicleCount", async () => {
    const rows = (await call("MANAGER", "GET", "/api/v1/customers")).body.data as unknown as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(typeof r["vehicleCount"]).toBe("number");
  });

  it("lookups: a model needs brandId and a grade needs modelId (400), and an unknown id is 404", async () => {
    expect((await call("VIEWER", "GET", "/api/v1/lookups/models")).status).toBe(400);
    expect((await call("VIEWER", "GET", "/api/v1/lookups/grades")).status).toBe(400);
    for (const path of ["brands", "auction-halls", "suppliers", "transport-companies", "packing-agents", "vehicle-locations", "inspection-companies", "inspection-by", "freight-agents", "models", "grades"]) {
      const res = await call("VIEWER", "GET", `/api/v1/lookups/${path}/id_that_does_not_exist`);
      expect([path, res.status, res.body.error?.code]).toEqual([path, 404, "NOT_FOUND"]);
    }
  });

  it("lookups: freight agents list with offersRoro and offersContainer, and the search takes method=RORO|CONTAINER; row colours are a full list", async () => {
    const agents = (await call("VIEWER", "GET", "/api/v1/lookups/freight-agents")).body.data as unknown as Array<Record<string, unknown>>;
    for (const a of agents) expect(Object.keys(a).sort()).toEqual(["id", "name", "offersContainer", "offersRoro"]);
    for (const method of ["RORO", "CONTAINER"]) expect((await call("VIEWER", "GET", `/api/v1/lookups/freight-agents/search?method=${method}`)).status, method).toBe(200);
    expect((await call("VIEWER", "GET", "/api/v1/lookups/freight-agents/search?method=AIR")).status).toBe(400);
    expect(((await call("VIEWER", "GET", "/api/v1/lookups/row-colour-statuses")).body.data as unknown as unknown[]).length).toBeGreaterThan(0);
  });

  it("lookups: a search returns at most 20 matches", async () => {
    for (let i = 0; i < 30; i += 1) fake.seed("brand", { id: `bulk_${i}`, org_id: "org_test_a", name: `Bulk Make ${i}` });
    const found = (await call("VIEWER", "GET", "/api/v1/lookups/brands?q=Bulk")).body.data as unknown as unknown[];
    expect(found.length).toBe(20);
  });

  it("reports: track is FC or FL and defaults to FC (ALL is a 400); by-freight-agent takes no track", async () => {
    for (const report of ["by-customer", "by-auction-hall", "by-destination"]) {
      expect((await call("VIEWER", "GET", `/api/v1/reports/${report}`)).status, report).toBe(200);
      expect((await call("VIEWER", "GET", `/api/v1/reports/${report}?track=FL`)).status, report).toBe(200);
      const all = await call("VIEWER", "GET", `/api/v1/reports/${report}?track=ALL`);
      expect([report, all.status, all.body.error?.code]).toEqual([report, 400, "VALIDATION"]);
    }
    expect((await call("VIEWER", "GET", "/api/v1/reports/by-freight-agent")).status).toBe(200);
  });

  it("organization is { name }", async () => {
    expect(Object.keys((await call("VIEWER", "GET", "/api/v1/organization")).body.data!)).toEqual(["name"]);
  });

  it("activity log: filters is { entities, actions }; a row has at least id, actorId, actorName, action, entity, entityId, before, after, createdAt", async () => {
    expect(Object.keys((await call("ADMINISTRATOR", "GET", "/api/v1/activity-log/filters")).body.data!).sort()).toEqual(["actions", "entities"]);
    const rows = (await call("ADMINISTRATOR", "GET", "/api/v1/activity-log")).body.data!["rows"] as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const key of ["id", "actorId", "actorName", "action", "entity", "entityId", "before", "after", "createdAt"]) expect(Object.keys(rows[0]!), key).toContain(key);
    for (const query of ["entity=Vehicle", "action=update", "entityId=v_fc_pending", "actorId=staff_mgr", "dateFrom=2020-01-01", "dateTo=2030-01-01"]) {
      expect((await call("ADMINISTRATOR", "GET", `/api/v1/activity-log?${query}`)).status, query).toBe(200);
    }
    // and the filters really filter: a value nothing matches leaves no rows
    for (const query of ["entity=NoSuchEntityAnywhere", "action=NoSuchActionAnywhere", "entityId=no_such_id", "actorId=no_such_actor"]) {
      const res = await call("ADMINISTRATOR", "GET", `/api/v1/activity-log?${query}`);
      expect([query, res.body.data!["total"], (res.body.data!["rows"] as unknown[]).length]).toEqual([query, 0, 0]);
    }
  });

  it("vehicles: the status filter repeats (?status=A&status=B); the status history of an FL vehicle is empty; files has auctionSheetUrl, photos and documents", async () => {
    expect((await call("VIEWER", "GET", "/api/v1/vehicles?status=PENDING&status=SHIPPED")).status).toBe(200);
    expect((await call("VIEWER", "GET", "/api/v1/vehicles/FL201/status-history")).body.data).toEqual([]);
    const files = (await call("VIEWER", "GET", "/api/v1/vehicles/FC102/files")).body.data!;
    for (const key of ["auctionSheetUrl", "photos", "documents"]) expect(Object.keys(files), key).toContain(key);
    expect((await call("VIEWER", "GET", "/api/v1/vehicles/FC102/pdf-images")).status).toBe(200);
    expect((await call("VIEWER", "GET", "/api/v1/vehicles/destinations")).status).toBe(200);
  });
});

describe("every query parameter of GET /vehicles that the legacy document lists is still accepted (legacy lines 122-135)", () => {
  const accepted: Array<[string, string]> = [
    ["page", "1"], ["pageSize", "25"], ["track", "FL"], ["track", "ALL"], ["q", "chassis"], ["status", "PENDING"], ["status", "BOOKING_RECEIVED"], ["status", "SHIPPED"], ["status", "CANCELLED"],
    ["destination", "ALL"], ["customer", "ALL"], ["rowColour", "ALL"], ["rowColourNot", "ALL"], ["brand", "ALL"], ["model", "ALL"], ["grade", "ALL"], ["hall", "ALL"], ["supplier", "ALL"],
    ["agent", "ALL"], ["packingAgent", "ALL"], ["location", "ALL"], ["transport", "ALL"], ["currency", "ALL"], ["currency", "USD"],
    ["method", "RORO"], ["method", "CONTAINER"], ["method", "ALL"],
    ["billPaid", "YES"], ["billPaid", "NO"], ["billPaid", "BLANK"], ["logBook", "BLANK"], ["extraKey", "NO"], ["paidByCustomer", "YES"],
    ["partnership", "YES"], ["partnership", "NO"], ["converted", "YES"], ["converted", "NO"],
    ["etdFrom", "2026-01-01"], ["etdTo", "2026-12-31"], ["etaFrom", "2026-01-01"], ["etaTo", "2026-12-31"],
    ["sort", "serial"], ["dir", "asc"], ["dir", "desc"],
  ];
  it.each(accepted)("%s=%s", async (name, value) => {
    const res = await call("VIEWER", "GET", `/api/v1/vehicles?${name}=${value}`);
    expect(res.status).toBe(200);
  });

  it("the tri-state filter BLANK means 'not entered' (null), distinct from NO (false)", async () => {
    const serials = async (value: string) => ((await call("VIEWER", "GET", `/api/v1/vehicles?track=ALL&pageSize=100&billPaid=${value}`)).body.data!["rows"] as Array<{ serial: string }>).map((r) => r.serial);
    const blank = await serials("BLANK");
    const no = await serials("NO");
    const yes = await serials("YES");
    expect(blank).toContain("FC101"); // never entered (null)
    expect(no).toContain("FC103"); // entered as false
    expect(yes).toContain("FC102"); // entered as true
    expect(no).not.toContain("FC101");
    expect(blank).not.toContain("FC103");
  });
});
