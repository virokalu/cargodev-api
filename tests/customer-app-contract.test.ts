// Keeps docs/customer-app-integration.md honest. Four checks, all against fake data:
//   1. every JSON block tagged `example=<id>` has the same KEY SET as the response the real code produces (recursively);
//   2. every block tagged `request=<id>` is accepted by the real request schema;
//   3. every route registered under /api/customer/v1 is in the doc's endpoint index, and every indexed route exists;
//   4. the alert texts, event list, limits and lifetimes the doc states match the code.
// A field added to a DTO, a route added or removed, or a changed limit fails here until the doc is updated.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Expo } from "expo-server-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A } from "./helpers/fixtures.js";
import { CUSTOMER_PASSWORD, NEW_PASSWORD, bearerFor, codeFrom, newCustomerFake, post, request } from "./helpers/customer-fixtures.js";
import { dayOffset, newVehicleFake, vehicleRow } from "./helpers/vehicle-fixtures.js";

vi.setConfig({ testTimeout: 60_000 });

const state = vi.hoisted(() => ({ fake: undefined as unknown, sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/email-queue.js", () => ({
  queueEmail: (message: { to: string; subject: string; text: string }) => {
    state.sent.push(message);
  },
  drainEmailQueue: async () => undefined,
}));

import { buildApp } from "../src/app.js";
import { CUSTOMER_RATE_LIMITS } from "../src/config/customer-rate-limits.js";
import { CUSTOMER_EVENTS, TOGGLEABLE_EVENTS } from "../src/config/customer-events.js";
import { MAX_MESSAGE_LENGTH, SUGGESTED_QUESTIONS } from "../src/config/chat.js";
import { OTP_REQUEST_LIMITS } from "../src/config/otp-limits.js";
import { CUSTOMER_ACCESS_TOKEN_TTL_SECONDS } from "../src/lib/customer-jwt.js";
import { InMemoryEventBus } from "../src/lib/events.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { getPrisma } from "../src/lib/prisma.js";
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS } from "../src/lib/otp.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";
import { SseHub, type SseSink } from "../src/lib/sse-hub.js";
import { TIMELINE } from "../src/services/customer-data.service.js";
import { PRESENCE_MIN_WRITE_INTERVAL_MS } from "../src/services/customer-alerts.service.js";
import { emit, notifyRealtime, type EmitParams } from "../src/services/notification.service.js";
import {
  customerDeleteAccountSchema,
  customerEmailOnlySchema,
  customerLoginSchema,
  customerLogoutSchema,
  customerRefreshSchema,
  customerRegisterSchema,
  customerResetPasswordSchema,
  customerUpdateMeSchema,
  customerVerifyEmailSchema,
} from "../src/validation/customer-auth.schema.js";
import { linkRequestBodySchema } from "../src/validation/customer-data.schema.js";
import { deviceBodySchema, markReadBodySchema, preferencesBodySchema } from "../src/validation/customer-notifications.schema.js";
import { sendMessageBodySchema, startConversationBodySchema } from "../src/validation/chat.schema.js";

const DOC_PATH = path.resolve(import.meta.dirname, "..", "docs", "customer-app-integration.md");
const doc = readFileSync(DOC_PATH, "utf8");
const PREFIX = "/api/customer/v1";

// ---------------------------------------------------------------------------------------------
// Reading the doc

function blocks(tag: "example" | "request"): Map<string, unknown> {
  const found = new Map<string, unknown>();
  const re = new RegExp("```json " + tag + "=([A-Za-z0-9_.-]+)\\r?\\n([\\s\\S]*?)\\r?\\n```", "g");
  for (const match of doc.matchAll(re)) {
    const id = match[1]!;
    if (found.has(id)) throw new Error(`duplicate ${tag} block: ${id}`);
    found.set(id, JSON.parse(match[2]!));
  }
  return found;
}
const examples = blocks("example");
const requests = blocks("request");

