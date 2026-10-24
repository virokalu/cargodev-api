import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, mentionsOrg, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

const push = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: push.send }));

import {
  listDeviceTokensForUsers,
  registerDeviceToken,
  removeDeviceTokens,
  unregisterDeviceToken,
} from "../src/services/device-token.service.js";
import {
  countUnread,
  emit,
  listNotifiableStaffIds,
  listNotificationsPaginated,
  markAllRead,
  markRead,
  notifyRealtime,
  type EmitParams,
} from "../src/services/notification.service.js";

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

let fake: FakePrisma;

beforeEach(() => {
  push.send.mockReset();
  push.send.mockResolvedValue(undefined);
  fake = createFakePrisma();
  state.fake = fake;
  const staff = (id: string, org_id: string, role: string, extra: Record<string, unknown> = {}) => ({
    id,
    org_id,
    role,
    userType: "STAFF",
    loginEnabled: true,
    ...extra,
  });
  fake.seed(
    "user",
    staff("admin_a", ORG_A, "ADMINISTRATOR"),
    staff("mgr_a", ORG_A, "MANAGER"),
    staff("op_a", ORG_A, "OPERATOR"),
    staff("off_a", ORG_A, "MANAGER", { loginEnabled: false }),
    staff("mgr_b", ORG_B, "MANAGER"),
    { id: "cust_a", org_id: ORG_A, userType: "CUSTOMER", role: null, loginEnabled: false }
  );
  fake.seed("vehicle", { id: "veh_a", org_id: ORG_A, serial: "FC100" }, { id: "veh_b", org_id: ORG_B, serial: "FC900" });
});

const params = (over: Partial<EmitParams> = {}): EmitParams => ({
  orgId: ORG_A,
  event: "SHIPPED",
  title: "Shipped",
  body: "A vehicle shipped",
  vehicleId: "veh_a",
  recipientUserIds: ["admin_a", "mgr_a"],
  ...over,
});

describe("listNotifiableStaffIds", () => {
  it("returns active admins and managers of the org only, minus the actor", async () => {
    expect((await listNotifiableStaffIds(fake.client, ORG_A)).sort()).toEqual(["admin_a", "mgr_a"]);
    expect(await listNotifiableStaffIds(fake.client, ORG_A, "admin_a")).toEqual(["mgr_a"]);
  });
  it("never includes another org, operators, customers or disabled accounts", async () => {
    const ids = await listNotifiableStaffIds(fake.client, ORG_A);
    for (const bad of ["mgr_b", "op_a", "cust_a", "off_a"]) expect(ids).not.toContain(bad);
  });
});

describe("emit", () => {
  it("writes one row per recipient in the event org and records their ids", async () => {
    const p = params();
    await emit(fake.client, p);
    const rows = fake.rows("notification");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r["org_id"] === ORG_A)).toBe(true);
    expect(rows.map((r) => r["userId"]).sort()).toEqual(["admin_a", "mgr_a"]);
    expect(Object.keys(p.recipientNotificationIds ?? {}).sort()).toEqual(["admin_a", "mgr_a"]);
    expect(p.recipientNotificationIds?.["admin_a"]).toBe(rows.find((r) => r["userId"] === "admin_a")?.["id"]);
  });
  it("is a no-op without recipients", async () => {
    const p = params({ recipientUserIds: [] });
    await emit(fake.client, p);
    expect(fake.rows("notification")).toHaveLength(0);
    expect(p.recipientNotificationIds).toBeUndefined();
  });
  it("stores null when there is no vehicle", async () => {
    const { vehicleId: _omit, ...withoutVehicle } = params();
    await emit(fake.client, withoutVehicle);
    expect(fake.rows("notification")[0]?.["vehicleId"]).toBeNull();
  });
});

