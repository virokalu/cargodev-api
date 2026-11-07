// FREE REUSE of a deleted vehicle's serial (ADR 0009): serial uniqueness applies among vehicles that are NOT soft-deleted.
//  - creating (ADMINISTRATOR or MANAGER) or correcting (ADMINISTRATOR only) to a serial held only by deleted vehicles SUCCEEDS;
//  - a clash with an ACTIVE vehicle is a 409 with fieldErrors.serial "already in use";
//  - the answer carries serialReused, and the activity log records reusedFromVehicleId (the most recent deleted holder);
//  - `reuseDeletedSerial` is DEPRECATED: accepted and ignored; no 403 for a manager; the old codes are gone;
//  - auto-generated serials never reuse a number; a reused lower number leaves the counter alone.
// This file runs against the in-memory fake (which has no unique index); what the DATABASE enforces is proven in tests/db/serial-uniqueness.db.test.ts.
// Fake data only.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
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
type Row = Record<string, unknown>;
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
const byId = (id: string): Row => vehicles().find((v) => v["id"] === id)!;
const counter = () => fake.rows("serialCounter").find((c) => c["prefix"] === "FC")!["lastNumber"];
const lastLog = (action: string) => {
  const rows = fake.rows("activityLog").filter((r) => r["action"] === action);
  expect(rows.length, `an activity-log row for ${action}`).toBeGreaterThan(0);
  return rows[rows.length - 1] as { entityId: string; before: Row; after: Row };
};
const legacyBody = (n: number, extra: Record<string, unknown> = {}) => ({
  track: "FC", isLegacyEntry: true, legacySerialNumber: n, chassisNo: `CHASSIS-REUSE-${n}`, brandId: "brand_a1", modelId: "model_a1", ...extra,
});
// In the fixtures FC101 and FC102 belong to ACTIVE vehicles; FC106 belongs to a DELETED one (v_fc_deleted).
const ACTIVE = 102;
const DELETED = 106;

describe("create with a legacy serial", () => {
  it.each(["MANAGER", "ADMINISTRATOR"] as const)("a serial held only by a deleted vehicle is free for a %s: 201, serialReused true", async (role) => {
    const res = await ctx.call(role, "POST", "/api/v1/vehicles", legacyBody(DELETED));
    expect(res.status).toBe(201);
    const data = (res.body as { data: { id: string; serial: string; serialReused: boolean } }).data;
    expect([data.serial, data.serialReused]).toEqual(["FC106", true]);
    expect(vehicles().filter((v) => v["serial"] === "FC106")).toHaveLength(2); // the deleted one and the new one
  });

  it("the activity log of the creation records reusedFromVehicleId = the deleted vehicle, and the entity id is the NEW vehicle", async () => {
    const created = (await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(DELETED))).body as { data: { id: string } };
    const log = lastLog("CREATE_VEHICLE");
    expect(log.entityId).toBe(created.data.id);
    expect(log.after["reusedFromVehicleId"]).toBe("v_fc_deleted");
    expect(log.entityId).not.toBe("v_fc_deleted");
  });

  it("a serial nobody ever had: serialReused false, and the log has no reusedFromVehicleId key", async () => {
    const res = await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(777));
    expect((res.body as { data: { serialReused: boolean } }).data.serialReused).toBe(false);
    expect(lastLog("CREATE_VEHICLE").after).not.toHaveProperty("reusedFromVehicleId");
  });

  it("an automatic serial: serialReused false, and the counter moves up by one", async () => {
    const before = counter() as number;
    const res = await ctx.call("MANAGER", "POST", "/api/v1/vehicles", { track: "FC", isLegacyEntry: false, chassisNo: "CHASSIS-AUTO-1", brandId: "brand_a1", modelId: "model_a1" });
    expect(res.status).toBe(201);
    expect((res.body as { data: { serialReused: boolean; serial: string } }).data).toMatchObject({ serialReused: false, serial: `FC${before + 1}` });
    expect(counter()).toBe(before + 1);
  });

  it("the answer is the detail shape plus serialReused, and nothing else is added", async () => {
    const created = (await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(778))).body as { data: Row };
    const detail = (await ctx.call("MANAGER", "GET", "/api/v1/vehicles/FC778")).body as { data: Row };
    expect(Object.keys(created.data).sort()).toEqual([...Object.keys(detail.data), "serialReused"].sort());
  });

  it("an ACTIVE vehicle's serial is a 409 CONFLICT with fieldErrors.serial 'already in use' (and the field of the body), no reason; nothing is created", async () => {
    const before = vehicles().length;
    const res = await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(ACTIVE));
    expect(res.status).toBe(409);
    const error = (res.body as Err).error;
    expect(error.code).toBe("CONFLICT");
    expect(error.fieldErrors).toEqual({ legacySerialNumber: "Serial FC102 already exists.", serial: "already in use" });
    expect(error).not.toHaveProperty("reason");
    expect(vehicles()).toHaveLength(before);
  });

  it("a reused LOWER number does not move the counter (lastNumber = max(lastNumber, entered)); a higher one bumps it", async () => {
    const before = counter() as number;
    await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(DELETED));
    expect(counter()).toBe(before);
    await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(before + 50));
    expect(counter()).toBe(before + 50);
  });

  it("GET /vehicles/:serial answers with the ACTIVE vehicle when a deleted one shares the serial, and so do the other serial routes", async () => {
    const created = (await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(DELETED))).body as { data: { id: string } };
    for (const suffix of ["", "/timeline", "/status-history", "/milestones", "/files"]) {
      const res = await ctx.call("VIEWER", "GET", `/api/v1/vehicles/FC106${suffix}`);
      expect([suffix, res.status]).toEqual([suffix, 200]);
    }
    const detail = (await ctx.call("VIEWER", "GET", "/api/v1/vehicles/FC106")).body as { data: { id: string } };
    expect(detail.data.id).toBe(created.data.id);
    expect(detail.data.id).not.toBe("v_fc_deleted");
  });

  it("with no active holder (the new vehicle is deleted again) the serial is a 404 again", async () => {
    const created = (await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(DELETED))).body as { data: { id: string } };
    expect((await ctx.call("MANAGER", "DELETE", `/api/v1/vehicles/${created.data.id}`)).status).toBe(200);
    expect((await ctx.call("VIEWER", "GET", "/api/v1/vehicles/FC106")).status).toBe(404);
  });
});