/** The rows of the endpoint index: `| 12 | PATCH | `/me` | customer | 3.1 |`. */
function indexedRoutes(): string[] {
  const routes: string[] = [];
  for (const match of doc.matchAll(/^\|\s*\d+\s*\|\s*(GET|POST|PATCH|PUT|DELETE)\s*\|\s*`([^`]+)`\s*\|/gm)) routes.push(`${match[1]} ${PREFIX}${match[2]}`);
  return routes.sort();
}

// ---------------------------------------------------------------------------------------------
// Comparing shapes: same key set at every object level; object/array-ness must agree; primitives may be null on either side.

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

function compareShape(docValue: Json, real: Json, at: string, problems: string[]): void {
  if (Array.isArray(docValue) || Array.isArray(real)) {
    if (!Array.isArray(docValue) || !Array.isArray(real)) return void problems.push(`${at}: array on one side only`);
    if ((docValue.length === 0) !== (real.length === 0)) return void problems.push(`${at}: one array is empty and the other is not`);
    docValue.forEach((item, i) => compareShape(item, real[Math.min(i, real.length - 1)], `${at}[${i}]`, problems));
    return;
  }
  if (isObject(docValue) || isObject(real)) {
    if (!isObject(docValue) || !isObject(real)) return void problems.push(`${at}: object on one side only`);
    const docKeys = Object.keys(docValue).sort();
    const realKeys = Object.keys(real).sort();
    if (JSON.stringify(docKeys) !== JSON.stringify(realKeys)) {
      problems.push(`${at}: keys differ. doc=[${docKeys.join(",")}] code=[${realKeys.join(",")}]`);
      return;
    }
    for (const key of docKeys) compareShape(docValue[key], real[key], `${at}.${key}`, problems);
    return;
  }
  if (docValue !== null && real !== null && typeof docValue !== typeof real) problems.push(`${at}: doc has ${typeof docValue}, code has ${typeof real}`);
}

function expectSameShape(id: string, real: Json): void {
  expect(examples.has(id), `the doc has no example=${id} block`).toBe(true);
  const problems: string[] = [];
  compareShape(examples.get(id), real, id, problems);
  expect(problems, problems.join("\n")).toEqual([]);
}

// ---------------------------------------------------------------------------------------------
// Fake world

let app: FastifyInstance;
let fake: FakePrisma;
const registered: { method: string; url: string }[] = [];
const rows = (model: string) => fake.rows(model);
const row = (model: string, id: string) => rows(model).find((r) => r["id"] === id)!;

const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const as = async (id: string, method: "GET" | "PATCH" | "POST" | "DELETE", p: string, body?: unknown) => request(app, method, p, await bearerFor(id), body);
const dataOf = (res: { json(): unknown }) => (res.json() as { data: unknown }).data;

beforeAll(async () => {
  fake = newVehicleFake();
  for (const r of newCustomerFake().rows("user")) {
    const existing = rows("user").find((u) => u["id"] === r["id"]);
    if (existing) Object.assign(existing, r);
    else fake.seed("user", r);
  }
  Object.assign(row("user", "cust_a1"), { phone: "+10000000000", country: "Exampleland", destinationPort: "Example Port", language: "en", theme: "dark", createdAt: new Date("2026-01-01T00:00:00Z") });
  state.fake = fake;
  identifierLimiter.reset();
  resetShadowLockouts();

  const v = (id: string, serial: string, over: Record<string, unknown>) =>
    fake.seed("vehicle", vehicleRow({ id, org_id: ORG_A, serial, customerId: "cust_a1", customerVisible: true, modelId: "model_a1", ...over }));
  v("cv1", "FC1024", { gradeId: "grade_a1", yom: 2019, chassisNo: "FAKE-CHASSIS-0001", destination: "Exampleland", purchaseDate: dayOffset(-30), shipmentStatus: "BOOKING_RECEIVED", etd: dayOffset(12), eta: dayOffset(40), portOfLoading: "Example Port L", portOfDischarge: "Example Port D", vesselName: "Example Vessel", voyageNo: "V001", blNo: "BL-FAKE-0001", shippingMethod: "CONTAINER", containerNumber: "FAKE0000001" });
  v("cv2", "FC1025", { purchaseDate: dayOffset(-90), shipmentStatus: "SHIPPED", etd: dayOffset(-60) });
  fake.seed("vehicleMilestone", { id: "m1", org_id: ORG_A, vehicleId: "cv1", type: "BOUGHT", occurredAt: new Date("2026-09-01"), recordedById: null }, { id: "m2", org_id: ORG_A, vehicleId: "cv2", type: "DELIVERED", occurredAt: new Date("2026-09-01"), recordedById: null });
  fake.seed("vehiclePhoto", { id: "ph1", vehicleId: "cv1", url: `https://files.example.test/org/${ORG_A}/vehicles/cv1/photos/ph1.jpg`, visibleToCustomer: true, uploadedById: "staff_a1" }, { id: "ph2", vehicleId: "cv1", url: `https://files.example.test/org/${ORG_A}/vehicles/cv1/photos/ph2.jpg`, visibleToCustomer: true, uploadedById: "staff_a1" });
  fake.seed("vehicleDocument", { id: "d1", vehicleId: "cv1", url: `https://files.example.test/org/${ORG_A}/vehicles/cv1/documents/d1.pdf`, name: "Bill of lading FC1024", documentType: "BL", visibleToCustomer: true, uploadedById: "staff_a1" });
  fake.seed("faq", { id: "f1", org_id: ORG_A, question: "How long does shipping take?", answer: "See the ETA.", sortOrder: 1, published: true, createdAt: new Date(2026, 0, 1) });
  fake.seed("notification", { id: "n1", org_id: ORG_A, userId: "cust_a1", event: "BOOKING_RECEIVED", title: "Booking received", body: "Your booking for FC1024 has been received.", isRead: false, vehicleId: "cv1", createdAt: new Date("2026-10-29T09:30:00Z") });

  app = await buildApp({ rateLimit: false, onRoute: (route) => registered.push(route) });
});
afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------------------------