describe("reading and marking notifications", () => {
  beforeEach(() => {
    const base = { event: "SHIPPED", title: "t", body: "b", isRead: false };
    fake.seed(
      "notification",
      { ...base, id: "n1", org_id: ORG_A, userId: "mgr_a", vehicleId: "veh_a", createdAt: new Date(3) },
      { ...base, id: "n2", org_id: ORG_A, userId: "mgr_a", vehicleId: null, createdAt: new Date(2) },
      { ...base, id: "n3", org_id: ORG_A, userId: "admin_a", vehicleId: null, createdAt: new Date(1) },
      { ...base, id: "n4", org_id: ORG_B, userId: "mgr_a", vehicleId: "veh_b", createdAt: new Date(4) }
    );
  });

  it("lists only the callers own notifications in their org, newest first, with vehicle serials", async () => {
    const result = await listNotificationsPaginated(ORG_A, "mgr_a", { page: 1, pageSize: 10 });
    expect(result.rows.map((r) => r.id)).toEqual(["n1", "n2"]);
    expect(result.rows[0]?.vehicleSerial).toBe("FC100");
    expect(result.rows[1]?.vehicleSerial).toBeNull();
    expect(result).toMatchObject({ total: 2, page: 1, pageSize: 10, totalPages: 1 });
  });

  it("never resolves a serial from another orgs vehicle", async () => {
    // A notification in org A that somehow points at org B's vehicle gets no serial.
    fake.rows("notification").find((r) => r["id"] === "n1")!["vehicleId"] = "veh_b";
    const mine = await listNotificationsPaginated(ORG_A, "mgr_a", { page: 1, pageSize: 10 });
    expect(mine.rows.find((r) => r.id === "n1")?.vehicleSerial).toBeNull();
  });

  it("paginates", async () => {
    const page2 = await listNotificationsPaginated(ORG_A, "mgr_a", { page: 2, pageSize: 1 });
    expect(page2.rows.map((r) => r.id)).toEqual(["n2"]);
    expect(page2.totalPages).toBe(2);
  });

  it("counts unread for the caller only", async () => {
    expect(await countUnread(ORG_A, "mgr_a")).toBe(2);
    expect(await countUnread(ORG_A, "admin_a")).toBe(1);
    expect(await countUnread(ORG_B, "admin_a")).toBe(0);
  });

  it("markRead changes only the callers own row in their org, and is idempotent", async () => {
    await markRead(ORG_A, "mgr_a", "n1");
    await markRead(ORG_A, "mgr_a", "n1");
    await markRead(ORG_A, "mgr_a", "n3"); // someone else's
    await markRead(ORG_A, "mgr_a", "n4"); // other org's
    const read = (id: string) => fake.rows("notification").find((r) => r["id"] === id)?.["isRead"];
    expect(read("n1")).toBe(true);
    expect(read("n3")).toBe(false);
    expect(read("n4")).toBe(false);
  });

  it("markAllRead touches only the callers rows in their org", async () => {
    await markAllRead(ORG_A, "mgr_a");
    const read = (id: string) => fake.rows("notification").find((r) => r["id"] === id)?.["isRead"];
    expect([read("n1"), read("n2")]).toEqual([true, true]);
    expect([read("n3"), read("n4")]).toEqual([false, false]);
  });

  it("every read query includes org_id", async () => {
    await listNotificationsPaginated(ORG_A, "mgr_a", { page: 1, pageSize: 10 });
    await countUnread(ORG_A, "mgr_a");
    const reads = fake.calls.filter((c) => c.method === "findMany" || c.method === "count");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => mentionsOrg(c.args, ORG_A))).toBe(true);
  });
});

