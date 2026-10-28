import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as ReturnType<typeof createFakePrisma>).client,
}));

import { buildApp } from "../src/app.js";
import { InMemoryEventBus, getEventBus, setEventBus, type EventBus } from "../src/lib/events.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";

let app: FastifyInstance;
let base: string;
let bus: InMemoryEventBus;
let previousBus: EventBus;
const openStreams: Array<{ abort: () => void }> = [];

beforeEach(async () => {
  state.fake = createFakePrisma();
  previousBus = getEventBus();
  bus = new InMemoryEventBus();
  setEventBus(bus);
});

afterEach(async () => {
  for (const s of openStreams.splice(0)) s.abort();
  await app?.close();
  setEventBus(previousBus);
});

async function start(options: Parameters<typeof buildApp>[0] = {}) {
  app = await buildApp({ rateLimit: false, ...options });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
}

const token = (userId: string, orgId = ORG_A, role: Role = "VIEWER") =>
  signAccessToken({ sub: userId, orgId, role, name: `Test ${userId}`, email: null });

/** A token that really expires `seconds` from now (signAccessToken is fixed at 20 minutes). */
const shortLivedToken = (userId: string, seconds: number, orgId = ORG_A) =>
  new SignJWT({ orgId, role: "VIEWER", name: "Short", email: null })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("cargodev-api")
    .setAudience("staff")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
    .sign(new TextEncoder().encode(process.env["MOBILE_JWT_SECRET"]));

interface Stream {
  status: number;
  headers: Headers;
  text: () => string;
  ended: () => boolean;
  abort: () => void;
  waitFor: (needle: string, ms?: number) => Promise<void>;
}

async function openStream(accessToken: string | null, path = "/api/v1/notifications/stream"): Promise<Stream> {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    signal: controller.signal,
  });
  let buffer = "";
  let done = false;
  const stream: Stream = {
    status: res.status,
    headers: res.headers,
    text: () => buffer,
    ended: () => done,
    abort: () => controller.abort(),
    waitFor: async (needle, ms = 3000) => {
      const deadline = Date.now() + ms;
      while (!buffer.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(buffer)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
  openStreams.push(stream);
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
  return stream;
}

const publishFor = (userId: string, orgId: string, id: string, title = "Hello") =>
  bus.publish({
    type: "notification",
    orgId,
    userId,
    id,
    payload: { id, event: "SHIPPED", title, body: "b", vehicleId: null, createdAt: new Date().toISOString() },
  });

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe("GET /notifications/stream: auth", () => {
  beforeEach(() => start());

  it("returns 401 without a token", async () => {
    const res = await openStream(null);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.text())).toEqual({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } });
    expect(app.sseHub.size).toBe(0);
  });

  it("returns 401 for a forged token", async () => {
    const res = await openStream("not.a.token");
    expect(res.status).toBe(401);
  });

  it("never accepts a token in the query string", async () => {
    const t = await token("user_1");
    const res = await fetch(`${base}/api/v1/notifications/stream?access_token=${t}&token=${t}`);
    expect(res.status).toBe(401);
    await res.text();
    expect(app.sseHub.size).toBe(0);
  });

  it.each(["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"] as Role[])("allows %s", async (role) => {
    const res = await openStream(await token("user_1", ORG_A, role));
    expect(res.status).toBe(200);
  });
});