describe("serial correction (ADMINISTRATOR only)", () => {
  const url = "/api/v1/vehicles/v_fc_pending/serial";

  it("to a serial held only by a deleted vehicle: 200, serialReused true, and the log names the deleted vehicle", async () => {
    const res = await ctx.call("ADMINISTRATOR", "PATCH", url, { serialNumber: DELETED });
    expect(res.status).toBe(200);
    expect((res.body as { data: Row }).data).toEqual({ serial: "FC106", serialReused: true });
    const log = lastLog("CORRECT_VEHICLE_SERIAL");
    expect(log.entityId).toBe("v_fc_pending");
    expect(log.before).toEqual({ serial: "FC101" });
    expect(log.after).toEqual({ serial: "FC106", reusedFromVehicleId: "v_fc_deleted" });
    expect(byId("v_fc_pending")["serial"]).toBe("FC106");
  });

  it("to a free serial: serialReused false and no reusedFromVehicleId in the log", async () => {
    const res = await ctx.call("ADMINISTRATOR", "PATCH", url, { serialNumber: 150 });
    expect((res.body as { data: Row }).data).toEqual({ serial: "FC150", serialReused: false });
    expect(lastLog("CORRECT_VEHICLE_SERIAL").after).toEqual({ serial: "FC150" });
  });

  it("to an ACTIVE vehicle's serial: 409 with fieldErrors.serial 'already in use' and serialNumber, nothing changes", async () => {
    const res = await ctx.call("ADMINISTRATOR", "PATCH", url, { serialNumber: ACTIVE });
    expect(res.status).toBe(409);
    expect((res.body as Err).error.fieldErrors).toEqual({ serialNumber: "Serial FC102 already exists.", serial: "already in use" });
    expect(byId("v_fc_pending")["serial"]).toBe("FC101");
  });

  it("delete, recreate, then correct another vehicle to the recreated (active) serial: 409", async () => {
    await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(DELETED));
    const res = await ctx.call("ADMINISTRATOR", "PATCH", url, { serialNumber: DELETED });
    expect(res.status).toBe(409);
  });

  it("a MANAGER cannot correct a serial at all (403): the role list did not change", async () => {
    for (const body of [{ serialNumber: 150 }, { serialNumber: DELETED }]) expect((await ctx.call("MANAGER", "PATCH", url, body)).status).toBe(403);
    expect(byId("v_fc_pending")["serial"]).toBe("FC101");
  });
});

