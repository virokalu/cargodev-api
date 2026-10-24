import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A } from "./helpers/fixtures.js";

const sdk = vi.hoisted(() => {
  process.env["EXPO_ACCESS_TOKEN"] = "example-expo-access-value";
  return { send: vi.fn(), ctorArgs: [] as unknown[] };
});

vi.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(token: unknown): boolean {
      return typeof token === "string" && /^Expo(nent)?PushToken\[.+\]$/.test(token);
    }
    constructor(options: unknown) {
      sdk.ctorArgs.push(options);
    }
    // Chunk size 2, so attribution across chunks is exercised with 3 targets.
    chunkPushNotifications(messages: unknown[]): unknown[][] {
      const chunks: unknown[][] = [];
      for (let i = 0; i < messages.length; i += 2) chunks.push(messages.slice(i, i + 2));
      return chunks;
    }
    sendPushNotificationsAsync = sdk.send;
  }
  return { Expo };
});

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { sendExpoPushNotifications } from "../src/lib/expo-push.js";

const T1 = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const T2 = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const T3 = "ExponentPushToken[cccccccccccccccccccccc]";
const note = { title: "Title", body: "Body", data: { event: "SHIPPED" } };

let fake: FakePrisma;

beforeEach(() => {
  sdk.send.mockReset();
  vi.restoreAllMocks();
  fake = createFakePrisma();
  state.fake = fake;
  fake.seed(
    "deviceToken",
    { id: "dt1", org_id: ORG_A, userId: "u1", expoPushToken: T1 },
    { id: "dt2", org_id: ORG_A, userId: "u2", expoPushToken: T2 },
    { id: "dt3", org_id: ORG_A, userId: "u3", expoPushToken: T3 }
  );
});

const ok = { status: "ok", id: "ticket" };
const deadDevice = { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } };

describe("sendExpoPushNotifications", () => {
  it("does nothing when no token is valid", async () => {
    await sendExpoPushNotifications([{ expoPushToken: "not-a-token" }], note);
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it("sends title, body, sound and merged data, with per-target data winning", async () => {
    sdk.send.mockResolvedValue([ok]);
    await sendExpoPushNotifications([{ expoPushToken: T1, data: { notificationId: "n1", event: "OVERRIDE" } }], note);
    expect(sdk.send).toHaveBeenCalledWith([
      { to: T1, title: "Title", body: "Body", sound: "default", data: { event: "OVERRIDE", notificationId: "n1" } },
    ]);
  });

  it("filters out malformed tokens but still sends to the valid ones", async () => {
    sdk.send.mockResolvedValue([ok]);
    await sendExpoPushNotifications([{ expoPushToken: "garbage" }, { expoPushToken: T1 }], note);
    expect(sdk.send.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("uses the access token from the environment when one is set", async () => {
    sdk.send.mockResolvedValue([ok]);
    await sendExpoPushNotifications([{ expoPushToken: T1 }], note);
    expect(sdk.ctorArgs[0]).toEqual({ accessToken: "example-expo-access-value" });
  });

  it("prunes only tokens whose ticket says DeviceNotRegistered", async () => {
    sdk.send
      .mockResolvedValueOnce([ok, deadDevice])
      .mockResolvedValueOnce([{ status: "error", message: "rate", details: { error: "MessageRateExceeded" } }]);
    await sendExpoPushNotifications([{ expoPushToken: T1 }, { expoPushToken: T2 }, { expoPushToken: T3 }], note);
    expect(fake.rows("deviceToken").map((r) => r["expoPushToken"])).toEqual([T1, T3]);
  });

  it("a failed chunk neither throws nor shifts attribution for later chunks", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Chunk 1 (T1, T2) fails entirely; chunk 2 (T3) says T3 is dead.
    sdk.send.mockRejectedValueOnce(new Error("network blip")).mockResolvedValueOnce([deadDevice]);
    await expect(
      sendExpoPushNotifications([{ expoPushToken: T1 }, { expoPushToken: T2 }, { expoPushToken: T3 }], note)
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    expect(fake.rows("deviceToken").map((r) => r["expoPushToken"])).toEqual([T1, T2]);
  });

  it("swallows a failure while pruning", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    sdk.send.mockResolvedValue([deadDevice]);
    (fake.client as unknown as { deviceToken: { deleteMany: unknown } }).deviceToken.deleteMany = async () => {
      throw new Error("db down");
    };
    await expect(sendExpoPushNotifications([{ expoPushToken: T1 }], note)).resolves.toBeUndefined();
  });
});
