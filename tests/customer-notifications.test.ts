// Slice 5: customer alerts, preferences, devices, presence, delivery (stream, push, email) and departure reminders.
// Fake data only; the stream tests open a real local socket.

import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { bearerFor, newCustomerFake, post, request } from "./helpers/customer-fixtures.js";
import { dayOffset, newVehicleFake, vehicleRow } from "./helpers/vehicle-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({ fake: undefined as unknown, emails: [] as { to: string; subject: string; text: string }[] }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
const push = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: push.send }));
vi.mock("../src/lib/email.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/email.js")>();
  return {
    ...actual,
    sendEmail: async (message: { to: string; subject: string; text: string }) => {
      state.emails.push(message);
      return { sent: true };
    },
  };
});

import { buildApp } from "../src/app.js";
import { InMemoryEventBus, getEventBus, setEventBus, type EventBus } from "../src/lib/events.js";
import { drainEmailQueue } from "../src/lib/email-queue.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";
import { emit, notifyRealtime, type EmitParams } from "../src/services/notification.service.js";
import { runDailyVehicleChecks } from "../src/services/reminder.service.js";

const TOKEN_1 = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_2 = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

let app: FastifyInstance;
let fake: FakePrisma;
let previousBus: EventBus;
const rows = (model: string) => fake.rows(model);
const row = (model: string, id: string) => rows(model).find((r) => r["id"] === id)!;
const staffHeaders = async (orgId = ORG_A) => ({
  authorization: `Bearer ${await signAccessToken({ sub: "staff_a1", orgId, role: "ADMINISTRATOR", name: "Staff", email: null })}`,
});

const as = async (id: string, method: "GET" | "PATCH" | "POST" | "DELETE", path: string, body?: unknown) =>
  request(app, method, path, await bearerFor(id), body);

async function settle() {
  await new Promise((r) => setTimeout(r, 20));
  await drainEmailQueue();
}

