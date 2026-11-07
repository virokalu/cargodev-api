// Chat unread counts and mark-read (one read marker per side). Fake data only.

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { bearerFor, newCustomerFake, request } from "./helpers/customer-fixtures.js";
import { newVehicleFake } from "./helpers/vehicle-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { buildApp } from "../src/app.js";
import { drainEmailQueue } from "../src/lib/email-queue.js";
import { InMemoryEventBus, getEventBus, setEventBus, type EventBus } from "../src/lib/events.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";

let app: FastifyInstance;
let fake: FakePrisma;
let previousBus: EventBus;
const rows = (model: string) => fake.rows(model);
const row = (model: string, id: string) => rows(model).find((r) => r["id"] === id)!;
const logs = (action: string) => rows("activityLog").filter((l) => l["action"] === action);

const staff = async (method: "GET" | "POST", url: string, role: Role, body?: unknown, orgId = ORG_A, sub = orgId === ORG_B ? "staff_b1" : "staff_a1") =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${await signAccessToken({ sub, orgId, role, name: `Test ${role}`, email: null })}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const as = async (id: string, method: "GET" | "POST", path: string, body?: unknown, orgId = ORG_A) => request(app, method, path, await bearerFor(id, orgId), body);
const start = async (id = "cust_a1", body: Record<string, unknown> = { body: "Hello" }) => (await as(id, "POST", "/conversations", body)).json().data.conversation.id as string;

type Unread = { id: string; unreadCount: number };
const inbox = async () => (await staff("GET", "/chat/conversations?status=all", "MANAGER")).json().data.rows as Unread[];
const mine = async (who = "cust_a1") => (await as(who, "GET", "/conversations")).json().data.rows as Unread[];
const wait = () => new Promise((r) => setTimeout(r, 5));

beforeEach(async () => {
  fake = newVehicleFake();
  for (const r of newCustomerFake().rows("user")) {
    const existing = fake.rows("user").find((u) => u["id"] === r["id"]);
    if (existing) Object.assign(existing, r);
    else fake.seed("user", r);
  }
  fake.seed(
    "user",
    { id: "staff_op", org_id: ORG_A, userType: "STAFF", role: "OPERATOR", loginEnabled: true, name: "An Operator" },
    { id: "staff_op2", org_id: ORG_A, userType: "STAFF", role: "OPERATOR", loginEnabled: true, name: "Second Operator" },
    { id: "staff_b1", org_id: ORG_B, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "Org B Manager" }
  );
  state.fake = fake;
  previousBus = getEventBus();
  setEventBus(new InMemoryEventBus());
  identifierLimiter.reset();
  resetShadowLockouts();
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await drainEmailQueue();
  await app.close();
  setEventBus(previousBus);
  vi.restoreAllMocks();
});

