import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryEventBus, type AppEvent } from "../src/lib/events.js";
import { SseHub, formatSseEvent, type SseSink } from "../src/lib/sse-hub.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

class FakeSink implements SseSink {
  chunks: string[] = [];
  ended = false;
  writableLength = 0;
  throwOnWrite = false;
  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error("socket destroyed");
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

const notification = (over: Partial<AppEvent> = {}): AppEvent => ({
  type: "notification",
  orgId: ORG_A,
  userId: "user_1",
  id: "evt_1",
  payload: { id: "n1", event: "SHIPPED", title: "Shipped", body: "Body", vehicleId: "veh_1", createdAt: "2026-01-01T00:00:00.000Z" },
  ...over,
});

let bus: InMemoryEventBus;
let hub: SseHub;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

const open = (userId = "user_1", orgId = ORG_A, ttlMs = 20 * 60_000) => {
  const sink = new FakeSink();
  const connection = hub.open({ userId, orgId, sink, expiresAt: Date.now() + ttlMs });
  return { sink, connection };
};
/** Let the bus's microtask delivery run (fake timers do not fake microtasks). */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  bus = new InMemoryEventBus();
  hub = new SseHub({ maxConnections: 5, bus: () => bus });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("formatSseEvent", () => {
  it("writes id, event and a single-line JSON data field", () => {
    expect(formatSseEvent({ id: "a1", event: "notification", data: { x: "line1\nline2" } })).toBe(
      'id: a1\nevent: notification\ndata: {"x":"line1\\nline2"}\n\n'
    );
  });
  it("strips line breaks from id and event so a value cannot inject extra fields", () => {
    const text = formatSseEvent({ id: "a\nevent: evil", event: "ok\r\ndata: nope", data: 1 });
    expect(text.split("\n").filter((l) => l.startsWith("event:"))).toHaveLength(1);
    expect(text).not.toMatch(/\ndata: nope/);
  });
});

describe("delivery", () => {
  it("sends a user's own notification with id, event and whitelisted data", async () => {
    const { sink } = open();
    bus.publish(notification());
    await flush();
    expect(sink.text).toContain("id: evt_1\nevent: notification\n");
    const data = JSON.parse(sink.text.split("data: ")[1]!.split("\n")[0]!);
    expect(data).toEqual({
      id: "n1", event: "SHIPPED", title: "Shipped", body: "Body", vehicleId: "veh_1", createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("forwards only the whitelisted fields, never anything else on the payload", async () => {
    const { sink } = open();
    bus.publish(
      notification({
        payload: {
          id: "n1", event: "SHIPPED", title: "t", body: "b", vehicleId: null, createdAt: "x",
          org_id: ORG_A, password: "example-must-not-leave", recipients: ["user_2"], __proto__x: 1,
        },
      })
    );
    await flush();
    expect(sink.text).not.toContain("example-must-not-leave");
    expect(sink.text).not.toContain("org_id");
    expect(sink.text).not.toContain("recipients");
  });

  it("ignores event types that are not streamable, and malformed payloads", async () => {
    const { sink } = open();
    bus.publish(notification({ type: "internal.debug" }));
    bus.publish(notification({ payload: "not an object" }));
    bus.publish(notification({ payload: null }));
    await flush();
    expect(sink.text).toBe("");
  });

  it("a stream only receives its own user's events", async () => {
    const a = open("user_1");
    const b = open("user_2");
    bus.publish(notification({ userId: "user_1", id: "for_1" }));
    bus.publish(notification({ userId: "user_2", id: "for_2" }));
    await flush();
    expect(a.sink.text).toContain("id: for_1");
    expect(a.sink.text).not.toContain("for_2");
    expect(b.sink.text).toContain("id: for_2");
    expect(b.sink.text).not.toContain("for_1");
  });

  it("two users with the same user id in different orgs never see each other's events", async () => {
    const inA = open("user_1", ORG_A);
    const inB = open("user_1", ORG_B);
    bus.publish(notification({ orgId: ORG_A, id: "org_a_event" }));
    bus.publish(notification({ orgId: ORG_B, id: "org_b_event" }));
    await flush();
    expect(inA.sink.text).toContain("org_a_event");
    expect(inA.sink.text).not.toContain("org_b_event");
    expect(inB.sink.text).toContain("org_b_event");
    expect(inB.sink.text).not.toContain("org_a_event");
  });
});

describe("heartbeat", () => {
  it("sends a comment line every 25 seconds", async () => {
    const { sink } = open();
    await vi.advanceTimersByTimeAsync(24_999);
    expect(sink.text).not.toContain(": ping");
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(sink.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(3);
  });

  it("stops pinging once the connection is closed", async () => {
    const { sink, connection } = open();
    connection.close();
    const before = sink.chunks.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sink.chunks.length).toBe(before);
  });
});

describe("token expiry", () => {
  it("sends event: reauth and ends the stream exactly when the token expires", async () => {
    const { sink } = open("user_1", ORG_A, 60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sink.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.ended).toBe(true);
    expect(sink.text).toContain('event: reauth\ndata: {"reason":"token_expired"}');
    expect(hub.size).toBe(0);
  });

  it("an already-expired token closes immediately", async () => {
    const { sink } = open("user_1", ORG_A, -5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.ended).toBe(true);
    expect(sink.text).toContain("event: reauth");
  });

  it("delivers nothing after expiry", async () => {
    const { sink } = open("user_1", ORG_A, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const before = sink.text;
    bus.publish(notification());
    await flush();
    expect(sink.text).toBe(before);
  });
});

describe("per-user cap and eviction", () => {
  it("a 4th stream closes the oldest, with a final 'closed' event", async () => {
    const first = open();
    const second = open();
    const third = open();
    expect(hub.size).toBe(3);
    const fourth = open();
    expect(hub.size).toBe(3);
    expect(first.sink.ended).toBe(true);
    expect(first.sink.text).toContain('event: closed\ndata: {"reason":"replaced"}');
    for (const s of [second, third, fourth]) expect(s.sink.ended).toBe(false);
  });

  it("evicts in order: oldest first, repeatedly", () => {
    const sinks = Array.from({ length: 6 }, () => open().sink);
    expect(sinks.map((s) => s.ended)).toEqual([true, true, true, false, false, false]);
    expect(hub.size).toBe(3);
  });

  it("the cap is per user and org, not global: another user is untouched", () => {
    const other = open("user_2");
    open();
    open();
    open();
    open(); // evicts user_1's oldest only
    expect(other.sink.ended).toBe(false);
    expect(hub.size).toBe(4);
  });

  it("an evicted stream stops receiving events", async () => {
    const first = open();
    open();
    open();
    open();
    bus.publish(notification({ id: "after_evict" }));
    await flush();
    expect(first.sink.text).not.toContain("after_evict");
  });
});

describe("capacity", () => {
  it("reports no capacity at the instance-wide cap and recovers when a stream closes", () => {
    const connections = ["u1", "u2", "u3", "u4", "u5"].map((u) => open(u).connection);
    expect(hub.hasCapacity()).toBe(false);
    connections[0]!.close();
    expect(hub.hasCapacity()).toBe(true);
  });
});

describe("cleanup", () => {
  it("close() releases the timers and the bus subscription", () => {
    const { connection } = open();
    expect(bus.subscriberCount()).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    connection.close();
    expect(bus.subscriberCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(hub.size).toBe(0);
  });

  it("dispose() (socket went away) releases everything without writing", () => {
    const { sink, connection } = open();
    connection.dispose();
    expect(bus.subscriberCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(hub.size).toBe(0);
    expect(sink.chunks).toEqual([]);
    expect(sink.ended).toBe(false);
  });

  it("closing and disposing are idempotent", () => {
    const { connection } = open();
    connection.close();
    expect(() => {
      connection.close();
      connection.dispose();
    }).not.toThrow();
    expect(hub.size).toBe(0);
  });

  it("a write failure drops the connection and frees its resources", async () => {
    const { sink } = open();
    sink.throwOnWrite = true;
    bus.publish(notification());
    await flush();
    expect(hub.size).toBe(0);
    expect(bus.subscriberCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a client that is not reading (large unsent buffer) is dropped", async () => {
    const { sink } = open();
    sink.writableLength = 10 * 1024 * 1024;
    bus.publish(notification());
    await flush();
    expect(hub.size).toBe(0);
    expect(sink.ended).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opening and closing many streams leaves no timers or subscriptions behind", () => {
    for (let i = 0; i < 50; i++) open(`user_${i % 4}`).connection.close();
    expect(hub.size).toBe(0);
    expect(bus.subscriberCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("graceful shutdown", () => {
  it("closeAll tells every client and ends every stream", () => {
    const sinks = [open("u1").sink, open("u2").sink, open("u1", ORG_B).sink];
    hub.closeAll();
    for (const s of sinks) {
      expect(s.text).toContain("event: shutdown");
      expect(s.ended).toBe(true);
    }
    expect(hub.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closeAll with nothing open is a no-op", () => {
    expect(() => hub.closeAll()).not.toThrow();
  });
});