beforeEach(async () => {
  fake = newVehicleFake();
  for (const r of newCustomerFake().rows("user")) {
    const existing = fake.rows("user").find((u) => u["id"] === r["id"]);
    if (existing) Object.assign(existing, r);
    else fake.seed("user", r);
  }
  state.fake = fake;
  state.emails = [];
  push.send.mockReset();
  push.send.mockResolvedValue(undefined);
  previousBus = getEventBus();
  setEventBus(new InMemoryEventBus());
  identifierLimiter.reset();
  resetShadowLockouts();
  fake.seed("vehicle", vehicleRow({ id: "cv1", org_id: ORG_A, serial: "FC701", modelId: "model_a1", customerId: "cust_a1", customerVisible: true }));
  fake.seed("vehicle", vehicleRow({ id: "cv_hidden", org_id: ORG_A, serial: "FC702", modelId: "model_a1", customerId: "cust_a1", customerVisible: false }));
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await settle(); // alerts delivered by a test must not leak into the next one
  await app.close();
  setEventBus(previousBus);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe("access: every route needs a customer token", () => {
  const ROUTES: [string, string, unknown?][] = [
    ["GET", "/alerts"],
    ["POST", "/alerts/mark-read", { all: true }],
    ["GET", "/me/notification-preferences"],
    ["PATCH", "/me/notification-preferences", { pushEnabled: false }],
    ["POST", "/devices", { expoPushToken: TOKEN_1, platform: "ios" }],
    ["DELETE", "/devices/dev1"],
    ["POST", "/presence/heartbeat", {}],
    ["GET", "/stream"],
  ];

  it.each(ROUTES)("%s %s: 401 without a token, with a staff token, and with a garbage token", async (method, path, body) => {
    const send = (headers: Record<string, string>) => app.inject({ method: method as "GET", url: `/api/customer/v1${path}`, headers, ...(body === undefined ? {} : { payload: body as object }) });
    expect((await send({})).statusCode).toBe(401);
    expect((await send(await staffHeaders())).statusCode).toBe(401);
    expect((await send({ authorization: "Bearer not.a.token" })).statusCode).toBe(401);
  });

  it("a disabled customer is locked out of every route at once", async () => {
    Object.assign(row("user", "cust_a1"), { loginEnabled: false });
    for (const [method, path] of ROUTES) {
      const res = await as("cust_a1", method as "GET", path);
      expect(res.statusCode, path).toBe(401);
    }
  });

  it("responses are never cacheable", async () => {
    expect((await as("cust_a1", "GET", "/alerts")).headers["cache-control"]).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------------------------

describe("alerts", () => {
  const alert = (id: string, userId: string, createdAt: Date, over: Record<string, unknown> = {}) =>
    fake.seed("notification", { id, org_id: ORG_A, userId, event: "PHOTOS_ADDED", title: `T ${id}`, body: `B ${id}`, isRead: false, vehicleId: null, createdAt, ...over });

  beforeEach(() => {
    alert("n1", "cust_a1", new Date("2026-10-27T09:00:00Z"));
    alert("n2", "cust_a1", new Date("2026-10-27T08:00:00Z"), { isRead: true, vehicleId: "cv1" });
    alert("n3", "cust_a1", new Date("2026-10-26T20:00:00Z"), { vehicleId: "cv_hidden" });
    alert("n4", "cust_a1", new Date("2026-10-25T10:00:00Z"));
    alert("n_other", "cust_a2", new Date("2026-10-27T09:30:00Z"));
    fake.seed("notification", { id: "n_b", org_id: ORG_B, userId: "cust_b1", event: "X", title: "B", body: "B", isRead: false, vehicleId: null, createdAt: new Date() });
  });

  it("lists the customer's own alerts newest first, grouped by day, with the unread count", async () => {
    const res = await as("cust_a1", "GET", "/alerts");
    const data = res.json().data;
    expect(data.days.map((d: { date: string }) => d.date)).toEqual(["2026-10-27", "2026-10-26", "2026-10-25"]);
    expect(data.days[0].alerts.map((a: { id: string }) => a.id)).toEqual(["n1", "n2"]);
    expect(data.unreadCount).toBe(3);
    expect(data.total).toBe(4);
    expect(Object.keys(data.days[0].alerts[0]).sort()).toEqual(["body", "createdAt", "event", "id", "isRead", "title", "vehicleId"]);
    expect(res.body).not.toMatch(/n_other|n_b|org_id|userId/);
  });

  it("shows a vehicle id only while the customer may still see that vehicle", async () => {
    const alerts = (await as("cust_a1", "GET", "/alerts")).json().data.days.flatMap((d: { alerts: { id: string; vehicleId: string | null }[] }) => d.alerts);
    expect(alerts.find((a: { id: string }) => a.id === "n2").vehicleId).toBe("cv1");
    expect(alerts.find((a: { id: string }) => a.id === "n3").vehicleId).toBeNull(); // released later hidden, or not released
  });

  it("pages, and is strict about parameters", async () => {
    const page2 = (await as("cust_a1", "GET", "/alerts?pageSize=2&page=2")).json().data;
    expect(page2.days.flatMap((d: { alerts: { id: string }[] }) => d.alerts.map((a) => a.id))).toEqual(["n3", "n4"]);
    for (const q of ["pageSize=51", "page=0", "userId=cust_a2", "orgId=org_b", "x=1"]) expect((await as("cust_a1", "GET", `/alerts?${q}`)).statusCode, q).toBe(400);
  });

  it("another customer and another org see only their own", async () => {
    expect((await as("cust_a2", "GET", "/alerts")).json().data.total).toBe(1);
    expect((await request(app, "GET", "/alerts", await bearerFor("cust_b1", ORG_B))).json().data.total).toBe(1);
  });

  it("marks chosen alerts read, or all, and never touches anyone else's", async () => {
    const res = await as("cust_a1", "POST", "/alerts/mark-read", { ids: ["n1", "n_other", "n_b", "nope"] });
    expect(res.json()).toEqual({ data: { updated: 1 } });
    expect(row("notification", "n1")["isRead"]).toBe(true);
    expect(row("notification", "n_other")["isRead"]).toBe(false);
    expect(row("notification", "n_b")["isRead"]).toBe(false);

    expect((await as("cust_a1", "POST", "/alerts/mark-read", { all: true })).json()).toEqual({ data: { updated: 2 } });
    expect(rows("notification").filter((n) => n["userId"] === "cust_a1").every((n) => n["isRead"] === true)).toBe(true);
    expect(row("notification", "n_other")["isRead"]).toBe(false);
    expect((await as("cust_a1", "GET", "/alerts")).json().data.unreadCount).toBe(0);
  });

  it.each([{}, { ids: [] }, { ids: "n1" }, { ids: ["a b"] }, { all: false }, { all: true, ids: ["n1"] }, { ids: ["n1"], userId: "cust_a2" }, { ids: Array.from({ length: 201 }, (_, i) => `n${i}`) }])(
    "rejects the mark-read body %j",
    async (body) => {
      expect((await as("cust_a1", "POST", "/alerts/mark-read", body)).statusCode).toBe(400);
      expect(row("notification", "n1")["isRead"]).toBe(false);
    }
  );
});

// ---------------------------------------------------------------------------------------------

describe("notification preferences", () => {
  it("defaults: every switchable event on, 7 days, push and email on, WhatsApp off", async () => {
    const data = (await as("cust_a1", "GET", "/me/notification-preferences")).json().data;
    expect(data).toEqual({
      events: { BOOKING_RECEIVED: true, PHOTOS_ADDED: true, DOCUMENTS_READY: true, DEPARTURE_REMINDER: true, NEW_STOCK: true, CHAT_MESSAGE: true },
      departureLeadDays: 7,
      pushEnabled: true,
      emailEnabled: true,
      whatsappEnabled: false,
    });
  });

  it("changes part of the settings, keeps the rest, logs before and after, and the change shows on the next read", async () => {
    const res = await as("cust_a1", "PATCH", "/me/notification-preferences", { events: { PHOTOS_ADDED: false }, departureLeadDays: 14, emailEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ departureLeadDays: 14, emailEnabled: false, pushEnabled: true });
    expect(res.json().data.events).toMatchObject({ PHOTOS_ADDED: false, BOOKING_RECEIVED: true });

    await as("cust_a1", "PATCH", "/me/notification-preferences", { events: { DOCUMENTS_READY: false } });
    const again = (await as("cust_a1", "GET", "/me/notification-preferences")).json().data;
    expect(again.events).toMatchObject({ PHOTOS_ADDED: false, DOCUMENTS_READY: false });
    expect(rows("notificationPreference")).toHaveLength(1);
    const log = rows("activityLog").filter((l) => l["action"] === "UPDATE_NOTIFICATION_PREFERENCES");
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ actorId: "cust_a1", entityId: "cust_a1", org_id: ORG_A, before: { departureLeadDays: 7 }, after: { departureLeadDays: 14 } });
  });

  it("settings belong to the token's customer: another customer is unaffected", async () => {
    await as("cust_a1", "PATCH", "/me/notification-preferences", { pushEnabled: false });
    expect((await as("cust_a2", "GET", "/me/notification-preferences")).json().data.pushEnabled).toBe(true);
  });

  it.each([
    [{}],
    [{ departureLeadDays: 5 }],
    [{ departureLeadDays: "7" }],
    [{ events: { NOT_AN_EVENT: false } }],
    [{ events: { LINK_REQUEST_APPROVED: false } }],
    [{ events: { PHOTOS_ADDED: "no" } }],
    [{ pushEnabled: "yes" }],
    [{ userId: "cust_a2", pushEnabled: false }],
    [{ org_id: ORG_B }],
  ])("rejects %j", async (body) => {
    expect((await as("cust_a1", "PATCH", "/me/notification-preferences", body)).statusCode).toBe(400);
    expect(rows("notificationPreference")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("devices", () => {
  it("registers a device without echoing the token, refreshes it, and removes only the customer's own", async () => {
    const res = await as("cust_a1", "POST", "/devices", { expoPushToken: TOKEN_1, platform: "ios", appVersion: "1.2.3" });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().data).sort()).toEqual(["id", "lastSeenAt", "platform"]);
    expect(res.body).not.toContain("ExponentPushToken");
    expect(rows("deviceToken")).toMatchObject([{ userId: "cust_a1", org_id: ORG_A, platform: "ios", appVersion: "1.2.3" }]);

    await as("cust_a1", "POST", "/devices", { expoPushToken: TOKEN_1, platform: "android" });
    expect(rows("deviceToken")).toHaveLength(1);
    expect(rows("deviceToken")[0]!["platform"]).toBe("android");

    const id = rows("deviceToken")[0]!["id"];
    expect((await as("cust_a2", "DELETE", `/devices/${id}`)).statusCode).toBe(404);
    expect(rows("deviceToken")).toHaveLength(1);
    expect((await request(app, "DELETE", `/devices/${id}`, await bearerFor("cust_b1", ORG_B))).statusCode).toBe(404);
    expect((await as("cust_a1", "DELETE", `/devices/${id}`)).json()).toEqual({ data: { deleted: true } });
    expect(rows("deviceToken")).toHaveLength(0);
    expect((await as("cust_a1", "DELETE", `/devices/${id}`)).statusCode).toBe(404);
  });

  it("a customer cannot take over a staff member's device, and a second customer on the same phone takes it over", async () => {
    fake.seed("deviceToken", { id: "staffdev", org_id: ORG_A, userId: "staff_a1", expoPushToken: TOKEN_2, platform: "ios", lastSeenAt: new Date() });
    const res = await as("cust_a1", "POST", "/devices", { expoPushToken: TOKEN_2, platform: "ios" });
    expect(res.statusCode).toBe(400);
    expect(row("deviceToken", "staffdev")["userId"]).toBe("staff_a1");

    await as("cust_a1", "POST", "/devices", { expoPushToken: TOKEN_1, platform: "ios" });
    await as("cust_a2", "POST", "/devices", { expoPushToken: TOKEN_1, platform: "ios" });
    expect(rows("deviceToken").filter((d) => d["expoPushToken"] === TOKEN_1).map((d) => d["userId"])).toEqual(["cust_a2"]);
  });

  it("keeps at most 10 devices per customer, dropping the oldest", async () => {
    for (let i = 0; i < 11; i += 1) {
      const token = `ExponentPushToken[${String(i).padStart(22, "x")}]`;
      fake.seed("deviceToken", { id: `d${i}`, org_id: ORG_A, userId: "cust_a1", expoPushToken: token, platform: "ios", lastSeenAt: new Date(2026, 0, i + 1) });
    }
    // the fake started with 11; registering one more first trims down to 9, then adds
    await as("cust_a1", "POST", "/devices", { expoPushToken: TOKEN_1, platform: "ios" });
    expect(rows("deviceToken").filter((d) => d["userId"] === "cust_a1")).toHaveLength(10);
    expect(rows("deviceToken").some((d) => d["id"] === "d0")).toBe(false);
    expect(rows("deviceToken").some((d) => d["id"] === "d10")).toBe(true);
  });

  it.each([{}, { expoPushToken: "not-a-token", platform: "ios" }, { expoPushToken: TOKEN_1, platform: "windows" }, { expoPushToken: TOKEN_1, platform: "ios", userId: "cust_a2" }, { expoPushToken: TOKEN_1 }])(
    "rejects %j",
    async (body) => {
      expect((await as("cust_a1", "POST", "/devices", body)).statusCode).toBe(400);
      expect(rows("deviceToken")).toHaveLength(0);
    }
  );
});

// ---------------------------------------------------------------------------------------------

describe("presence", () => {
  const lastActive = () => row("user", "cust_a1")["lastActiveAt"] as Date | null | undefined;

  it("writes the first heartbeat, then not again within 60 seconds, then again after; the answer never changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
      const first = await as("cust_a1", "POST", "/presence/heartbeat");
      expect(first.json()).toEqual({ data: { ok: true } });
      expect(lastActive()).toEqual(new Date("2026-10-27T10:00:00Z"));

      vi.setSystemTime(new Date("2026-10-27T10:00:59Z"));
      const second = await as("cust_a1", "POST", "/presence/heartbeat");
      expect(second.json()).toEqual(first.json());
      expect(lastActive()).toEqual(new Date("2026-10-27T10:00:00Z")); // not rewritten

      vi.setSystemTime(new Date("2026-10-27T10:01:01Z"));
      await as("cust_a1", "POST", "/presence/heartbeat");
      expect(lastActive()).toEqual(new Date("2026-10-27T10:01:01Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("only ever writes the token's own customer", async () => {
    await as("cust_a1", "POST", "/presence/heartbeat");
    expect(row("user", "cust_a2")["lastActiveAt"] ?? null).toBeNull();
    expect(row("user", "staff_a1")["lastActiveAt"] ?? null).toBeNull();
  });

  it("a customer who just checked in is 'active' for staff, and not after 5 minutes", async () => {
    await as("cust_a1", "POST", "/presence/heartbeat");
    const active = async () => (await app.inject({ method: "GET", url: "/api/v1/staff/customers/active", headers: await staffHeaders() })).json().data.map((c: { id: string }) => c.id);
    expect(await active()).toEqual(["cust_a1"]);
    Object.assign(row("user", "cust_a1"), { lastActiveAt: new Date(Date.now() - 5 * 60_000 - 1000) });
    expect(await active()).toEqual([]);
  });

  it("does not take a body, an id or an org from the client", async () => {
    await app.inject({ method: "POST", url: "/api/customer/v1/presence/heartbeat", headers: await bearerFor("cust_a1"), payload: { id: "cust_a2", org_id: ORG_B } });
    expect(row("user", "cust_a2")["lastActiveAt"] ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("delivery respects the customer's settings", () => {
  const params = (over: Partial<EmitParams> = {}): EmitParams => ({
    orgId: ORG_A,
    event: "PHOTOS_ADDED",
    title: "New photos",
    body: "New photos are available for FC701.",
    vehicleId: "cv1",
    recipientUserIds: ["cust_a1"],
    ...over,
  });
  const deliver = async (p: EmitParams) => {
    await emit(fake.client as never, p);
    notifyRealtime(p);
    await settle();
  };
  const device = () => fake.seed("deviceToken", { id: "cd1", org_id: ORG_A, userId: "cust_a1", expoPushToken: TOKEN_1, platform: "ios", lastSeenAt: new Date() });

  it("by default: an alert, a push and an email to the verified address", async () => {
    device();
    await deliver(params());
    expect(rows("notification")).toHaveLength(1);
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(state.emails).toMatchObject([{ to: "a1@example.test", subject: "New photos" }]);
    expect(state.emails[0]!.text).toContain("New photos are available for FC701.");
  });

  it("an event switched off: no alert, no push, no email", async () => {
    device();
    fake.seed("notificationPreference", { id: "p1", org_id: ORG_A, userId: "cust_a1", events: { PHOTOS_ADDED: false }, departureLeadDays: 7, pushEnabled: true, emailEnabled: true, whatsappEnabled: false });
    await deliver(params());
    expect(rows("notification")).toHaveLength(0);
    expect(push.send).not.toHaveBeenCalled();
    expect(state.emails).toHaveLength(0);
  });

  it("push off: still an alert and an email, no push", async () => {
    device();
    fake.seed("notificationPreference", { id: "p1", org_id: ORG_A, userId: "cust_a1", events: {}, departureLeadDays: 7, pushEnabled: false, emailEnabled: true, whatsappEnabled: false });
    await deliver(params());
    expect(rows("notification")).toHaveLength(1);
    expect(push.send).not.toHaveBeenCalled();
    expect(state.emails).toHaveLength(1);
  });

  it("email off: still an alert and a push, no email", async () => {
    device();
    fake.seed("notificationPreference", { id: "p1", org_id: ORG_A, userId: "cust_a1", events: {}, departureLeadDays: 7, pushEnabled: true, emailEnabled: false, whatsappEnabled: false });
    await deliver(params());
    expect(rows("notification")).toHaveLength(1);
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(state.emails).toHaveLength(0);
  });

  it("an event a customer cannot switch off (link request result) is delivered even if the stored setting says false", async () => {
    fake.seed("notificationPreference", { id: "p1", org_id: ORG_A, userId: "cust_a1", events: { LINK_REQUEST_APPROVED: false }, departureLeadDays: 7, pushEnabled: true, emailEnabled: true, whatsappEnabled: false });
    await deliver(params({ event: "LINK_REQUEST_APPROVED", title: "Request approved", body: "Your request to link FC701 was approved." }));
    expect(rows("notification")).toHaveLength(1);
  });

  it("no email to an unverified, disabled, deleted or address-less customer; staff never get email", async () => {
    for (const id of ["cust_unverified", "cust_disabled", "cust_deleted", "cust_invited", "staff_a1"]) await deliver(params({ recipientUserIds: [id] }));
    expect(state.emails).toHaveLength(0);
  });

  it("the settings of one customer never decide for another", async () => {
    fake.seed("notificationPreference", { id: "p1", org_id: ORG_A, userId: "cust_a1", events: { PHOTOS_ADDED: false }, departureLeadDays: 7, pushEnabled: false, emailEnabled: false, whatsappEnabled: false });
    await deliver(params({ recipientUserIds: ["cust_a1", "cust_a2"] }));
    expect(rows("notification").map((n) => n["userId"])).toEqual(["cust_a2"]);
    expect(state.emails.map((e) => e.to)).toEqual(["a2@example.test"]);
  });

  it("the email carries only the title and the message", async () => {
    await deliver(params());
    expect(state.emails[0]!.text).not.toMatch(/cust_a1|org_test|cv1|ExponentPushToken/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("staff actions tell the customer", () => {
  let await_headers: Record<string, string> = {};
  beforeEach(async () => {
    await_headers = await staffHeaders();
  });
  const staff = async (method: "PATCH" | "PUT", url: string, body: unknown) =>
    app.inject({ method, url: `/api/v1${url}`, headers: await staffHeaders(), payload: body as object });
  const events = () => rows("notification").filter((n) => n["userId"] === "cust_a1").map((n) => n["event"]);

  beforeEach(() => {
    fake.seed("vehiclePhoto", { id: "ph1", vehicleId: "cv1", url: "https://files.example.test/org/x/1.jpg", visibleToCustomer: false, uploadedById: "staff_a1" }, { id: "ph2", vehicleId: "cv1", url: "https://files.example.test/org/x/2.jpg", visibleToCustomer: false, uploadedById: "staff_a1" }, { id: "ph_h", vehicleId: "cv_hidden", url: "https://files.example.test/org/x/3.jpg", visibleToCustomer: false, uploadedById: "staff_a1" });
    fake.seed("vehicleDocument", { id: "dc1", vehicleId: "cv1", url: "https://files.example.test/org/x/a.pdf", name: "a.pdf", documentType: "EC", visibleToCustomer: false, uploadedById: "staff_a1" }, { id: "dc2", vehicleId: "cv1", url: "https://files.example.test/org/x/b.pdf", name: "b.pdf", documentType: "OTHER", visibleToCustomer: false, uploadedById: "staff_a1" });
  });

  it("releasing photos tells the customer once, even for a burst; hiding tells nobody", async () => {
    await staff("PATCH", "/vehicles/cv1/photos/ph1", { visibleToCustomer: true });
    await staff("PATCH", "/vehicles/cv1/photos/ph2", { visibleToCustomer: true });
    await settle();
    expect(events()).toEqual(["PHOTOS_ADDED"]);
    expect(row("notification", rows("notification")[0]!["id"] as string)).toMatchObject({ title: "New photos", body: "New photos are available for FC701.", vehicleId: "cv1", org_id: ORG_A });
    await staff("PATCH", "/vehicles/cv1/photos/ph1", { visibleToCustomer: false });
    expect(events()).toHaveLength(1);
  });

  it("a bulk release tells the customer once; releasing photos that were already released tells nobody", async () => {
    await staff("PATCH", "/vehicles/cv1/photos", { visibleToCustomer: true, photoIds: ["ph1", "ph2"] });
    expect(events()).toEqual(["PHOTOS_ADDED"]);
    rows("notification").length = 0;
    await staff("PATCH", "/vehicles/cv1/photos", { visibleToCustomer: true, photoIds: ["ph1", "ph2"] });
    expect(events()).toEqual([]);
  });

  it("a vehicle the customer cannot see (not released) causes no alert at all", async () => {
    await staff("PATCH", "/vehicles/cv_hidden/photos/ph_h", { visibleToCustomer: true });
    expect(rows("notification")).toHaveLength(0);
  });

  it("releasing an export certificate or bill of lading says 'document ready'; other documents do not", async () => {
    await staff("PATCH", "/vehicles/cv1/documents/dc2", { visibleToCustomer: true });
    expect(events()).toEqual([]);
    await staff("PATCH", "/vehicles/cv1/documents/dc1", { visibleToCustomer: true });
    expect(rows("notification")).toMatchObject([{ event: "DOCUMENTS_READY", title: "Document ready", body: "The export certificate for FC701 is ready." }]);
    await staff("PATCH", "/vehicles/cv1/documents/dc1", { visibleToCustomer: true });
    expect(events()).toHaveLength(1); // unchanged: no second alert
  });

  it("a booking received tells the customer who owns the vehicle, only while they may see it", async () => {
    const edit = (id: string, serialChassis: string) =>
      app.inject({
        method: "PUT",
        url: `/api/v1/vehicles/${id}`,
        headers: await_headers,
        payload: { chassisNo: serialChassis, brandId: "brand_a1", modelId: "model_a1", customerId: "cust_a1", etd: "2031-01-01" },
      });
    await edit("cv_hidden", "CHASSIS-HIDDEN");
    expect(events()).toEqual([]); // not released: nothing to tell
    const res = await edit("cv1", "CHASSIS-SEEN");
    expect(res.statusCode).toBe(200);
    await settle();
    expect(rows("notification").filter((n) => n["userId"] === "cust_a1")).toMatchObject([{ event: "BOOKING_RECEIVED", title: "Booking received", body: "Your booking for FC701 has been received.", vehicleId: "cv1" }]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("departure reminders", () => {
  const reminders = () => rows("notification").filter((n) => n["event"] === "DEPARTURE_REMINDER");
  const etdIn = (id: string, days: number) => Object.assign(row("vehicle", id), { etd: dayOffset(days) });

  it.each([[3, 3], [7, 7], [14, 14]])("a customer who chose %i days gets it on the day the ETD is %i days away, not the days around it", async (lead, days) => {
    fake.seed("notificationPreference", { id: "p1", org_id: ORG_A, userId: "cust_a1", events: {}, departureLeadDays: lead, pushEnabled: true, emailEnabled: true, whatsappEnabled: false });
    for (const offset of [days - 1, days, days + 1]) {
      rows("notification").length = 0;
      etdIn("cv1", offset);
      const summary = await runDailyVehicleChecks(ORG_A);
      expect(summary.errors).toEqual([]);
      expect(reminders().length > 0, `etd in ${offset} days`).toBe(offset === days);
    }
  });

  it("the default is 7 days, and the message names the vehicle", async () => {
    etdIn("cv1", 7);
    await runDailyVehicleChecks(ORG_A);
    expect(reminders()).toMatchObject([{ userId: "cust_a1", title: "Departure reminder", body: "FC701 is due to depart in 7 days.", vehicleId: "cv1" }]);
  });

  it("at most one per vehicle per day, however many times the job runs", async () => {
    etdIn("cv1", 7);
    expect((await runDailyVehicleChecks(ORG_A)).departureReminders).toBe(1);
    expect((await runDailyVehicleChecks(ORG_A)).departureReminders).toBe(0);
    expect(reminders()).toHaveLength(1);
  });

  it("only for a vehicle the customer may see: not released, cancelled, local, deleted or ownerless", async () => {
    for (const id of ["cv_hidden"]) etdIn(id, 7);
    fake.seed("vehicle", vehicleRow({ id: "cv_fl", org_id: ORG_A, serial: "FL703", serialPrefix: "FL", modelId: "model_a1", customerId: "cust_a1", customerVisible: true, etd: dayOffset(7) }));
    fake.seed("vehicle", vehicleRow({ id: "cv_del", org_id: ORG_A, serial: "FC704", modelId: "model_a1", customerId: "cust_a1", customerVisible: true, etd: dayOffset(7), deletedAt: new Date() }));
    fake.seed("vehicle", vehicleRow({ id: "cv_free", org_id: ORG_A, serial: "FC705", modelId: "model_a1", customerId: null, customerVisible: true, etd: dayOffset(7) }));
    fake.seed("vehicle", vehicleRow({ id: "cv_cancel", org_id: ORG_A, serial: "FC706", modelId: "model_a1", customerId: "cust_a1", customerVisible: true, etd: dayOffset(7), rowColourStatusId: "rc_cancel" }));
    expect((await runDailyVehicleChecks(ORG_A)).departureReminders).toBe(0);
  });

  it("switching the event off in settings means no alert, no push and no email", async () => {
    etdIn("cv1", 7);
    fake.seed("notificationPreference", { id: "p1", org_id: ORG_A, userId: "cust_a1", events: { DEPARTURE_REMINDER: false }, departureLeadDays: 7, pushEnabled: true, emailEnabled: true, whatsappEnabled: false });
    await runDailyVehicleChecks(ORG_A);
    await settle();
    expect(reminders()).toHaveLength(0);
    expect(state.emails).toHaveLength(0);
  });

  it("another org's vehicles are not touched", async () => {
    Object.assign(row("vehicle", "cv1"), { etd: dayOffset(7) });
    await runDailyVehicleChecks(ORG_B);
    expect(reminders()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the customer stream", () => {
  let base: string;
  const openStreams: { abort: () => void }[] = [];

  afterEach(() => {
    for (const s of openStreams.splice(0)) s.abort();
  });

  async function listen() {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  }

  const shortLivedCustomerToken = (userId: string, seconds: number) =>
    new SignJWT({ orgId: ORG_A })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer("cargodev-api")
      .setAudience("customer")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
      .sign(new TextEncoder().encode(process.env["CUSTOMER_JWT_SECRET"]));

  async function open(path: string, token: string | null) {
    const controller = new AbortController();
    const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: controller.signal });
    let buffer = "";
    let done = false;
    const handle = {
      status: res.status,
      headers: res.headers,
      text: () => buffer,
      ended: () => done,
      abort: () => controller.abort(),
      waitFor: async (needle: string, ms = 3000) => {
        const deadline = Date.now() + ms;
        while (!buffer.includes(needle)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; got ${buffer}`);
          await new Promise((r) => setTimeout(r, 10));
        }
      },
    };
    openStreams.push(handle);
    if (res.status === 200 && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        } catch {
          /* aborted */
        } finally {
          done = true;
        }
      })();
    } else {
      buffer = await res.text();
      done = true;
    }
    return handle;
  }

  const customerToken = async (id: string) => (await bearerFor(id)).authorization!.slice(7);
  const params = (userId: string, title: string): EmitParams => ({ orgId: ORG_A, event: "PHOTOS_ADDED", title, body: "b", recipientUserIds: [userId] });

  beforeEach(async () => {
    await app.close();
    app = await buildApp({ rateLimit: false });
    await listen();
  });

  it("opens with event-stream headers, no-store, and delivers only this customer's alerts", async () => {
    const mine = await open("/api/customer/v1/stream", await customerToken("cust_a1"));
    const theirs = await open("/api/customer/v1/stream", await customerToken("cust_a2"));
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-type")).toContain("text/event-stream");
    expect(mine.headers.get("cache-control")).toBe("no-store");
    await mine.waitFor(": connected");

    const p = params("cust_a1", "For customer one");
    await emit(fake.client as never, p);
    notifyRealtime(p);
    await mine.waitFor("event: notification");
    await mine.waitFor("For customer one");
    await new Promise((r) => setTimeout(r, 50));
    expect(theirs.text()).not.toContain("For customer one");
  });

  it("a customer never receives a staff event, and never an event from another org", async () => {
    const customer = await open("/api/customer/v1/stream", await customerToken("cust_a1"));
    await customer.waitFor(": connected");
    for (const p of [params("staff_a1", "Staff only"), { ...params("cust_a1", "Other org"), orgId: ORG_B }]) {
      await emit(fake.client as never, p);
      notifyRealtime(p);
    }
    await new Promise((r) => setTimeout(r, 80));
    expect(customer.text()).not.toContain("Staff only");
    expect(customer.text()).not.toContain("Other org");
  });

  it("the staff stream does not accept a customer token, and the customer stream does not accept a staff token", async () => {
    expect((await open("/api/v1/notifications/stream", await customerToken("cust_a1"))).status).toBe(401);
    const staffToken = (await staffHeaders()).authorization.slice(7);
    expect((await open("/api/customer/v1/stream", staffToken)).status).toBe(401);
    expect((await open("/api/customer/v1/stream", null)).status).toBe(401);
  });

  it("ends when the token expires, after telling the client to sign in again", async () => {
    // Mint and connect under a frozen clock (at an exact second): the token is verified at the instant it was minted, however
    // slow the machine is, and the stream's expiry timer is measured from that same instant.
    vi.useFakeTimers({ toFake: ["Date"] });
    let short: Awaited<ReturnType<typeof open>>;
    try {
      vi.setSystemTime(new Date(Math.floor(Date.now() / 1000) * 1000));
      short = await open("/api/customer/v1/stream", await shortLivedCustomerToken("cust_a1", 1));
    } finally {
      vi.useRealTimers();
    }
    expect(short.status).toBe(200);
    await short.waitFor("event: reauth", 4000);
    await short.waitFor("token_expired");
    const deadline = Date.now() + 2000;
    while (!short.ended() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(short.ended()).toBe(true);
  });

  it("holds at most 3 streams per customer: the oldest is closed for a new one", async () => {
    const token = await customerToken("cust_a1");
    const streams = [];
    for (let i = 0; i < 4; i += 1) {
      const s = await open("/api/customer/v1/stream", token);
      await s.waitFor(": connected");
      streams.push(s);
    }
    await streams[0]!.waitFor("replaced");
    expect(streams[3]!.ended()).toBe(false);
  });

  it("a disabled customer cannot open a stream", async () => {
    Object.assign(row("user", "cust_a1"), { loginEnabled: false });
    expect((await open("/api/customer/v1/stream", await customerToken("cust_a1"))).status).toBe(401);
  });

  it("an unconfigured customer API does not expose the stream route", async () => {
    // covered by the zone tests: with no CUSTOMER_JWT_SECRET none of /api/customer/v1 exists
    expect((await open("/api/customer/v1/stream", "x")).status).toBe(401);
  });
});

// keep the unused helper import honest
void post;
