// Slice 6: customer and staff chat. Fake data only; the stream test opens a real local socket.

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { CUSTOMER_PASSWORD, bearerFor, newCustomerFake, request } from "./helpers/customer-fixtures.js";
import { newVehicleFake, vehicleRow } from "./helpers/vehicle-fixtures.js";

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
import { CHAT_FULL_ROLES, CHAT_ROLES, CHAT_SCOPED_ROLES, chatScopeFor } from "../src/config/roles.js";
import { MAX_CONVERSATIONS_PER_CUSTOMER, MAX_MESSAGE_LENGTH } from "../src/config/chat.js";
import { drainEmailQueue } from "../src/lib/email-queue.js";
import { InMemoryEventBus, getEventBus, setEventBus, type AppEvent, type EventBus } from "../src/lib/events.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";
import { deleteCustomerAccount } from "../src/services/customer-auth.service.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const ALL_ROLES: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];

let app: FastifyInstance;
let fake: FakePrisma;
let bus: InMemoryEventBus;
let previousBus: EventBus;
const rows = (model: string) => fake.rows(model);
const row = (model: string, id: string) => rows(model).find((r) => r["id"] === id)!;
const logs = (action: string) => rows("activityLog").filter((l) => l["action"] === action);

const staffHeaders = async (role: Role, orgId = ORG_A, sub = "staff_a1") => ({
  authorization: `Bearer ${await signAccessToken({ sub, orgId, role, name: `Test ${role}`, email: null })}`,
});
const staff = async (method: "GET" | "POST", url: string, role: Role | null, body?: unknown, orgId = ORG_A, sub = orgId === ORG_B ? "staff_b1" : "staff_a1") =>
  app.inject({ method, url: `/api/v1${url}`, headers: role ? await staffHeaders(role, orgId, sub) : {}, ...(body === undefined ? {} : { payload: body as object }) });
const as = async (id: string, method: "GET" | "POST", path: string, body?: unknown, orgId = ORG_A) =>
  request(app, method, path, await bearerFor(id, orgId), body);

async function settle() {
  await new Promise((r) => setTimeout(r, 20));
  await drainEmailQueue();
}

/** Every bus event delivered to these users, by user id. */
function listen(userIds: string[], orgId = ORG_A) {
  const seen = new Map<string, AppEvent[]>(userIds.map((id) => [id, []]));
  for (const id of userIds) bus.subscribe(id, orgId, (event) => seen.get(id)!.push(event));
  return seen;
}

beforeEach(async () => {
  fake = newVehicleFake();
  for (const r of newCustomerFake().rows("user")) {
    const existing = fake.rows("user").find((u) => u["id"] === r["id"]);
    if (existing) Object.assign(existing, r);
    else fake.seed("user", r);
  }
  fake.seed(
    "user",
    { id: "staff_mgr2", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "Second Manager" },
    { id: "staff_op", org_id: ORG_A, userType: "STAFF", role: "OPERATOR", loginEnabled: true, name: "An Operator" },
    { id: "staff_b1", org_id: ORG_B, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "Org B Manager" }
  );
  state.fake = fake;
  state.emails = [];
  push.send.mockReset();
  push.send.mockResolvedValue(undefined);
  previousBus = getEventBus();
  bus = new InMemoryEventBus();
  setEventBus(bus);
  identifierLimiter.reset();
  resetShadowLockouts();
  fake.seed("vehicle", vehicleRow({ id: "cv1", org_id: ORG_A, serial: "FC801", modelId: "model_a1", customerId: "cust_a1", customerVisible: true }));
  fake.seed("vehicle", vehicleRow({ id: "cv_hidden", org_id: ORG_A, serial: "FC802", modelId: "model_a1", customerId: "cust_a1", customerVisible: false }));
  fake.seed("vehicle", vehicleRow({ id: "cv_other", org_id: ORG_A, serial: "FC803", modelId: "model_a1", customerId: "cust_a2", customerVisible: true }));
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await settle();
  await app.close();
  setEventBus(previousBus);
  vi.restoreAllMocks();
});

const start = async (id = "cust_a1", body: Record<string, unknown> = { body: "Hello, where is my car?" }, orgId = ORG_A) => {
  const res = await as(id, "POST", "/conversations", body, orgId);
  return { res, id: res.json().data?.conversation?.id as string };
};

// ---------------------------------------------------------------------------------------------