describe("GET /notifications/stream: stream behaviour", () => {
  beforeEach(() => start());

  it("sends the required headers", async () => {
    const res = await openStream(await token("user_1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    // Headers set before the stream was taken over (security headers) still arrive.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("announces itself and a reconnect delay", async () => {
    const res = await openStream(await token("user_1"));
    await res.waitFor(": connected");
    expect(res.text()).toContain("retry: 5000");
  });

  it("delivers the user's own events in SSE format", async () => {
    const res = await openStream(await token("user_1"));
    await res.waitFor(": connected");
    publishFor("user_1", ORG_A, "evt_1", "Vehicle shipped");
    await res.waitFor("event: notification");
    expect(res.text()).toContain("id: evt_1\nevent: notification\n");
    const data = JSON.parse(res.text().split("data: ")[1]!.split("\n")[0]!);
    expect(data).toMatchObject({ id: "evt_1", title: "Vehicle shipped", event: "SHIPPED" });
  });

  it("a stream only receives its own user's events", async () => {
    const one = await openStream(await token("user_1"));
    const two = await openStream(await token("user_2"));
    await one.waitFor(": connected");
    await two.waitFor(": connected");
    publishFor("user_1", ORG_A, "for_user_1");
    await one.waitFor("for_user_1");
    await settle();
    expect(two.text()).not.toContain("for_user_1");
  });

  it("two users in two orgs never see each other's events, even with the same user id", async () => {
    const inA = await openStream(await token("user_1", ORG_A));
    const inB = await openStream(await token("user_1", ORG_B));
    await inA.waitFor(": connected");
    await inB.waitFor(": connected");
    publishFor("user_1", ORG_A, "only_for_org_a");
    publishFor("user_1", ORG_B, "only_for_org_b");
    await inA.waitFor("only_for_org_a");
    await inB.waitFor("only_for_org_b");
    await settle();
    expect(inA.text()).not.toContain("only_for_org_b");
    expect(inB.text()).not.toContain("only_for_org_a");
  });
});

describe("GET /notifications/stream: lifecycle", () => {
  it("closes after the access token expires, with event: reauth", async () => {
    await start();
    // Mint and connect under a frozen clock (at an exact second), so a slow machine cannot let the 1 second token expire
    // before the request reaches the guard. The stream's expiry timer is measured from that same instant.
    vi.useFakeTimers({ toFake: ["Date"] });
    let res: Awaited<ReturnType<typeof openStream>>;
    try {
      vi.setSystemTime(new Date(Math.floor(Date.now() / 1000) * 1000));
      res = await openStream(await shortLivedToken("user_1", 1));
    } finally {
      vi.useRealTimers();
    }
    expect(res.status).toBe(200);
    await res.waitFor("event: reauth", 4000);
    expect(res.text()).toContain('"reason":"token_expired"');
    await vi.waitFor(() => expect(res.ended()).toBe(true), { timeout: 2000 });
    expect(app.sseHub.size).toBe(0);
  });

  it("a user's 4th concurrent stream evicts the oldest", async () => {
    await start();
    const t = await token("user_1");
    const first = await openStream(t);
    await first.waitFor(": connected");
    const second = await openStream(t);
    const third = await openStream(t);
    expect(app.sseHub.size).toBe(3);
    const fourth = await openStream(t);
    await first.waitFor("event: closed");
    expect(first.text()).toContain('"reason":"replaced"');
    await vi.waitFor(() => expect(first.ended()).toBe(true), { timeout: 2000 });
    expect(app.sseHub.size).toBe(3);
    for (const live of [second, third, fourth]) expect(live.ended()).toBe(false);
  });

  it("cleans up when the client disconnects: no connection or subscription is left", async () => {
    await start();
    const res = await openStream(await token("user_1"));
    await res.waitFor(": connected");
    expect(app.sseHub.size).toBe(1);
    expect(bus.subscriberCount()).toBe(1);
    res.abort();
    await vi.waitFor(() => expect(app.sseHub.size).toBe(0), { timeout: 2000 });
    expect(bus.subscriberCount()).toBe(0);
  });

  it("rejects new streams with 429 once the instance-wide cap is reached", async () => {
    process.env["SSE_MAX_CONNECTIONS"] = "2";
    vi.resetModules();
    try {
      const { buildApp: buildCapped } = await import("../src/app.js");
      app = await buildCapped({ rateLimit: false });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      base = `http://127.0.0.1:${address.port}`;
    } finally {
      delete process.env["SSE_MAX_CONNECTIONS"];
    }
    // vi.resetModules gave this app its own bus module instance; use the hub's own bus accessor.
    const a = await openStream(await token("user_1"));
    const b = await openStream(await token("user_2"));
    expect([a.status, b.status]).toEqual([200, 200]);
    const c = await openStream(await token("user_3"));
    expect(c.status).toBe(429);
    expect(c.headers.get("retry-after")).toBe("30");
    expect(JSON.parse(c.text()).error.code).toBe("RATE_LIMITED");
  });

  it("on shutdown every stream gets event: shutdown and app.close() completes", async () => {
    await start();
    const a = await openStream(await token("user_1"));
    const b = await openStream(await token("user_2"));
    await a.waitFor(": connected");
    await b.waitFor(": connected");
    await app.close();
    await a.waitFor("event: shutdown");
    await b.waitFor("event: shutdown");
    await vi.waitFor(() => expect(a.ended() && b.ended()).toBe(true), { timeout: 2000 });
    // afterEach closes again; closing twice must be harmless.
  });
});

describe("a published event reaches the stream from the notification service path", () => {
  it("rejects a hand-built event of an unknown type instead of forwarding it", async () => {
    await start();
    const res = await openStream(await token("user_1"));
    await res.waitFor(": connected");
    bus.publish({ type: "secret.internal", orgId: ORG_A, userId: "user_1", id: "x", payload: { password: "nope" } });
    await settle();
    expect(res.text()).not.toContain("secret.internal");
    expect(res.text()).not.toContain("password");
  });
});