describe("notifyRealtime (mobile push)", () => {
  beforeEach(() => {
    fake.seed(
      "deviceToken",
      { id: "dt_admin", org_id: ORG_A, userId: "admin_a", expoPushToken: TOKEN_A },
      { id: "dt_other", org_id: ORG_B, userId: "mgr_b", expoPushToken: TOKEN_B }
    );
  });

  it("pushes to the recipients devices with the notification id and vehicle serial", async () => {
    const p = params();
    await emit(fake.client, p);
    notifyRealtime(p);
    await vi.waitFor(() => expect(push.send).toHaveBeenCalledTimes(1));

    const [targets, notification] = push.send.mock.calls[0] as [
      Array<{ expoPushToken: string; data: Record<string, unknown> }>,
      Record<string, unknown>,
    ];
    expect(targets).toHaveLength(1);
    expect(targets[0]?.expoPushToken).toBe(TOKEN_A);
    expect(targets[0]?.data).toEqual({ vehicleSerial: "FC100", notificationId: p.recipientNotificationIds?.["admin_a"] });
    expect(notification).toMatchObject({
      title: "Shipped",
      body: "A vehicle shipped",
      data: { event: "SHIPPED", vehicleId: "veh_a" },
    });
  });

  it("never pushes to another orgs devices", async () => {
    notifyRealtime(params({ recipientUserIds: ["mgr_b"] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(push.send).not.toHaveBeenCalled();
  });

  it("does not look up a serial from another orgs vehicle", async () => {
    notifyRealtime(params({ vehicleId: "veh_b" }));
    await vi.waitFor(() => expect(push.send).toHaveBeenCalled());
    const [targets] = push.send.mock.calls[0] as [Array<{ data: { vehicleSerial: unknown } }>];
    expect(targets[0]?.data.vehicleSerial).toBeNull();
  });

  it("sends nothing when no recipient has a registered device", async () => {
    notifyRealtime(params({ recipientUserIds: ["mgr_a"] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(push.send).not.toHaveBeenCalled();
  });

  it("never throws into the caller when the push fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    push.send.mockRejectedValue(new Error("expo down"));
    expect(() => notifyRealtime(params())).not.toThrow();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
  });
});

describe("device tokens", () => {
  const valid = { expoPushToken: TOKEN_A, platform: "ios" };

  it("registers a token for the caller in their org", async () => {
    const result = await registerDeviceToken(ORG_A, "mgr_a", valid);
    expect(result).toMatchObject({ expoPushToken: TOKEN_A, platform: "ios" });
    expect(fake.rows("deviceToken")[0]).toMatchObject({ org_id: ORG_A, userId: "mgr_a" });
  });

  it("re-registering the same device moves it to the new owner instead of duplicating", async () => {
    await registerDeviceToken(ORG_A, "mgr_a", valid);
    await registerDeviceToken(ORG_A, "admin_a", valid);
    expect(fake.rows("deviceToken")).toHaveLength(1);
    expect(fake.rows("deviceToken")[0]?.["userId"]).toBe("admin_a");
  });

  it("rejects a malformed token or missing fields with field errors", async () => {
    await expect(registerDeviceToken(ORG_A, "mgr_a", { expoPushToken: "nope", platform: "ios" })).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { expoPushToken: "Not a valid Expo push token" },
    });
    await expect(registerDeviceToken(ORG_A, "mgr_a", {})).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(registerDeviceToken(ORG_A, "mgr_a", null)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(fake.rows("deviceToken")).toHaveLength(0);
  });

  it("unregister removes only the callers own token, idempotently", async () => {
    await registerDeviceToken(ORG_A, "mgr_a", valid);
    await registerDeviceToken(ORG_B, "mgr_b", { expoPushToken: TOKEN_B, platform: "android" });

    await unregisterDeviceToken(ORG_A, "admin_a", { expoPushToken: TOKEN_A }); // not theirs
    expect(fake.rows("deviceToken")).toHaveLength(2);
    await unregisterDeviceToken(ORG_B, "mgr_b", { expoPushToken: TOKEN_A }); // other org
    expect(fake.rows("deviceToken")).toHaveLength(2);

    await unregisterDeviceToken(ORG_A, "mgr_a", { expoPushToken: TOKEN_A });
    await unregisterDeviceToken(ORG_A, "mgr_a", { expoPushToken: TOKEN_A });
    expect(fake.rows("deviceToken").map((r) => r["expoPushToken"])).toEqual([TOKEN_B]);
  });

  it("unregister requires a token", async () => {
    await expect(unregisterDeviceToken(ORG_A, "mgr_a", {})).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("listDeviceTokensForUsers is org-scoped and removeDeviceTokens prunes by token", async () => {
    await registerDeviceToken(ORG_A, "mgr_a", valid);
    await registerDeviceToken(ORG_B, "mgr_b", { expoPushToken: TOKEN_B, platform: "android" });
    expect(await listDeviceTokensForUsers(ORG_A, ["mgr_a", "mgr_b"])).toEqual([{ userId: "mgr_a", expoPushToken: TOKEN_A }]);
    await removeDeviceTokens([TOKEN_A]);
    await removeDeviceTokens([]);
    expect(fake.rows("deviceToken").map((r) => r["expoPushToken"])).toEqual([TOKEN_B]);
  });
});