describe("access", () => {
  const CUSTOMER_ROUTES: [string, string, unknown?][] = [
    ["GET", "/chat/suggested-questions"],
    ["GET", "/conversations"],
    ["POST", "/conversations", { body: "hi" }],
    ["GET", "/conversations/c1/messages"],
    ["POST", "/conversations/c1/messages", { body: "hi" }],
  ];

  it.each(CUSTOMER_ROUTES)("customer %s %s: 401 without a token, with a staff token and with garbage", async (method, path, body) => {
    const send = (headers: Record<string, string>) => app.inject({ method: method as "GET", url: `/api/customer/v1${path}`, headers, ...(body === undefined ? {} : { payload: body as object }) });
    expect((await send({})).statusCode).toBe(401);
    expect((await send(await staffHeaders("ADMINISTRATOR"))).statusCode).toBe(401);
    expect((await send({ authorization: "Bearer nope" })).statusCode).toBe(401);
  });

  it("a disabled customer cannot chat", async () => {
    Object.assign(row("user", "cust_a1"), { loginEnabled: false });
    for (const [method, path] of CUSTOMER_ROUTES) expect((await as("cust_a1", method as "GET", path)).statusCode, path).toBe(401);
  });

  const STAFF_ROUTES: [string, string, unknown?][] = [
    ["GET", "/chat/conversations"],
    ["GET", "/chat/conversations/c1/messages"],
    ["POST", "/chat/conversations/c1/messages", { body: "hi" }],
    ["POST", "/chat/conversations/c1/handled", { handled: true }],
  ];

  it("the chat roles are in one constant", () => {
    expect([...CHAT_FULL_ROLES]).toEqual(["ADMINISTRATOR", "MANAGER"]);
    expect([...CHAT_SCOPED_ROLES]).toEqual(["OPERATOR"]);
    expect([...CHAT_ROLES]).toEqual(["ADMINISTRATOR", "MANAGER", "OPERATOR"]);
    expect(["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"].map((r) => chatScopeFor(r as Role))).toEqual(["ALL", "ALL", "ASSIGNED", null]);
    expect(chatScopeFor(null)).toBeNull();
  });

  describe.each(STAFF_ROUTES)("staff %s %s", (method, path, body) => {
    it("is 401 without a token and with a customer token", async () => {
      expect((await staff(method as "GET", path, null, body)).statusCode).toBe(401);
      const asCustomer = await app.inject({ method: method as "GET", url: `/api/v1${path}`, headers: await bearerFor("cust_a1"), ...(body === undefined ? {} : { payload: body as object }) });
      expect(asCustomer.statusCode).toBe(401);
    });
    it.each(ALL_ROLES.filter((r) => !CHAT_ROLES.includes(r)))("is 403 for %s and changes nothing", async (role) => {
      const res = await staff(method as "GET", path, role, body);
      expect(res.statusCode).toBe(403);
      expect(rows("message")).toHaveLength(0);
      expect(rows("activityLog")).toHaveLength(0);
    });
  });

  it("responses are never cacheable", async () => {
    expect((await as("cust_a1", "GET", "/chat/suggested-questions")).headers["cache-control"]).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------------------------

describe("customer chat", () => {
  it("starts a conversation with a first message, lists it, and reads it back", async () => {
    const { res, id } = await start();
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ conversation: { id, vehicleId: null }, message: { senderType: "CUSTOMER", body: "Hello, where is my car?" } });
    expect(Object.keys(res.json().data.message).sort()).toEqual(["body", "createdAt", "id", "senderType"]);

    const list = (await as("cust_a1", "GET", "/conversations")).json().data;
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({ id, vehicle: null, lastMessage: { senderType: "CUSTOMER", snippet: "Hello, where is my car?" } });

    const messages = (await as("cust_a1", "GET", `/conversations/${id}/messages`)).json().data;
    expect(messages.rows.map((m: { body: string }) => m.body)).toEqual(["Hello, where is my car?"]);
    expect(Object.keys(messages.rows[0]).sort()).toEqual(["body", "createdAt", "id", "senderType"]);
  });

  it("replies come newest first, and a staff message carries no staff identity", async () => {
    const { id } = await start();
    await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "Second" });
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "Staff answer" });
    const messages = (await as("cust_a1", "GET", `/conversations/${id}/messages`)).json();
    expect(messages.data.rows.map((m: { body: string }) => m.body)).toEqual(["Staff answer", "Second", "Hello, where is my car?"]);
    expect(messages.data.rows[0].senderType).toBe("STAFF");
    expect(JSON.stringify(messages)).not.toMatch(/staff_a1|senderId|Test MANAGER/);
  });

  it("pages messages, and is strict about parameters", async () => {
    const { id } = await start();
    for (let i = 0; i < 4; i += 1) await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: `m${i}` });
    const page2 = (await as("cust_a1", "GET", `/conversations/${id}/messages?pageSize=2&page=2`)).json().data;
    expect(page2.total).toBe(5);
    expect(page2.rows).toHaveLength(2);
    for (const q of ["pageSize=51", "page=0", "customerId=cust_a2", "orgId=x", "q=1"]) expect((await as("cust_a1", "GET", `/conversations/${id}/messages?${q}`)).statusCode, q).toBe(400);
  });

  it("suggested questions are static strings", async () => {
    const data = (await as("cust_a1", "GET", "/chat/suggested-questions")).json().data;
    expect(data.questions.length).toBeGreaterThan(3);
    expect(data.questions.every((q: unknown) => typeof q === "string")).toBe(true);
  });

  describe("vehicle ownership", () => {
    it("a conversation may be about the customer's own released vehicle, and the list names it", async () => {
      const { res, id } = await start("cust_a1", { vehicleId: "cv1", body: "About this one" });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.conversation.vehicleId).toBe("cv1");
      expect((await as("cust_a1", "GET", "/conversations")).json().data.rows[0].vehicle).toEqual({ id: "cv1", serial: "FC801" });
      expect(id).toBeTruthy();
    });

    it.each([
      ["another customer's vehicle", "cv_other"],
      ["a vehicle that is not released", "cv_hidden"],
      ["a vehicle that does not exist", "nope"],
    ])("%s is the same 404 and creates nothing", async (_n, vehicleId) => {
      const { res } = await start("cust_a1", { vehicleId, body: "Hi" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe("Vehicle not found.");
      expect(rows("conversation")).toHaveLength(0);
      expect(rows("message")).toHaveLength(0);
    });

    it("another org's vehicle is the same 404", async () => {
      fake.seed("vehicle", vehicleRow({ id: "cv_b", org_id: ORG_B, serial: "FC1", modelId: "model_b1", customerId: "cust_b1", customerVisible: true }));
      expect((await start("cust_a1", { vehicleId: "cv_b", body: "Hi" })).res.statusCode).toBe(404);
    });

    it("a vehicle that is hidden later is no longer named on the conversation", async () => {
      await start("cust_a1", { vehicleId: "cv1", body: "About this one" });
      Object.assign(row("vehicle", "cv1"), { customerVisible: false });
      expect((await as("cust_a1", "GET", "/conversations")).json().data.rows[0].vehicle).toBeNull();
    });
  });

  describe("only your own conversations", () => {
    it("another customer, another org and an unknown id are the same 404, for reading and for sending", async () => {
      const { id } = await start("cust_a1");
      for (const [who, orgId] of [["cust_a2", ORG_A], ["cust_b1", ORG_B]] as const) {
        const read = await as(who, "GET", `/conversations/${id}/messages`, undefined, orgId);
        const send = await as(who, "POST", `/conversations/${id}/messages`, { body: "intruder" }, orgId);
        expect([read.statusCode, send.statusCode]).toEqual([404, 404]);
        expect(read.json().error.message).toBe("Conversation not found.");
      }
      expect((await as("cust_a1", "GET", "/conversations/nope/messages")).statusCode).toBe(404);
      expect((await as("cust_a1", "GET", "/conversations/a%20b/messages")).statusCode).toBe(404);
      expect(rows("message")).toHaveLength(1);
    });

    it("lists show only the customer's own, and a staff-created conversation of someone else never appears", async () => {
      await start("cust_a1");
      await start("cust_a2", { body: "Mine" });
      expect((await as("cust_a1", "GET", "/conversations")).json().data.total).toBe(1);
      expect((await as("cust_a2", "GET", "/conversations")).json().data.total).toBe(1);
      expect((await as("cust_b1", "GET", "/conversations", undefined, ORG_B)).json().data.total).toBe(0);
    });
  });

  describe("plain text, up to 2000 characters", () => {
    it("accepts exactly 2000 and refuses 2001", async () => {
      const { id } = await start();
      expect(MAX_MESSAGE_LENGTH).toBe(2000);
      expect((await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "x".repeat(2000) })).statusCode).toBe(201);
      const tooLong = await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "x".repeat(2001) });
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json().error.fieldErrors.body).toMatch(/2000/);
    });

    it("trims, and refuses empty, whitespace-only, non-text and control characters", async () => {
      const { id } = await start();
      const send = (body: unknown) => as("cust_a1", "POST", `/conversations/${id}/messages`, body);
      expect((await send({ body: "  padded  " })).json().data.body).toBe("padded");
      expect((await send({ body: "\n\t both \u00a0sides \n" })).json().data.body).toBe("both \u00a0sides");
      for (const bad of [{}, { body: "" }, { body: "   \n\t " }, { body: 5 }, { body: null }, { body: ["a"] }, { body: "nul\u0000byte" }, { body: "bell\u0007" }]) {
        expect((await send(bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect(rows("message").map((m) => m["body"])).toEqual(["Hello, where is my car?", "padded", "both \u00a0sides"]);
    });

    it("normalises line breaks and keeps tabs and newlines", async () => {
      const { id } = await start();
      const res = await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "line one\r\nline two\tTabbed" });
      expect(res.json().data.body).toBe("line one\nline two\tTabbed");
    });

    it("markup is stored exactly as typed and only ever returned as a JSON string (never rendered)", async () => {
      const { id } = await start();
      const attack = `<script>alert("x")</script><img src=x onerror=alert(1)> {{7*7}} \${process.env} ' OR 1=1 --`;
      const sent = await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: attack });
      expect(sent.json().data.body).toBe(attack);
      expect(row("message", sent.json().data.id)["body"]).toBe(attack);
      const read = await as("cust_a1", "GET", `/conversations/${id}/messages`);
      expect(read.headers["content-type"]).toContain("application/json");
      expect(read.json().data.rows[0].body).toBe(attack);
      const staffRead = await staff("GET", `/chat/conversations/${id}/messages`, "MANAGER");
      expect(staffRead.headers["content-type"]).toContain("application/json");
      expect(staffRead.json().data.rows[0].body).toBe(attack);
    });

    it("cannot name the sender, the customer, the org or attach anything", async () => {
      const { id } = await start();
      for (const extra of [{ senderType: "STAFF" }, { senderId: "staff_a1" }, { customerId: "cust_a2" }, { org_id: ORG_B }, { attachments: [] }, { fileUrl: "https://x.test/a.pdf" }]) {
        expect((await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "hi", ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect((await start("cust_a1", { body: "hi", customerId: "cust_a2" })).res.statusCode).toBe(400);
      expect(rows("message").every((m) => m["senderType"] === "CUSTOMER" && m["senderId"] === "cust_a1")).toBe(true);
    });
  });

  describe("rate limits and caps", () => {
    it("allows 15 messages a minute per customer, then 429 with Retry-After, for that customer only", async () => {
      const { id } = await start();
      let blocked = 0;
      for (let i = 0; i < 16; i += 1) {
        const res = await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: `m${i}` });
        if (res.statusCode === 429) {
          blocked += 1;
          expect(res.headers["retry-after"]).toBe("60");
        }
      }
      expect(blocked).toBeGreaterThan(0);
      const other = await start("cust_a2", { body: "still fine" });
      expect(other.res.statusCode).toBe(201);
    });

    it("allows 10 new conversations an hour per customer", async () => {
      const codes: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        identifierLimiter.hit("never", "x", { max: 1, windowMs: 1 }); // keep the helper honest, no effect
        codes.push((await start("cust_a1", { body: `c${i}` })).res.statusCode);
      }
      expect(codes.filter((c) => c === 201).length).toBeLessThanOrEqual(10);
      expect(codes).toContain(429);
    });

    it("refuses more than the maximum number of conversations", async () => {
      for (let i = 0; i < MAX_CONVERSATIONS_PER_CUSTOMER; i += 1) {
        fake.seed("conversation", { id: `c${i}`, org_id: ORG_A, customerId: "cust_a1", vehicleId: null, lastMessageAt: new Date(), handledAt: null, handledById: null, createdAt: new Date() });
      }
      const { res } = await start("cust_a1");
      expect(res.statusCode).toBe(409);
      expect(rows("message")).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("who is told, and how", () => {
  const messageEvents = (events: AppEvent[]) => events.filter((e) => e.type === "message");

  describe("a customer message alerts the assigned agent, else administrators and managers", () => {
    const everyone = ["staff_a1", "staff_mgr2", "staff_admin", "staff_agent", "staff_op", "staff_viewer", "staff_off", "cust_a1", "cust_a2"];
    beforeEach(() => {
      fake.seed(
        "user",
        { id: "staff_agent", org_id: ORG_A, userType: "STAFF", role: "OPERATOR", loginEnabled: true, name: "Agent" },
        { id: "staff_viewer", org_id: ORG_A, userType: "STAFF", role: "VIEWER", loginEnabled: true, name: "Viewer" },
        { id: "staff_admin", org_id: ORG_A, userType: "STAFF", role: "ADMINISTRATOR", loginEnabled: true, name: "Admin" },
        { id: "staff_off", org_id: ORG_A, userType: "STAFF", role: "OPERATOR", loginEnabled: false, name: "Disabled Operator" }
      );
    });
    const told = async (assigned: string | null) => {
      Object.assign(row("user", "cust_a1"), { assignedAgentId: assigned });
      const seen = listen(everyone);
      const seenB = listen(["staff_b1"], ORG_B);
      await start();
      await settle();
      const live = everyone.filter((who) => messageEvents(seen.get(who)!).length > 0).sort();
      const alerted = rows("notification").filter((n) => n["event"] === "CHAT_MESSAGE").map((n) => n["userId"] as string).sort();
      expect(messageEvents(seenB.get("staff_b1")!)).toHaveLength(0);
      expect(live, "live events and alerts go to the same people").toEqual(alerted);
      expect(push.send.mock.calls.flat().join(" ")).not.toMatch(/Hello, where is my car/);
      return alerted;
    };

    it("with an assigned operator: only that operator, nobody else", async () => {
      expect(await told("staff_agent")).toEqual(["staff_agent"]);
    });
    it("with an assigned manager: that manager only", async () => {
      expect(await told("staff_mgr2")).toEqual(["staff_mgr2"]);
    });
    it("with no assigned agent: the active administrators and managers, never operators or viewers", async () => {
      expect(await told(null)).toEqual(["staff_a1", "staff_admin", "staff_mgr2"]);
    });
    it("when the assigned agent cannot open chat (a viewer) or is deactivated: administrators and managers instead", async () => {
      expect(await told("staff_viewer")).toEqual(["staff_a1", "staff_admin", "staff_mgr2"]);
      rows("notification").length = 0;
      expect(await told("staff_off")).toEqual(["staff_a1", "staff_admin", "staff_mgr2"]);
    });
    it("an agent from another org (bad data) is ignored, never alerted", async () => {
      expect(await told("staff_b1")).toEqual(["staff_a1", "staff_admin", "staff_mgr2"]);
    });
  });

  it("the text of a message is in no alert, push, email or stream event", async () => {
    fake.seed("user", { id: "staff_agent", org_id: ORG_A, userType: "STAFF", role: "OPERATOR", loginEnabled: true, name: "Agent" });
    Object.assign(row("user", "cust_a1"), { assignedAgentId: "staff_agent" });
    const seen = listen(["staff_agent"]);
    await start("cust_a1", { body: "ZEBRA-PRIVATE-TEXT-4711" });
    await settle();
    expect(JSON.stringify([rows("notification"), state.emails, push.send.mock.calls, seen.get("staff_agent")])).not.toContain("ZEBRA-PRIVATE-TEXT-4711");
  });

  it("a staff reply goes live to that customer only", async () => {
    const { id } = await start();
    const seen = listen(["staff_a1", "staff_mgr2", "cust_a1", "cust_a2"]);
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "On its way" });
    await new Promise((r) => setTimeout(r, 10));
    expect(messageEvents(seen.get("cust_a1")!)).toHaveLength(1);
    expect(messageEvents(seen.get("cust_a1")!)[0]!.payload).toMatchObject({ senderType: "STAFF", conversationId: id });
    for (const who of ["staff_a1", "staff_mgr2", "cust_a2"]) expect(messageEvents(seen.get(who)!), who).toHaveLength(0);
  });

  it("the alert for staff names the customer, not the message; the alert for the customer never has the text either", async () => {
    const { id } = await start("cust_a1", { body: "My secret account number is 12345678" });
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "Please pay to the confidential account 99887766" });
    await settle();
    const alerts = rows("notification").filter((n) => n["event"] === "CHAT_MESSAGE");
    expect(alerts.map((n) => n["userId"]).sort()).toEqual(["cust_a1", "staff_a1", "staff_mgr2"]);
    const toStaff = alerts.find((n) => n["userId"] === "staff_a1")!;
    expect(toStaff).toMatchObject({ title: "New message from Customer cust_a1", org_id: ORG_A });
    const everything = JSON.stringify([alerts, state.emails, push.send.mock.calls]);
    expect(everything).not.toMatch(/12345678|99887766|secret account|confidential/);
    expect(state.emails.map((e) => e.to)).toEqual(["a1@example.test"]);
  });

  it("a burst is one alert: later messages in the same minute add none, a change of sender or a pause does", async () => {
    const { id } = await start();
    const alertsFor = (who: string) => rows("notification").filter((n) => n["event"] === "CHAT_MESSAGE" && n["userId"] === who).length;
    await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "two" });
    await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "three" });
    expect(alertsFor("staff_a1")).toBe(1);

    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "answer" });
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "answer 2" });
    expect(alertsFor("cust_a1")).toBe(1);

    await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "again" });
    expect(alertsFor("staff_a1")).toBe(2); // the sender changed

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
      await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "much later" });
      expect(alertsFor("staff_a1")).toBe(3); // a pause of more than 5 minutes
    } finally {
      vi.useRealTimers();
    }
  });

  it("a customer who switched chat alerts off still sees the live message but gets no alert, push or email", async () => {
    const { id } = await start();
    fake.seed("notificationPreference", { id: "p1", org_id: ORG_A, userId: "cust_a1", events: { CHAT_MESSAGE: false }, departureLeadDays: 7, pushEnabled: true, emailEnabled: true, whatsappEnabled: false });
    const seen = listen(["cust_a1"]);
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "hello" });
    await settle();
    expect(messageEvents(seen.get("cust_a1")!)).toHaveLength(1);
    expect(rows("notification").filter((n) => n["userId"] === "cust_a1")).toHaveLength(0);
    expect(state.emails).toHaveLength(0);
  });

  it("every action writes an ActivityLog row without the text", async () => {
    const { id } = await start();
    await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "private words" });
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "other private words" });
    await staff("POST", `/chat/conversations/${id}/handled`, "MANAGER", { handled: true });
    expect(logs("START_CONVERSATION")).toHaveLength(1);
    expect(logs("SEND_CHAT_MESSAGE")).toHaveLength(1);
    expect(logs("REPLY_CHAT_MESSAGE")).toMatchObject([{ actorId: "staff_a1", entityId: id, org_id: ORG_A }]);
    expect(logs("MARK_CONVERSATION_HANDLED")).toHaveLength(1);
    expect(JSON.stringify(rows("activityLog"))).not.toMatch(/private words/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("operators reach only the conversations of customers assigned to them", () => {
  const op = (method: "GET" | "POST", url: string, body?: unknown, sub = "staff_op") => staff(method, url, "OPERATOR", body, ORG_A, sub);
  let c1: string; // cust_a1, assigned to staff_op
  let c2: string; // cust_a2, assigned to staff_op2
  let c3: string; // cust_a3, assigned to nobody

  beforeEach(async () => {
    fake.seed(
      "user",
      { id: "staff_op2", org_id: ORG_A, userType: "STAFF", role: "OPERATOR", loginEnabled: true, name: "Second Operator" },
      { id: "staff_viewer", org_id: ORG_A, userType: "STAFF", role: "VIEWER", loginEnabled: true, name: "Viewer" }
    );
    Object.assign(row("user", "cust_a1"), { assignedAgentId: "staff_op" });
    Object.assign(row("user", "cust_a2"), { assignedAgentId: "staff_op2" });
    fake.seed("user", { ...row("user", "cust_a2"), id: "cust_a3", email: "a3@example.test", name: "Customer cust_a3", assignedAgentId: null });
    c1 = (await start("cust_a1", { body: "From one" })).id;
    c2 = (await start("cust_a2", { body: "From two" })).id;
    c3 = (await start("cust_a3", { body: "From three" })).id;
  });

  it("the inbox lists only the operator's own customers; administrators and managers list everything", async () => {
    expect((await op("GET", "/chat/conversations?status=all")).json().data.rows.map((r: { id: string }) => r.id)).toEqual([c1]);
    expect((await op("GET", "/chat/conversations?status=all", undefined, "staff_op2")).json().data.rows.map((r: { id: string }) => r.id)).toEqual([c2]);
    expect((await staff("GET", "/chat/conversations?status=all", "MANAGER")).json().data.total).toBe(3);
    expect((await staff("GET", "/chat/conversations?status=all", "ADMINISTRATOR")).json().data.total).toBe(3);
    expect((await op("GET", "/chat/conversations?status=all")).json().data.total).toBe(1);
  });

  it("an assigned operator can read, reply and mark handled", async () => {
    expect((await op("GET", `/chat/conversations/${c1}/messages`)).statusCode).toBe(200);
    const reply = await op("POST", `/chat/conversations/${c1}/messages`, { body: "On it" });
    expect(reply.statusCode).toBe(201);
    expect(rows("message").at(-1)).toMatchObject({ senderType: "STAFF", senderId: "staff_op", org_id: ORG_A });
    expect((await op("POST", `/chat/conversations/${c1}/handled`, { handled: true })).statusCode).toBe(200);
    expect(logs("REPLY_CHAT_MESSAGE")).toMatchObject([{ actorId: "staff_op" }]);
    expect(logs("MARK_CONVERSATION_HANDLED")).toMatchObject([{ actorId: "staff_op" }]);
  });

  it("another agent's customer and an unassigned customer are 404 (not 403) for read, reply and handled, and change nothing", async () => {
    const before = JSON.stringify([rows("message"), rows("conversation"), rows("activityLog")]);
    for (const id of [c2, c3]) {
      for (const [method, path, body] of [
        ["GET", `/chat/conversations/${id}/messages`],
        ["POST", `/chat/conversations/${id}/messages`, { body: "intruder" }],
        ["POST", `/chat/conversations/${id}/handled`, { handled: true }],
      ] as [("GET" | "POST"), string, unknown?][]) {
        const res = await op(method, path, body);
        expect([res.statusCode, res.json().error.code], `${method} ${path}`).toEqual([404, "NOT_FOUND"]);
        expect(res.json().error.message).toBe("Conversation not found.");
      }
    }
    expect(JSON.stringify([rows("message"), rows("conversation"), rows("activityLog")])).toBe(before);
  });

  it("an id that does not exist and one that belongs to another org look exactly the same", async () => {
    const other = await start("cust_b1", { body: "Org B" }, ORG_B);
    const unknown = await op("GET", "/chat/conversations/nope/messages");
    const foreign = await op("GET", `/chat/conversations/${other.id}/messages`);
    expect([unknown.statusCode, foreign.statusCode]).toEqual([404, 404]);
    expect(foreign.json()).toEqual(unknown.json());
    expect((await staff("GET", `/chat/conversations/${other.id}/messages`, "MANAGER")).statusCode).toBe(404);
  });

  it("an operator of another org who is 'assigned' to an org A customer by bad data still gets nothing", async () => {
    Object.assign(row("user", "staff_b1"), { role: "OPERATOR" });
    Object.assign(row("user", "cust_a3"), { assignedAgentId: "staff_b1" });
    expect((await staff("GET", `/chat/conversations/${c3}/messages`, "OPERATOR", undefined, ORG_B, "staff_b1")).statusCode).toBe(404);
  });

  it("a viewer is refused (403) on every chat route", async () => {
    for (const [method, path, body] of [
      ["GET", "/chat/conversations"],
      ["GET", `/chat/conversations/${c1}/messages`],
      ["POST", `/chat/conversations/${c1}/messages`, { body: "x" }],
      ["POST", `/chat/conversations/${c1}/handled`, { handled: true }],
    ] as [("GET" | "POST"), string, unknown?][]) {
      expect((await staff(method, path, "VIEWER", body, ORG_A, "staff_viewer")).statusCode, path).toBe(403);
    }
  });

  it("the assignment is read from the database on every request: reassigning removes the old agent's access at once", async () => {
    expect((await op("GET", `/chat/conversations/${c1}/messages`)).statusCode).toBe(200);
    expect((await op("GET", `/chat/conversations/${c1}/messages`, undefined, "staff_op2")).statusCode).toBe(404);

    const moved = await app.inject({ method: "PATCH", url: "/api/v1/customers/cust_a1/agent", headers: await staffHeaders("MANAGER"), payload: { agentId: "staff_op2" } });
    expect(moved.statusCode).toBe(200);

    expect((await op("GET", `/chat/conversations/${c1}/messages`)).statusCode).toBe(404);
    expect((await op("POST", `/chat/conversations/${c1}/messages`, { body: "late" })).statusCode).toBe(404);
    expect((await op("GET", "/chat/conversations?status=all")).json().data.rows).toEqual([]);
    expect((await op("GET", `/chat/conversations/${c1}/messages`, undefined, "staff_op2")).statusCode).toBe(200);
    expect((await op("POST", `/chat/conversations/${c1}/messages`, { body: "mine now" }, "staff_op2")).statusCode).toBe(201);

    // and the next customer message alerts the new agent, not the old one
    rows("notification").length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
      await as("cust_a1", "POST", `/conversations/${c1}/messages`, { body: "after the move" });
    } finally {
      vi.useRealTimers();
    }
    expect(rows("notification").filter((n) => n["event"] === "CHAT_MESSAGE").map((n) => n["userId"])).toEqual(["staff_op2"]);
  });

  it("clearing the assignment also removes the operator's access", async () => {
    await app.inject({ method: "PATCH", url: "/api/v1/customers/cust_a1/agent", headers: await staffHeaders("MANAGER"), payload: { agentId: null } });
    expect((await op("GET", `/chat/conversations/${c1}/messages`)).statusCode).toBe(404);
  });

  it("a deactivated agent has no access, even with a token that is still valid", async () => {
    Object.assign(row("user", "staff_op"), { loginEnabled: false });
    for (const [method, path, body] of [
      ["GET", "/chat/conversations"],
      ["GET", `/chat/conversations/${c1}/messages`],
      ["POST", `/chat/conversations/${c1}/messages`, { body: "x" }],
      ["POST", `/chat/conversations/${c1}/handled`, { handled: true }],
    ] as [("GET" | "POST"), string, unknown?][]) {
      expect((await op(method, path, body)).statusCode, path).toBe(403);
    }
    // and a deactivated manager too
    Object.assign(row("user", "staff_a1"), { loginEnabled: false });
    expect((await staff("GET", "/chat/conversations", "MANAGER")).statusCode).toBe(403);
  });

  it("the CURRENT role decides, not the token's: a token that says MANAGER for a user who is now a viewer is refused", async () => {
    expect((await staff("GET", "/chat/conversations", "MANAGER", undefined, ORG_A, "staff_viewer")).statusCode).toBe(403);
    // and an operator whose token still says MANAGER does not get the whole inbox
    expect((await staff("GET", "/chat/conversations?status=all", "MANAGER", undefined, ORG_A, "staff_op")).json().data.rows.map((r: { id: string }) => r.id)).toEqual([c1]);
  });

  it("link requests are still decided by administrators and managers only", async () => {
    fake.seed("vehicleLinkRequest", { id: "lr_op", org_id: ORG_A, customerId: "cust_a1", serialEntered: "FC999", status: "PENDING", createdAt: new Date(), vehicleId: null, decidedById: null, decidedAt: null });
    expect((await staff("POST", "/link-requests/lr_op/reject", "OPERATOR", { reason: "no" }, ORG_A, "staff_op")).statusCode).toBe(403);
    expect((await staff("POST", "/link-requests/lr_op/approve", "OPERATOR", {}, ORG_A, "staff_op")).statusCode).toBe(403);
  });
});