describe("reuseDeletedSerial is deprecated: accepted and ignored", () => {
  it("a MANAGER who sends it is NOT refused: the create behaves exactly as without it", async () => {
    for (const flag of [true, false]) {
      const n = flag ? 790 : 791;
      const res = await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(n, { reuseDeletedSerial: flag }));
      expect([flag, res.status]).toEqual([flag, 201]);
    }
    const reused = await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(DELETED, { reuseDeletedSerial: false }));
    expect(reused.status).toBe(201); // false does not forbid reuse either
  });

  it("the flag changes nothing about a clash with an active vehicle", async () => {
    const res = await ctx.call("ADMINISTRATOR", "POST", "/api/v1/vehicles", legacyBody(ACTIVE, { reuseDeletedSerial: true }));
    expect(res.status).toBe(409);
  });

  it("the correction accepts it too, and still ignores it", async () => {
    const free = await ctx.call("ADMINISTRATOR", "PATCH", "/api/v1/vehicles/v_fc_pending/serial", { serialNumber: 151, reuseDeletedSerial: true });
    expect(free.status).toBe(200);
    const taken = await ctx.call("ADMINISTRATOR", "PATCH", "/api/v1/vehicles/v_fc_booked_future/serial", { serialNumber: 151, reuseDeletedSerial: true });
    expect(taken.status).toBe(409);
  });

  it("a wrongly typed value is still a 400 (the field is validated, just not used)", async () => {
    expect((await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(792, { reuseDeletedSerial: "yes" }))).status).toBe(400);
  });
});

describe("the guarded-reuse codes are gone", () => {
  it("no source file mentions SERIAL_PREVIOUSLY_USED or SERIAL_REUSE_NOT_ENABLED, and no answer of the flows above carries a reason", async () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts") && /SERIAL_PREVIOUSLY_USED|SERIAL_REUSE_NOT_ENABLED/.test(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
    const answers = [
      await ctx.call("MANAGER", "POST", "/api/v1/vehicles", legacyBody(ACTIVE)),
      await ctx.call("ADMINISTRATOR", "PATCH", "/api/v1/vehicles/v_fc_pending/serial", { serialNumber: ACTIVE }),
      await ctx.call("ADMINISTRATOR", "PATCH", "/api/v1/vehicles/v_fc_pending/serial", { serialNumber: DELETED }),
    ];
    for (const answer of answers) expect(JSON.stringify(answer.body)).not.toMatch(/"reason"|SERIAL_/);
  });
});

describe("`reason` plumbing (kept for future 409 causes)", () => {
  it("errorBody keeps a reason for CONFLICT and drops it for every other code", () => {
    expect(errorBody("CONFLICT", "m", undefined, "WHY")).toEqual({ error: { code: "CONFLICT", message: "m", reason: "WHY" } });
    for (const code of ["VALIDATION", "FORBIDDEN", "NOT_FOUND", "INTERNAL", "RATE_LIMITED"]) {
      expect(errorBody(code, "m", undefined, "WHY"), code).toEqual({ error: { code, message: "m" } });
    }
    expect(errorBody("CONFLICT", "m")).toEqual({ error: { code: "CONFLICT", message: "m" } });
    expect(new ServiceError("CONFLICT", "m", undefined, "WHY").reason).toBe("WHY");
  });
});

describe("restoring a deleted vehicle (no such path exists today)", () => {
  it("there is no restore or undelete route or service", () => {
    expect(readFileSync("src/routes/vehicles.ts", "utf8")).not.toMatch(/restore|undelete/i);
    expect(readFileSync("src/services/vehicle.service.ts", "utf8")).not.toMatch(/export async function (restore|undelete)/i);
  });

  // DOCUMENTED TODO for the day a restore path is added: restoring a vehicle whose serial is now held by an ACTIVE vehicle must be a
  // 409 (the partial unique index would refuse the UPDATE anyway; the service must turn that into a 409 with fieldErrors.serial).
  it.skip("restoring a vehicle whose serial an active vehicle now holds is a 409 with fieldErrors.serial 'already in use'", () => {
    // 1. delete FC106's holder, create a new FC106 (active), 2. restore the deleted one, 3. expect 409 and the deleted one still deleted.
  });
});
