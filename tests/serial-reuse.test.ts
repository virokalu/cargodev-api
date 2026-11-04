// A deleted vehicle's serial is never handed out again by accident. The parts that do not need a database migration:
//  - a conflict with a LIVE vehicle is a plain 409 (no `reason`);
//  - a conflict with a DELETED vehicle is a 409 with reason SERIAL_PREVIOUSLY_USED;
//  - `reuseDeletedSerial: true` is for administrators: a MANAGER sending it gets 403, an administrator gets a 409 with reason
//    SERIAL_REUSE_NOT_ENABLED (the database still holds the old unique key until the approved partial-index migration is applied);
//  - `reason` exists on a 409 only; auto-generated serials never reuse a number. Fake data only.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { installFakeStorage, makeCtx, newContractWorld, removeFakeStorage, type Ctx } from "./helpers/staff-contract-examples.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const state = vi.hoisted(() => {
  process.env["R2_PUBLIC_URL"] = "https://files.example.test";
  return { fake: undefined as unknown };
});
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { buildApp } from "../src/app.js";
import { ServiceError } from "../src/lib/errors.js";
import { errorBody } from "../src/lib/response.js";
import { setTrustTokenClaimsForTests } from "../src/lib/staff-auth-seam.js";
import { clearStaffAuthCache } from "../src/services/staff-auth-state.service.js";

let app: FastifyInstance;
let fake: FakePrisma;
let ctx: Ctx;
type Err = { error: { code: string; message: string; fieldErrors?: Record<string, string>; reason?: string } };

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
  clearStaffAuthCache();
  ctx = makeCtx(app, fake);
});

const vehicles = () => fake.rows("vehicle");
const serialOf = (id: string) => vehicles().find((v) => v["id"] === id)!["serial"];
const legacyBody = (n: number, extra: Record<string, unknown> = {}) => ({
  track: "FC", isLegacyEntry: true, legacySerialNumber: n, chassisNo: `CHASSIS-REUSE-${n}`, brandId: "brand_a1", modelId: "model_a1", ...extra,
});
// FC101 is live (v_fc_pending); FC106 belongs to a deleted vehicle (v_fc_deleted).
const LIVE = 102;
const DELETED = 106;

describe("serial correction (administrator only)", () => {
  const url = "/api/v1/vehicles/v_fc_pending/serial";

  it("a live serial is a plain 409: a field error and no reason", async () => {
    const res = await ctx.call("ADMINISTRATOR", "PATCH", url, { serialNumber: LIVE });
    expect(res.status).toBe(409);
    const error = (res.body as Err).error;
    expect(Object.keys(error).sort()).toEqual(["code", "fieldErrors", "message"]);
    expect(error.fieldErrors).toHaveProperty("serialNumber");
  });

  it("a deleted vehicle's serial is a 409 with reason SERIAL_PREVIOUSLY_USED, and nothing changes", async () => {
    const res = await ctx.call("ADMINISTRATOR", "PATCH", url, { serialNumber: DELETED });
    expect(res.status).toBe(409);
    const error = (res.body as Err).error;
    expect([error.code, error.reason]).toEqual(["CONFLICT", "SERIAL_PREVIOUSLY_USED"]);
    expect(error.fieldErrors).toHaveProperty("serialNumber");
    expect(serialOf("v_fc_pending")).toBe("FC101");
  });

  it("with reuseDeletedSerial the administrator gets reason SERIAL_REUSE_NOT_ENABLED (the database still forbids reuse), and nothing changes", async () => {
    const res = await ctx.call("ADMINISTRATOR", "PATCH", url, { serialNumber: DELETED, reuseDeletedSerial: true });
    expect(res.status).toBe(409);
    expect((res.body as Err).error.reason).toBe("SERIAL_REUSE_NOT_ENABLED");
    expect(serialOf("v_fc_pending")).toBe("FC101");
  });

  it("a MANAGER cannot reach the correction at all (403), flag or not", async () => {
    for (const body of [{ serialNumber: 150 }, { serialNumber: 150, reuseDeletedSerial: true }]) {
      expect((await ctx.call("MANAGER", "PATCH", url, body)).status).toBe(403);
    }
    expect(serialOf("v_fc_pending")).toBe("FC101");
  });

  it("a free serial still works, with or without the flag", async () => {
    expect((await ctx.call("ADMINISTRATOR", "PATCH", url, { serialNumber: 150, reuseDeletedSerial: true })).status).toBe(200);
    expect(serialOf("v_fc_pending")).toBe("FC150");
  });
});

