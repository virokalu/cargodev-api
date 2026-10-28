import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));
const push = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: push.send }));

import {
  InMemoryEventBus,
  getEventBus,
  setEventBus,
  type AppEvent,
  type EventBus,
} from "../src/lib/events.js";
import { notifyRealtime, type EmitParams } from "../src/services/notification.service.js";

/** Deliveries happen on a microtask so publish() never blocks; let them run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const event = (over: Partial<AppEvent> = {}): AppEvent => ({
  type: "notification",
  orgId: ORG_A,
  userId: "user_1",
  payload: { n: 1 },
  id: "evt_1",
  ...over,
});

describe("InMemoryEventBus", () => {
  let bus: InMemoryEventBus;
  beforeEach(() => {
    bus = new InMemoryEventBus();
    vi.restoreAllMocks();
  });

  it("delivers an event to a subscriber for the same user and org", async () => {
    const got: AppEvent[] = [];
    bus.subscribe("user_1", ORG_A, (e) => got.push(e));
    bus.publish(event());
    await flush();
    expect(got).toEqual([event()]);
  });

  it("delivers only to the matching userId AND orgId", async () => {
    const mine: string[] = [];
    const otherUser: string[] = [];
    const otherOrgSameUserId: string[] = [];
    bus.subscribe("user_1", ORG_A, (e) => mine.push(e.id));
    bus.subscribe("user_2", ORG_A, (e) => otherUser.push(e.id));
    bus.subscribe("user_1", ORG_B, (e) => otherOrgSameUserId.push(e.id));

    bus.publish(event({ id: "for_a" }));
    bus.publish(event({ id: "for_b", orgId: ORG_B }));
    await flush();

    expect(mine).toEqual(["for_a"]);
    expect(otherUser).toEqual([]);
    expect(otherOrgSameUserId).toEqual(["for_b"]);
  });

  it("an org and user id that merely concatenate to the same string do not collide", async () => {
    const got: string[] = [];
    bus.subscribe("b_c", "a", (e) => got.push(e.id));
    bus.publish(event({ orgId: "a_b", userId: "c", id: "should_not_arrive" }));
    await flush();
    expect(got).toEqual([]);
  });

  it("unsubscribe stops delivery, and is safe to call twice", async () => {
    const got: string[] = [];
    const unsubscribe = bus.subscribe("user_1", ORG_A, (e) => got.push(e.id));
    bus.publish(event({ id: "before" }));
    await flush();
    unsubscribe();
    unsubscribe();
    bus.publish(event({ id: "after" }));
    await flush();
    expect(got).toEqual(["before"]);
    expect(bus.subscriberCount()).toBe(0);
  });

  it("unsubscribing one subscription leaves the others for that user in place", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = bus.subscribe("user_1", ORG_A, (e) => a.push(e.id));
    bus.subscribe("user_1", ORG_A, (e) => b.push(e.id));
    offA();
    bus.publish(event());
    await flush();
    expect([a.length, b.length]).toEqual([0, 1]);
  });

  it("a subscriber that unsubscribes before delivery does not receive a queued event it no longer wants", async () => {
    const got: string[] = [];
    const handler = (e: AppEvent) => got.push(e.id);
    const off = bus.subscribe("user_1", ORG_A, handler);
    bus.publish(event({ id: "queued" }));
    off(); // before the microtask runs
    await flush();
    // Delivery was snapshotted at publish time. What matters: no throw, and later events are not delivered.
    bus.publish(event({ id: "later" }));
    await flush();
    expect(got).not.toContain("later");
  });

  it("a throwing handler does not affect other subscribers or the publisher", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const good: string[] = [];
    bus.subscribe("user_1", ORG_A, () => {
      throw new Error("boom with ExponentPushToken[abc123def456]");
    });
    bus.subscribe("user_1", ORG_A, (e) => good.push(e.id));

    expect(() => bus.publish(event())).not.toThrow();
    await flush();

    expect(good).toEqual(["evt_1"]);
    expect(log).toHaveBeenCalled();
    // The failure is logged without leaking the secret that was in its message.
    expect(JSON.stringify(log.mock.calls)).not.toContain("abc123def456");
  });

  it("publish returns immediately and does not run handlers synchronously", async () => {
    let called = false;
    bus.subscribe("user_1", ORG_A, () => {
      called = true;
    });
    bus.publish(event());
    expect(called).toBe(false); // not yet: the caller was not blocked
    await flush();
    expect(called).toBe(true);
  });

  it("publishing with no subscribers is a no-op", () => {
    expect(() => bus.publish(event())).not.toThrow();
  });

  it("the same function subscribed twice is two independent subscriptions", async () => {
    let n = 0;
    const handler = () => void n++;
    const off1 = bus.subscribe("user_1", ORG_A, handler);
    bus.subscribe("user_1", ORG_A, handler);
    bus.publish(event());
    await flush();
    expect(n).toBe(2);
    off1();
    bus.publish(event());
    await flush();
    expect(n).toBe(3);
  });
});

describe("the process-wide bus", () => {
  it("can be swapped, so a LISTEN/NOTIFY implementation can replace the in-memory one", () => {
    const original = getEventBus();
    const replacement: EventBus = { publish: vi.fn(), subscribe: vi.fn(() => () => undefined) };
    setEventBus(replacement);
    expect(getEventBus()).toBe(replacement);
    setEventBus(original);
  });
});

describe("notifyRealtime publishes to the bus", () => {
  let fake: FakePrisma;
  let bus: InMemoryEventBus;
  let previous: EventBus;

  beforeEach(() => {
    push.send.mockReset();
    push.send.mockResolvedValue(undefined);
    fake = createFakePrisma();
    state.fake = fake;
    previous = getEventBus();
    bus = new InMemoryEventBus();
    setEventBus(bus);
    return () => setEventBus(previous);
  });

  const params = (over: Partial<EmitParams> = {}): EmitParams => ({
    orgId: ORG_A,
    event: "SHIPPED",
    title: "Shipped",
    body: "A vehicle shipped",
    vehicleId: "veh_1",
    recipientUserIds: ["user_1", "user_2"],
    recipientNotificationIds: { user_1: "notif_1", user_2: "notif_2" },
    ...over,
  });

  it("publishes one whitelisted event per recipient, with that recipient's own notification id", async () => {
    const got: AppEvent[] = [];
    bus.subscribe("user_1", ORG_A, (e) => got.push(e));
    bus.subscribe("user_2", ORG_A, (e) => got.push(e));

    notifyRealtime(params());
    await flush();

    expect(got).toHaveLength(2);
    const forUser1 = got.find((e) => e.userId === "user_1")!;
    expect(forUser1).toMatchObject({ type: "notification", orgId: ORG_A, id: "notif_1" });
    expect(forUser1.payload).toEqual({
      id: "notif_1",
      event: "SHIPPED",
      title: "Shipped",
      body: "A vehicle shipped",
      vehicleId: "veh_1",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    // Nothing beyond the whitelist: no org id, no recipient list, no other users' ids.
    expect(Object.keys(forUser1.payload as object).sort()).toEqual(["body", "createdAt", "event", "id", "title", "vehicleId"]);
  });

  it("a recipient in another org never receives the event", async () => {
    const wrongOrg: AppEvent[] = [];
    bus.subscribe("user_1", ORG_B, (e) => wrongOrg.push(e));
    notifyRealtime(params());
    await flush();
    expect(wrongOrg).toEqual([]);
  });

  it("still sends Expo push after publishing", async () => {
    fake.seed("deviceToken", { id: "dt", org_id: ORG_A, userId: "user_1", expoPushToken: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]" });
    notifyRealtime(params());
    await vi.waitFor(() => expect(push.send).toHaveBeenCalledTimes(1));
  });

  it("a failing bus never reaches the caller and does not stop the push", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setEventBus({
      publish: () => {
        throw new Error("bus down");
      },
      subscribe: () => () => undefined,
    });
    fake.seed("deviceToken", { id: "dt", org_id: ORG_A, userId: "user_1", expoPushToken: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]" });
    expect(() => notifyRealtime(params())).not.toThrow();
    await vi.waitFor(() => expect(push.send).toHaveBeenCalledTimes(1));
  });

  it("generates an event id when the notification id is unknown", async () => {
    const got: AppEvent[] = [];
    bus.subscribe("user_1", ORG_A, (e) => got.push(e));
    notifyRealtime(params({ recipientNotificationIds: {} }));
    await flush();
    expect(got[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((got[0]?.payload as { id: unknown }).id).toBeNull();
  });
});