describe("the staff inbox", () => {
  it("lists open conversations newest activity first, with the customer, vehicle and last message", async () => {
    const first = await start("cust_a1", { vehicleId: "cv1", body: "About the car" });
    await new Promise((r) => setTimeout(r, 5));
    await start("cust_a2", { body: "Another customer" });
    const data = (await staff("GET", "/chat/conversations", "MANAGER")).json().data;
    expect(data.total).toBe(2);
    expect(data.rows.map((r: { customer: { id: string } }) => r.customer.id)).toEqual(["cust_a2", "cust_a1"]);
    expect(data.rows[1]).toMatchObject({ id: first.id, vehicle: { id: "cv1", serial: "FC801" }, handled: false, lastMessage: { senderType: "CUSTOMER", snippet: "About the car" } });
    expect(Object.keys(data.rows[0]).sort()).toEqual(["customer", "handled", "id", "lastMessage", "lastMessageAt", "vehicle"]);
  });

  it("only this org's conversations: another org's are invisible and unreachable", async () => {
    await start("cust_a1");
    const b = await start("cust_b1", { body: "Org B talking" }, ORG_B);
    expect((await staff("GET", "/chat/conversations", "MANAGER")).json().data.total).toBe(1);
    expect((await staff("GET", "/chat/conversations", "MANAGER", undefined, ORG_B)).json().data.total).toBe(1);
    expect((await staff("GET", `/chat/conversations/${b.id}/messages`, "MANAGER")).statusCode).toBe(404);
    expect((await staff("POST", `/chat/conversations/${b.id}/messages`, "MANAGER", { body: "x" })).statusCode).toBe(404);
    expect((await staff("POST", `/chat/conversations/${b.id}/handled`, "MANAGER", { handled: true })).statusCode).toBe(404);
    expect(rows("message").filter((m) => m["conversationId"] === b.id)).toHaveLength(1);
  });

  it("filters by status, pages, and is strict about parameters", async () => {
    const a = await start("cust_a1");
    await start("cust_a2", { body: "Two" });
    await staff("POST", `/chat/conversations/${a.id}/handled`, "MANAGER", { handled: true });
    const ids = async (q: string) => (await staff("GET", `/chat/conversations?${q}`, "MANAGER")).json().data.rows.map((r: { id: string }) => r.id);
    expect(await ids("status=handled")).toEqual([a.id]);
    expect((await ids("status=open")).includes(a.id)).toBe(false);
    expect(await ids("status=all")).toHaveLength(2);
    expect(await ids("pageSize=1&status=all")).toHaveLength(1);
    for (const q of ["status=nope", "pageSize=51", "page=0", "customerId=cust_a1", "orgId=x"]) expect((await staff("GET", `/chat/conversations?${q}`, "MANAGER")).statusCode, q).toBe(400);
  });

  it("shows messages with the staff member's name on staff messages only", async () => {
    const { id } = await start();
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "Hello from staff" });
    const data = (await staff("GET", `/chat/conversations/${id}/messages`, "ADMINISTRATOR")).json().data;
    expect(data.conversation).toMatchObject({ id, customer: { id: "cust_a1" }, handled: false });
    expect(data.rows.map((m: { senderType: string; senderName: string | null }) => [m.senderType, m.senderName])).toEqual([["STAFF", "Staff A"], ["CUSTOMER", null]]);
  });

  it("replying stores a STAFF message from the token's own user, and a bad body changes nothing", async () => {
    const { id } = await start();
    const res = await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "  Thanks, checking  " });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ senderType: "STAFF", body: "Thanks, checking" });
    expect(rows("message").at(-1)).toMatchObject({ senderType: "STAFF", senderId: "staff_a1", org_id: ORG_A });
    for (const bad of [{}, { body: "" }, { body: "x".repeat(2001) }, { body: "hi", senderId: "staff_mgr2" }, { body: "hi", senderType: "CUSTOMER" }]) {
      expect((await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(rows("message")).toHaveLength(2);
  });

  it("marking handled and reopening are logged, and a new customer message reopens a handled conversation", async () => {
    const { id } = await start();
    expect((await staff("POST", `/chat/conversations/${id}/handled`, "MANAGER", { handled: true })).json()).toEqual({ data: { id, handled: true } });
    expect(row("conversation", id)).toMatchObject({ handledById: "staff_a1" });
    expect(row("conversation", id)["handledAt"]).toBeInstanceOf(Date);

    await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "one more thing" });
    expect(row("conversation", id)["handledAt"] ?? null).toBeNull();

    await staff("POST", `/chat/conversations/${id}/handled`, "MANAGER", { handled: true });
    await staff("POST", `/chat/conversations/${id}/handled`, "MANAGER", { handled: false });
    expect(logs("MARK_CONVERSATION_HANDLED")).toHaveLength(2);
    expect(logs("REOPEN_CONVERSATION")).toHaveLength(1);
    for (const bad of [{}, { handled: "yes" }, { handled: true, extra: 1 }]) expect((await staff("POST", `/chat/conversations/${id}/handled`, "MANAGER", bad)).statusCode).toBe(400);
  });

  it("a staff reply to a customer who deleted their account is a 404", async () => {
    const { id } = await start();
    Object.assign(row("user", "cust_a1"), { deletedAt: new Date() });
    expect((await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "hello?" })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------

describe("a rejection reason reaches the customer as a staff chat message", () => {
  beforeEach(() => {
    fake.seed("vehicleLinkRequest", { id: "lr1", org_id: ORG_A, customerId: "cust_a1", serialEntered: "FC999", status: "PENDING", createdAt: new Date(), vehicleId: null, decidedById: null, decidedAt: null });
  });
  const reject = (body: unknown) => staff("POST", "/link-requests/lr1/reject", "MANAGER", body);

  it("with a reason: rejected, one generic alert, and the reason in a conversation the customer can read", async () => {
    const res = await reject({ reason: "That serial number belongs to a different company." });
    expect(res.statusCode).toBe(200);
    expect(row("vehicleLinkRequest", "lr1")["status"]).toBe("REJECTED");
    const messages = rows("message");
    expect(messages).toMatchObject([{ senderType: "STAFF", senderId: "staff_a1", body: "About your request to link FC999: That serial number belongs to a different company." }]);

    const conversationId = messages[0]!["conversationId"] as string;
    const read = (await as("cust_a1", "GET", `/conversations/${conversationId}/messages`)).json().data;
    expect(read.rows[0].body).toContain("different company");
    expect((await as("cust_a2", "GET", `/conversations/${conversationId}/messages`)).statusCode).toBe(404);

    // the standing notification stays generic
    const alerts = rows("notification").filter((n) => n["userId"] === "cust_a1");
    expect(alerts.map((n) => n["event"]).sort()).toEqual(["CHAT_MESSAGE", "LINK_REQUEST_REJECTED"]);
    expect(alerts.find((n) => n["event"] === "LINK_REQUEST_REJECTED")!["body"]).toBe("Your request to link FC999 could not be approved.");
    expect(JSON.stringify(rows("activityLog"))).not.toContain("different company");
    expect(logs("REJECT_LINK_REQUEST")[0]!["after"]).toMatchObject({ status: "REJECTED", reasonGiven: true });
  });

  it("reuses the customer's general conversation instead of opening a new one each time", async () => {
    await start("cust_a1");
    await reject({ reason: "Not ours." });
    expect(rows("conversation")).toHaveLength(1);
  });

  it("without a reason: nothing is said, exactly as before", async () => {
    expect((await reject({})).statusCode).toBe(200);
    expect(rows("message")).toHaveLength(0);
    expect(rows("conversation")).toHaveLength(0);
    expect(logs("REJECT_LINK_REQUEST")[0]!["after"]).toMatchObject({ reasonGiven: false });
  });

  it.each([[{ reason: "" }], [{ reason: "   " }], [{ reason: "x".repeat(501) }], [{ reason: "bad\u0000" }], [{ reason: 5 }], [{ reason: "ok", extra: 1 }]])("rejects %j and the request stays pending", async (body) => {
    expect((await reject(body)).statusCode).toBe(400);
    expect(row("vehicleLinkRequest", "lr1")["status"]).toBe("PENDING");
    expect(rows("message")).toHaveLength(0);
  });

  it("a request already decided stays a conflict and says nothing", async () => {
    await reject({});
    expect((await reject({ reason: "late" })).statusCode).toBe(409);
    expect(rows("message")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("deleting an account removes the conversations", () => {
  it("chat, alerts and settings go with the account; other customers' stay", async () => {
    const mine = await start("cust_a1");
    await start("cust_a2", { body: "Not mine" });
    await staff("POST", `/chat/conversations/${mine.id}/messages`, "MANAGER", { body: "Reply" });
    fake.seed("notificationPreference", { id: "p1", org_id: ORG_A, userId: "cust_a1", events: {}, departureLeadDays: 7, pushEnabled: true, emailEnabled: true, whatsappEnabled: false });
    await deleteCustomerAccount({ id: "cust_a1", orgId: ORG_A }, { password: CUSTOMER_PASSWORD });
    expect(rows("conversation").map((c) => c["customerId"])).toEqual(["cust_a2"]);
    expect(rows("message").map((m) => m["senderId"])).toEqual(["cust_a2"]);
    expect(rows("notification").filter((n) => n["userId"] === "cust_a1")).toHaveLength(0);
    expect(rows("notificationPreference")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the stream only forwards whitelisted fields of a chat event", () => {
  it("an event that carries extra data (text, sender id, anything) leaves the server with ids only", async () => {
    const { SseHub } = await import("../src/lib/sse-hub.js");
    const hubBus = new InMemoryEventBus();
    const hub = new SseHub({ maxConnections: 10, bus: () => hubBus });
    const written: string[] = [];
    hub.open({ userId: "cust_a1", orgId: ORG_A, expiresAt: Date.now() + 60_000, sink: { write: (chunk: string) => (written.push(chunk), true), end: () => undefined, writableLength: 0 } });
    hubBus.publish({
      type: "message",
      orgId: ORG_A,
      userId: "cust_a1",
      id: "e1",
      payload: { conversationId: "c1", messageId: "m1", senderType: "STAFF", createdAt: "2026-10-27T10:00:00.000Z", body: "LEAKED TEXT", senderId: "staff_a1", customerEmail: "a1@example.test" },
    });
    await new Promise((r) => setTimeout(r, 10));
    const text = written.join("");
    expect(text).toContain("event: message");
    expect(text).toContain('"conversationId":"c1"');
    expect(text).not.toMatch(/LEAKED TEXT|staff_a1|a1@example/);
    hub.closeAll();
  });
});

describe("the live stream", () => {
  it("a chat message arrives on the other party's stream as ids only, and never on anyone else's", async () => {
    await app.close();
    app = await buildApp({ rateLimit: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;

    const controllers: AbortController[] = [];
    const open = async (path: string, token: string) => {
      const controller = new AbortController();
      controllers.push(controller);
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
      let buffer = "";
      const reader = res.body!.getReader();
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
        }
      })();
      return { status: res.status, text: () => buffer };
    };
    try {
      const customerToken = (await bearerFor("cust_a1")).authorization!.slice(7);
      const otherToken = (await bearerFor("cust_a2")).authorization!.slice(7);
      const staffToken = (await staffHeaders("MANAGER")).authorization.slice(7);
      const mine = await open("/api/customer/v1/stream", customerToken);
      const other = await open("/api/customer/v1/stream", otherToken);
      const staffStream = await open("/api/v1/notifications/stream", staffToken);

      const { id } = await start();
      await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "Visible only in the app" });
      await new Promise((r) => setTimeout(r, 200));

      expect(mine.text()).toContain("event: message");
      expect(mine.text()).toContain(id);
      expect(staffStream.text()).toContain("event: message");
      expect(other.text()).not.toContain("event: message");
      for (const stream of [mine, staffStream, other]) expect(stream.text()).not.toMatch(/Visible only in the app|Hello, where is my car/);
    } finally {
      for (const controller of controllers) controller.abort();
    }
  });
});