describe("create with a legacy serial", () => {
  it("a live serial is a plain 409 with fieldErrors.legacySerialNumber and no reason; nothing is created", async () => {
    const before = vehicles().length;
    const res = await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(LIVE));
    expect(res.status).toBe(409);
    const error = (res.body as Err).error;
    expect(Object.keys(error).sort()).toEqual(["code", "fieldErrors", "message"]);
    expect(error.fieldErrors).toHaveProperty("legacySerialNumber");
    expect(vehicles()).toHaveLength(before);
  });

  it("a deleted vehicle's serial is 409 SERIAL_PREVIOUSLY_USED for a MANAGER and for an administrator without the flag", async () => {
    for (const role of ["MANAGER", "ADMINISTRATOR"] as const) {
      const before = vehicles().length;
      const res = await ctx.call(role, "POST", "/api/v1/vehicles", legacyBody(DELETED));
      expect([role, res.status, (res.body as Err).error.reason]).toEqual([role, 409, "SERIAL_PREVIOUSLY_USED"]);
      expect(vehicles()).toHaveLength(before);
    }
  });

  it("a MANAGER who sends reuseDeletedSerial: true gets 403 FORBIDDEN, with a field error and no reason; nothing is created", async () => {
    for (const body of [legacyBody(DELETED, { reuseDeletedSerial: true }), legacyBody(777, { reuseDeletedSerial: true }), { ...legacyBody(1), isLegacyEntry: false, legacySerialNumber: null, reuseDeletedSerial: true }]) {
      const before = vehicles().length;
      const res = await ctx.call("MANAGER", "POST", "/api/v1/vehicles", body);
      const error = (res.body as Err).error;
      expect([res.status, error.code]).toEqual([403, "FORBIDDEN"]);
      expect(error).not.toHaveProperty("reason");
      expect(error.fieldErrors).toHaveProperty("reuseDeletedSerial");
      expect(vehicles()).toHaveLength(before);
    }
  });

  it("a MANAGER sending reuseDeletedSerial: false is not refused", async () => {
    expect((await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(778, { reuseDeletedSerial: false }))).status).toBe(201);
  });

  it("an administrator with the flag and a deleted serial gets 409 SERIAL_REUSE_NOT_ENABLED; with the flag and a free serial the create succeeds", async () => {
    const before = vehicles().length;
    const refused = await ctx.call("ADMINISTRATOR", "POST", "/api/v1/vehicles", legacyBody(DELETED, { reuseDeletedSerial: true }));
    expect([refused.status, (refused.body as Err).error.reason]).toEqual([409, "SERIAL_REUSE_NOT_ENABLED"]);
    expect(vehicles()).toHaveLength(before);
    const created = await ctx.call("ADMINISTRATOR", "POST", "/api/v1/vehicles", legacyBody(779, { reuseDeletedSerial: true }));
    expect(created.status).toBe(201);
    expect((created.body as { data: { serial: string } }).data.serial).toBe("FC779");
  });
});

describe("auto-generated serials never reuse a number", () => {
  it("the counter only goes up: deleting the newest vehicle does not free its number", async () => {
    const create = async () => ((await ctx.call("MANAGER", "POST", "/api/v1/vehicles", { track: "FC", isLegacyEntry: false, chassisNo: `CHASSIS-AUTO-${Math.random()}`, brandId: "brand_a1", modelId: "model_a1" })).body as { data: { id: string; serial: string } }).data;
    const first = await create();
    expect(first.serial).toBe("FC110");
    expect((await ctx.call("MANAGER", "DELETE", `/api/v1/vehicles/${first.id}`)).status).toBe(200);
    const second = await create();
    expect(second.serial).toBe("FC111");
    expect(second.serial).not.toBe(first.serial);
  });
});

describe("`reason` exists on a 409 only", () => {
  it("errorBody keeps it for CONFLICT and drops it for every other code", () => {
    expect(errorBody("CONFLICT", "m", undefined, "WHY")).toEqual({ error: { code: "CONFLICT", message: "m", reason: "WHY" } });
    for (const code of ["VALIDATION", "FORBIDDEN", "NOT_FOUND", "INTERNAL", "RATE_LIMITED"]) {
      expect(errorBody(code, "m", undefined, "WHY"), code).toEqual({ error: { code, message: "m" } });
    }
    expect(errorBody("CONFLICT", "m")).toEqual({ error: { code: "CONFLICT", message: "m" } });
  });

  it("a ServiceError carries it only when given, and the handler sends it only on a conflict", async () => {
    expect(new ServiceError("CONFLICT", "m").reason).toBeUndefined();
    expect(new ServiceError("CONFLICT", "m", undefined, "WHY").reason).toBe("WHY");
    // end to end: the 403 for the manager flag has no reason even though other errors in the same flow do
    const forbidden = await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(DELETED, { reuseDeletedSerial: true }));
    expect(JSON.stringify(forbidden.body)).not.toContain("reason");
  });
});