describe("unread counts and mark-read (one marker per side)", () => {
  it("a customer message is unread for staff, not for the customer; a staff reply is the other way round", async () => {
    const id = await start("cust_a1", { body: "one" });
    await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "two" });
    expect((await inbox()).find((r) => r.id === id)!.unreadCount).toBe(2);
    expect((await mine()).find((r) => r.id === id)!.unreadCount).toBe(0); // own messages are never unread
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "hello" });
    expect((await mine()).find((r) => r.id === id)!.unreadCount).toBe(1);
    expect((await inbox()).find((r) => r.id === id)!.unreadCount).toBe(2); // a reply does not read the customer's messages
  });

  it("staff mark-read zeroes the staff count only; later customer messages count again", async () => {
    const id = await start("cust_a1", { body: "one" });
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "reply" });
    await wait();
    const res = await staff("POST", `/chat/conversations/${id}/read`, "MANAGER");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ id, unreadCount: 0 });
    expect((await inbox()).find((r) => r.id === id)!.unreadCount).toBe(0);
    expect((await mine()).find((r) => r.id === id)!.unreadCount).toBe(1); // the customer's side is untouched
    await wait();
    await as("cust_a1", "POST", `/conversations/${id}/messages`, { body: "again" });
    expect((await inbox()).find((r) => r.id === id)!.unreadCount).toBe(1);
  });

  it("customer mark-read zeroes the customer count only", async () => {
    const id = await start("cust_a1", { body: "one" });
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "r1" });
    await staff("POST", `/chat/conversations/${id}/messages`, "MANAGER", { body: "r2" });
    expect((await mine()).find((r) => r.id === id)!.unreadCount).toBe(2);
    await wait();
    const res = await as("cust_a1", "POST", `/conversations/${id}/read`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ id, unreadCount: 0 });
    expect((await mine()).find((r) => r.id === id)!.unreadCount).toBe(0);
    expect((await inbox()).find((r) => r.id === id)!.unreadCount).toBe(1);
  });

  it("marking read twice is harmless, and the marker never moves backwards", async () => {
    const id = await start("cust_a1");
    await wait();
    await staff("POST", `/chat/conversations/${id}/read`, "MANAGER");
    const first = new Date(row("conversation", id)["staffReadAt"] as Date).getTime();
    expect((await staff("POST", `/chat/conversations/${id}/read`, "MANAGER")).statusCode).toBe(200);
    expect(new Date(row("conversation", id)["staffReadAt"] as Date).getTime()).toBeGreaterThanOrEqual(first);
    row("conversation", id)["staffReadAt"] = new Date(Date.now() + 60_000);
    await staff("POST", `/chat/conversations/${id}/read`, "MANAGER");
    expect(new Date(row("conversation", id)["staffReadAt"] as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("another customer, another org and an unknown id are the same 404, and nothing changes", async () => {
    const id = await start("cust_a1");
    const before = JSON.stringify([rows("conversation"), rows("activityLog")]);
    for (const [who, orgId] of [["cust_a2", ORG_A], ["cust_b1", ORG_B]] as const) {
      const res = await as(who, "POST", `/conversations/${id}/read`, undefined, orgId);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe("Conversation not found.");
    }
    expect((await as("cust_a1", "POST", "/conversations/nope/read")).statusCode).toBe(404);
    expect((await staff("POST", `/chat/conversations/${id}/read`, "MANAGER", undefined, ORG_B)).statusCode).toBe(404);
    expect((await staff("POST", "/chat/conversations/nope/read", "MANAGER")).statusCode).toBe(404);
    expect(JSON.stringify([rows("conversation"), rows("activityLog")])).toBe(before);
  });

  it("an operator can mark only an assigned customer's conversation read", async () => {
    Object.assign(row("user", "cust_a1"), { assignedAgentId: "staff_op" });
    const id = await start("cust_a1");
    expect((await staff("POST", `/chat/conversations/${id}/read`, "OPERATOR", undefined, ORG_A, "staff_op2")).statusCode).toBe(404);
    expect(row("conversation", id)["staffReadAt"] ?? null).toBeNull();
    expect((await staff("POST", `/chat/conversations/${id}/read`, "OPERATOR", undefined, ORG_A, "staff_op")).statusCode).toBe(200);
    expect(row("conversation", id)["staffReadAt"]).toBeTruthy();
  });

  it("a viewer is refused (403) and nothing changes", async () => {
    const id = await start("cust_a1");
    expect((await staff("POST", `/chat/conversations/${id}/read`, "VIEWER")).statusCode).toBe(403);
    expect(row("conversation", id)["staffReadAt"] ?? null).toBeNull();
  });

  it("counts stay inside their own conversation", async () => {
    const a = await start("cust_a1", { body: "a" });
    const b = await start("cust_a2", { body: "b1" });
    await as("cust_a2", "POST", `/conversations/${b}/messages`, { body: "b2" });
    const now = await inbox();
    expect(now.find((r) => r.id === a)!.unreadCount).toBe(1);
    expect(now.find((r) => r.id === b)!.unreadCount).toBe(2);
  });

  it("every mark-read writes an ActivityLog row without any text", async () => {
    const id = await start("cust_a1");
    await staff("POST", `/chat/conversations/${id}/read`, "MANAGER");
    await as("cust_a1", "POST", `/conversations/${id}/read`);
    expect(logs("MARK_CHAT_READ").map((l) => [l["actorId"], l["entityId"], l["after"]])).toEqual([
      ["staff_a1", id, { side: "staff" }],
      ["cust_a1", id, { side: "customer" }],
    ]);
  });
});