describe("routes: the doc and the code list the same endpoints", () => {
  const realRoutes = () =>
    [...new Set(registered.filter((r) => r.url.startsWith(PREFIX) && r.method !== "HEAD" && r.method !== "OPTIONS").map((r) => `${r.method} ${r.url}`))].sort();

  it("every route registered under /api/customer/v1 is in the endpoint index", () => {
    const documented = new Set(indexedRoutes());
    const missing = realRoutes().filter((route) => !documented.has(route));
    expect(missing, `undocumented routes: ${missing.join(", ")}`).toEqual([]);
  });

  it("every indexed endpoint is a real route (nothing invented)", () => {
    const real = new Set(realRoutes());
    const invented = indexedRoutes().filter((route) => !real.has(route));
    expect(invented, `documented but not registered: ${invented.join(", ")}`).toEqual([]);
  });

  it("the index numbers the routes without gaps", () => {
    const numbers = [...doc.matchAll(/^\|\s*(\d+)\s*\|\s*(?:GET|POST|PATCH|PUT|DELETE)\s*\|/gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

describe("requests: every documented request body passes the real schema", () => {
  const SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean } }> = {
    register: customerRegisterSchema,
    "verify-email": customerVerifyEmailSchema,
    "email-only": customerEmailOnlySchema,
    login: customerLoginSchema,
    refresh: customerRefreshSchema,
    logout: customerLogoutSchema,
    "reset-password": customerResetPasswordSchema,
    "delete-account": customerDeleteAccountSchema,
    "update-me": customerUpdateMeSchema,
    "update-preferences": preferencesBodySchema,
    "register-device": deviceBodySchema,
    "link-request": linkRequestBodySchema,
    "mark-read": markReadBodySchema,
    "start-conversation": startConversationBodySchema,
    "send-message": sendMessageBodySchema,
  };

  it("has a schema for every request block, and a block for every schema", () => {
    expect([...requests.keys()].sort()).toEqual(Object.keys(SCHEMAS).sort());
  });

  it.each(Object.keys(SCHEMAS))("request=%s is accepted", (id) => {
    expect(SCHEMAS[id]!.safeParse(requests.get(id)).success).toBe(true);
  });

  it("the schemas are strict: an extra field is refused", () => {
    for (const id of Object.keys(SCHEMAS)) {
      const body = requests.get(id);
      if (isObject(body)) expect(SCHEMAS[id]!.safeParse({ ...body, extraField: 1 }).success, id).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Every example=<id> block must be produced by exactly one check below. `covered` is asserted against the doc at the end.

const covered = new Set<string>();
const check = (id: string, real: Json) => {
  covered.add(id);
  expectSameShape(id, real);
};

describe("examples: key sets equal the real responses", () => {
  it("auth: register, verify, resend, login, refresh, logout, forgot, reset, delete", async () => {
    state.sent.length = 0;
    const accepted = await post(app, "/auth/register", requests.get("register"));
    expect(accepted.statusCode).toBe(202);
    check("accepted", accepted.json());

    const code = codeFrom(state.sent.at(-1));
    const verifyBody = { ...(requests.get("verify-email") as object), code };
    const verified = await post(app, "/auth/verify-email", verifyBody);
    expect(verified.statusCode).toBe(200);
    check("verified", verified.json());

    const resend = await post(app, "/auth/resend-verification", requests.get("email-only"));
    expect(resend.statusCode).toBe(202);

    const login = await post(app, "/auth/login", requests.get("login"));
    expect(login.statusCode).toBe(200);
    check("login", login.json());
    check("session", dataOf(login));
    expect(dataOf(login)).toMatchObject({ accessTokenExpiresIn: CUSTOMER_ACCESS_TOKEN_TTL_SECONDS });

    const refreshed = await post(app, "/auth/refresh", { refreshToken: (dataOf(login) as { refreshToken: string }).refreshToken });
    expect(refreshed.statusCode).toBe(200);
    expectSameShape("login", refreshed.json());

    const loggedOut = await post(app, "/auth/logout", { refreshToken: (dataOf(refreshed) as { refreshToken: string }).refreshToken });
    expect(loggedOut.statusCode).toBe(200);
    check("logged-out", loggedOut.json());

    state.sent.length = 0;
    expect((await post(app, "/auth/forgot-password", { email: "a1@example.test" })).statusCode).toBe(202);
    const reset = await post(app, "/auth/reset-password", { email: "a1@example.test", code: codeFrom(state.sent.at(-1)), newPassword: NEW_PASSWORD });
    expect(reset.statusCode).toBe(200);
    check("reset", reset.json());

    const deleted = await as("cust_a2", "POST", "/auth/delete-account", { password: CUSTOMER_PASSWORD });
    expect(deleted.statusCode).toBe(200);
    check("deleted", deleted.json());
  });

  it("profile, preferences, devices", async () => {
    check("me", (await as("cust_a1", "GET", "/me")).json());
    expect((await as("cust_a1", "PATCH", "/me", requests.get("update-me"))).statusCode).toBe(200);
    check("preferences", (await as("cust_a1", "GET", "/me/notification-preferences")).json());
    const patched = await as("cust_a1", "PATCH", "/me/notification-preferences", requests.get("update-preferences"));
    expect(patched.statusCode).toBe(200);
    expectSameShape("preferences", patched.json());

    const device = await as("cust_a1", "POST", "/devices", requests.get("register-device"));
    expect(device.statusCode).toBe(200);
    check("device", device.json());
    expect(JSON.stringify(device.json())).not.toContain("ExponentPushToken");
    const deleted = await as("cust_a1", "DELETE", `/devices/${(dataOf(device) as { id: string }).id}`);
    expect(deleted.statusCode).toBe(200);
    check("device-deleted", deleted.json());
  });

  it("vehicles, timeline, photos, documents, purchase history", async () => {
    const home = (await as("cust_a1", "GET", "/home")).json() as { data: { nextDeparture: unknown; recentVehicles: unknown[] } };
    expect(home.data.nextDeparture).not.toBeNull();
    expect(home.data.recentVehicles.length).toBeGreaterThan(0);
    check("home", home);

    const list = (await as("cust_a1", "GET", "/vehicles")).json() as { data: { rows: unknown[] } };
    check("vehicles", list);
    check("vehicle-summary", list.data.rows[0]);

    check("vehicle-detail", (await as("cust_a1", "GET", "/vehicles/cv1")).json());

    const timeline = (await as("cust_a1", "GET", "/vehicles/cv1/timeline")).json() as { data: { type: string; label: string }[] };
    check("timeline", timeline);
    expect(timeline.data.map((s) => [s.type, s.label])).toEqual(TIMELINE.map((s) => [s.type, s.label]));
    expect(timeline.data).toHaveLength(9);

    check("photos", (await as("cust_a1", "GET", "/vehicles/cv1/photos")).json());
    check("documents", (await as("cust_a1", "GET", "/documents")).json());
    check("purchase-history", (await as("cust_a1", "GET", "/purchase-history")).json());
    check("faqs", (await as("cust_a1", "GET", "/help/faqs")).json());

    const accepted = await as("cust_a1", "POST", "/vehicles/link-requests", requests.get("link-request"));
    expect(accepted.statusCode).toBe(202);
    check("link-accepted", accepted.json());

    const min = await request(app, "GET", "/app/min-version");
    expect(min.statusCode).toBe(200);
    check("min-version", min.json());
  });

  it("alerts, chat, presence", async () => {
    check("alerts", (await as("cust_a1", "GET", "/alerts")).json());
    const marked = await as("cust_a1", "POST", "/alerts/mark-read", requests.get("mark-read"));
    expect(marked.statusCode).toBe(200);
    check("mark-read", marked.json());
    check("heartbeat", (await as("cust_a1", "POST", "/presence/heartbeat", {})).json());

    const suggested = (await as("cust_a1", "GET", "/chat/suggested-questions")).json() as { data: { questions: string[] } };
    check("suggested-questions", suggested);
    expect(examples.get("suggested-questions")).toEqual(suggested);

    const started = await as("cust_a1", "POST", "/conversations", { ...(requests.get("start-conversation") as object), vehicleId: "cv1" });
    expect(started.statusCode).toBe(201);
    check("conversation-started", started.json());
    const conversationId = (dataOf(started) as { conversation: { id: string } }).conversation.id;

    const sent = await as("cust_a1", "POST", `/conversations/${conversationId}/messages`, requests.get("send-message"));
    expect(sent.statusCode).toBe(201);
    check("message", sent.json());

    fake.seed("message", { id: "staff_reply", org_id: ORG_A, conversationId, senderType: "STAFF", senderId: "staff_a1", body: "Your vehicle is at the yard.", createdAt: new Date(Date.now() + 1000) });
    check("messages", (await as("cust_a1", "GET", `/conversations/${conversationId}/messages`)).json());
    check("conversations", (await as("cust_a1", "GET", "/conversations")).json());
  });

  it("errors: plain, with field errors, rate limited", async () => {
    const plain = await request(app, "GET", "/me");
    expect(plain.statusCode).toBe(401);
    check("error.plain", plain.json());

    const fields = await post(app, "/auth/register", { name: "A", email: "not-an-email" });
    expect(fields.statusCode).toBe(400);
    check("error.fields", fields.json());

    const limit = CUSTOMER_RATE_LIMITS.read.identifier;
    for (let i = 0; i <= limit.max; i++) identifierLimiter.hit("read", "cust_a1", limit);
    const limited = await as("cust_a1", "GET", "/home");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe(String(limit.windowMs / 1000));
    check("error.rate", limited.json());
    identifierLimiter.reset();
  });

  it("stream events: every event the hub can send", async () => {
    const bus = new InMemoryEventBus();
    const hub = new SseHub({ maxConnections: 10, bus: () => bus });
    const written: string[] = [];
    const sink = (): SseSink => ({ write: (chunk) => (written.push(chunk), true), end: () => undefined, writableLength: 0 });
    const dataFor = (name: string): unknown => {
      const chunk = written.find((c) => c.includes(`event: ${name}\n`));
      expect(chunk, `no ${name} event was written`).toBeDefined();
      return JSON.parse(/^data: (.*)$/m.exec(chunk!)![1]!);
    };

    hub.open({ userId: "cust_a1", orgId: ORG_A, sink: sink(), expiresAt: Date.now() + 60_000 });
    expect(written[0]).toBeUndefined();
    bus.publish({ type: "notification", orgId: ORG_A, userId: "cust_a1", id: "n1", payload: { id: "n1", event: "BOOKING_RECEIVED", title: "Booking received", body: "b", vehicleId: "cv1", createdAt: new Date().toISOString() } });
    bus.publish({ type: "message", orgId: ORG_A, userId: "cust_a1", id: "e2", payload: { conversationId: "c1", messageId: "m1", senderType: "STAFF", createdAt: new Date().toISOString(), body: "NEVER SENT" } });
    await new Promise((r) => setTimeout(r, 10)); // the bus delivers on a later microtask
    check("sse.notification", dataFor("notification"));
    check("sse.message", dataFor("message"));
    expect(written.join("")).not.toContain("NEVER SENT");

    hub.closeAll();
    check("sse.shutdown", dataFor("shutdown"));
    written.length = 0;

    // a 4th stream evicts the oldest
    for (let i = 0; i < 4; i++) hub.open({ userId: "cust_a1", orgId: ORG_A, sink: sink(), expiresAt: Date.now() + 60_000 });
    check("sse.closed", dataFor("closed"));
    hub.closeAll();
    written.length = 0;

    // token expiry
    hub.open({ userId: "cust_a1", orgId: ORG_A, sink: sink(), expiresAt: Date.now() - 1 });
    await new Promise((r) => setTimeout(r, 30));
    check("sse.reauth", dataFor("reauth"));
  });

  it("push: the exact message sent to Expo", async () => {
    fake.seed("deviceToken", { id: "dev_push", org_id: ORG_A, userId: "cust_a1", expoPushToken: TOKEN, platform: "ios", appVersion: null, lastSeenAt: new Date() });
    const sentMessages: Record<string, unknown>[] = [];
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(async (messages) => {
      sentMessages.push(...(messages as unknown as Record<string, unknown>[]));
      return [];
    });
    const params: EmitParams = { orgId: ORG_A, event: "BOOKING_RECEIVED", title: "Booking received", body: "Your booking for FC1024 has been received.", vehicleId: "cv1", recipientUserIds: ["cust_a1"] };
    await getPrisma().$transaction((tx) => emit(tx, params));
    notifyRealtime(params);
    for (let i = 0; i < 50 && sentMessages.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    vi.restoreAllMocks();
    expect(sentMessages).toHaveLength(1);
    check("push.message", sentMessages[0]);
    expect((sentMessages[0] as { data: Record<string, unknown> }).data["vehicleSerial"]).toBe("FC1024");
  });

  it("every example block in the doc was checked, and none is orphaned", () => {
    expect([...examples.keys()].filter((id) => !covered.has(id)), "doc examples with no check").toEqual([]);
    expect([...covered].filter((id) => !examples.has(id)), "checks with no doc example").toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Facts stated in prose and tables

describe("facts the doc states match the code", () => {
  it("lists exactly the customer alert types, with the switchable ones marked", () => {
    const section = doc.slice(doc.indexOf("### 7.2 The alert types"), doc.indexOf("### 7.3"));
    const events = [...section.matchAll(/^\| `([A-Z_]+)` \|[^|]*\|[^|]*\| (yes|no) \|/gm)].map((m) => [m[1], m[2]]);
    expect(Object.fromEntries(events)).toEqual(Object.fromEntries(Object.entries(CUSTOMER_EVENTS).map(([name, v]) => [name, v.toggleable ? "yes" : "no"])));
    expect(TOGGLEABLE_EVENTS).toHaveLength(6);
  });

  it("the alert titles and bodies in the doc appear in the code that raises them", () => {
    const read = (file: string) => readFileSync(path.resolve(import.meta.dirname, "..", "src", "services", file), "utf8");
    const expectations: [string, string[]][] = [
      ["vehicle.service.ts", ["Booking received", "Your booking for ${serial} has been received."]],
      ["vehicle-release.service.ts", ["New photos", "New photos are available for ${serial}.", "Document ready", "The ${name} for ${serial} is ready.", "export certificate", "bill of lading"]],
      ["reminder.service.ts", ["Departure reminder", "${vehicle.serial} is due to depart ${when}."]],
      ["stock.service.ts", ["New stock", "has just been added."]],
      ["chat.service.ts", ["New message", "You have a new message from the CargoDev team."]],
      ["link-request-admin.service.ts", ["Vehicle linked", "Your request to link ${request.serialEntered} was approved.", "Vehicle request", "could not be approved.", "About your request to link ${request.serialEntered}: ${reason}"]],
    ];
    for (const [file, texts] of expectations) {
      const source = read(file);
      for (const text of texts) expect(source, `${file} should contain: ${text}`).toContain(text);
    }
    const alertsSection = doc.slice(doc.indexOf("Exact texts"), doc.indexOf("### 7.3"));
    for (const phrase of ["Booking received", "Your booking for {serial} has been received.", "New photos are available for {serial}.", "Document ready", "Departure reminder", "New stock", "Vehicle linked", "Vehicle request", "You have a new message from the CargoDev team."]) {
      expect(alertsSection).toContain(phrase);
    }
  });

  it("the stated limits equal the configured limits", () => {
    const L = CUSTOMER_RATE_LIMITS;
    expect([L.register.ip.max, L.register.identifier.max, L.register.identifier.windowMs]).toEqual([5, 3, 3_600_000]);
    expect([L.verifyEmail.ip.max, L.verifyEmail.identifier.max, L.verifyEmail.identifier.windowMs]).toEqual([10, 10, 600_000]);
    expect([L.resendVerification.ip.max, L.resendVerification.identifier.max, L.resendVerification.identifier.windowMs]).toEqual([5, 3, 600_000]);
    expect([L.login.ip.max, L.login.identifier.max, L.login.identifier.windowMs]).toEqual([10, 20, 900_000]);
    expect([L.refresh.ip.max, L.logout.ip.max]).toEqual([30, 30]);
    expect([L.forgotPassword.ip.max, L.forgotPassword.identifier.max, L.forgotPassword.identifier.windowMs]).toEqual([5, 3, 3_600_000]);
    expect([L.resetPassword.ip.max, L.resetPassword.identifier.max, L.resetPassword.identifier.windowMs]).toEqual([10, 10, 600_000]);
    expect([L.deleteAccount.ip.max, L.deleteAccount.identifier.max, L.deleteAccount.identifier.windowMs]).toEqual([5, 5, 3_600_000]);
    expect(L.me.ip.max).toBe(60);
    expect([L.read.ip.max, L.read.identifier.max]).toEqual([120, 240]);
    expect([L.linkRequest.ip.max, L.linkRequest.identifier.max, L.linkRequest.identifier.windowMs]).toEqual([10, 5, 3_600_000]);
    expect(L.appConfig.ip.max).toBe(60);
    expect([L.fileDownload.ip.max, L.fileDownload.identifier.max]).toEqual([300, 120]);
    expect([L.alertsWrite.ip.max, L.alertsWrite.identifier.max]).toEqual([60, 60]);
    expect([L.preferences.ip.max, L.preferences.identifier.max]).toEqual([30, 30]);
    expect([L.devices.ip.max, L.devices.identifier.max, L.devices.identifier.windowMs]).toEqual([20, 30, 3_600_000]);
    expect([L.presence.ip.max, L.presence.identifier.max]).toEqual([60, 30]);
    expect([L.stream.ip.max, L.stream.identifier.max]).toEqual([30, 30]);
    expect([L.chatSend.ip.max, L.chatSend.identifier.max]).toEqual([60, 15]);
    expect([L.chatStart.ip.max, L.chatStart.identifier.max, L.chatStart.identifier.windowMs]).toEqual([20, 10, 3_600_000]);
    expect([OTP_REQUEST_LIMITS.perAddress.max, OTP_REQUEST_LIMITS.perIp.max]).toEqual([5, 20]);
    for (const text of [
      "5 per minute per IP; 3 per hour per email", "10 per minute per IP; 10 per 10 minutes per email", "5 per minute per IP; 3 per 10 minutes per email",
      "10 per minute per IP; 20 per 15 minutes per email", "30 per minute per IP", "5 per minute per IP; 3 per hour per email",
      "5 per minute per IP; 5 per hour per customer", "60 per minute per IP", "120 per minute per IP; 240 per minute per customer",
      "300 per minute per IP; 120 per minute per customer", "10 per minute per IP; 5 per hour per customer", "20 per minute per IP; 30 per hour per customer",
      "30 per minute per IP; 30 per minute per customer", "60 per minute per IP; 30 per minute per customer", "20 per minute per IP; 10 per hour per customer",
      "**15 per minute per customer**", "at most 5 codes per hour per address and 20 per hour per IP",
    ]) {
      expect(doc, text).toContain(text);
    }
  });

  it("lifetimes, code rules, message limit, presence throttle and timeline are as stated", () => {
    expect(CUSTOMER_ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(OTP_TTL_MS).toBe(10 * 60_000);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(MAX_MESSAGE_LENGTH).toBe(2000);
    expect(PRESENCE_MIN_WRITE_INTERVAL_MS).toBe(60_000);
    expect(SUGGESTED_QUESTIONS).toHaveLength(6);
    expect(doc).toContain("**1 to 2000 characters after trimming**");
    expect(doc).toContain("`accessTokenExpiresIn`");
    expect(doc).toContain("30 days");
    expect(doc).toContain("at most **once every 60 seconds**");
    expect(doc).toContain("Always exactly **9 steps, in this order**");
  });

  it("states a contract version and date at the top", () => {
    expect(doc).toMatch(/^\*\*Contract version:\*\* \d+\.\d+\.\d+$/m);
    expect(doc).toMatch(/^\*\*Date:\*\* \d{4}-\d{2}-\d{2}$/m);
  });

  it("contains no hostnames other than example ones, no secrets, no real ids", () => {
    const hosts = [...doc.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]!);
    expect(hosts.filter((h) => !/(^|\.)example\.(test|com)$/.test(h)), "non-example hosts").toEqual([]);
    expect(doc).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // a real JWT
    expect(doc).not.toMatch(/\bre_[A-Za-z0-9]{16,}/); // an email provider key
    expect(doc).not.toMatch(/r2\.cloudflarestorage|r2\.dev|supabase\.co|onrender\.com/);
  });
});
