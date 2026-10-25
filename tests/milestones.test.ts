import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { actor, ORG_A, ORG_B } from "./helpers/fixtures.js";
import { newVehicleFake } from "./helpers/vehicle-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));

import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { recordMilestoneOnce, setMilestone, undoMilestone } from "../src/services/milestone.service.js";
import { createVehicle, runDailyShipmentStatusTransitions, updateVehicle } from "../src/services/vehicle.service.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const ALL_ROLES: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];
const WRITERS: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR"];

let app: FastifyInstance;
let fake: FakePrisma;
const milestones = (vehicleId?: string) => fake.rows("vehicleMilestone").filter((m) => !vehicleId || m["vehicleId"] === vehicleId);

const bearer = async (role: Role, orgId = ORG_A) => ({
  authorization: `Bearer ${await signAccessToken({ sub: "staff_a1", orgId, role, name: `Test ${role}`, email: null })}`,
});
const call = async (method: string, url: string, role: Role | null, body?: unknown, orgId = ORG_A) =>
  app.inject({
    method: method as "GET",
    url: `/api/v1${url}`,
    headers: role ? await bearer(role, orgId) : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });

beforeEach(async () => {
  fake = newVehicleFake();
  state.fake = fake;
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await app.close();
});

describe("milestone routes: access", () => {
  const VEHICLE = "v_fc_pending"; // FC101

  it("401 without a token on every route", async () => {
    expect((await call("GET", "/vehicles/FC101/milestones", null)).statusCode).toBe(401);
    expect((await call("PUT", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, null, {})).statusCode).toBe(401);
    expect((await call("DELETE", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, null)).statusCode).toBe(401);
  });

  it.each(ALL_ROLES)("%s may read the timeline", async (role) => {
    expect((await call("GET", "/vehicles/FC101/milestones", role)).statusCode).toBe(200);
  });

  it("VIEWER cannot record or undo (403); the other three can", async () => {
    expect((await call("PUT", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, "VIEWER", {})).statusCode).toBe(403);
    expect((await call("DELETE", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, "VIEWER")).statusCode).toBe(403);
    for (const role of WRITERS) expect((await call("PUT", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, role, {})).statusCode, role).toBe(200);
  });

  it("another org's, a deleted and an unknown vehicle are 404 on read, record and undo", async () => {
    for (const id of ["v_b_fc", "v_fc_deleted", "nope"]) {
      expect((await call("PUT", `/vehicles/${id}/milestones/BL_ISSUED`, "ADMINISTRATOR", {})).statusCode, id).toBe(404);
      expect((await call("DELETE", `/vehicles/${id}/milestones/BL_ISSUED`, "ADMINISTRATOR")).statusCode, id).toBe(404);
    }
    expect((await call("GET", "/vehicles/FC900/milestones", "ADMINISTRATOR")).statusCode).toBe(404);
    expect(milestones()).toHaveLength(0);
  });

  it("the org comes from the token: an org B admin cannot touch an org A vehicle", async () => {
    expect((await call("PUT", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, "ADMINISTRATOR", {}, ORG_B)).statusCode).toBe(404);
    expect(milestones()).toHaveLength(0);
  });
});

describe("recording and undoing", () => {
  const VEHICLE = "v_fc_pending";

  it("records a milestone with an ActivityLog row, and lists it with who recorded it", async () => {
    const res = await call("PUT", `/vehicles/${VEHICLE}/milestones/AT_EXPORT_YARD`, "MANAGER", { occurredAt: "2026-10-01" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ type: "AT_EXPORT_YARD", occurredAt: "2026-10-01T00:00:00.000Z" });
    expect(fake.rows("activityLog")).toMatchObject([{ action: "SET_MILESTONE", entityId: VEHICLE, org_id: ORG_A }]);
    const list = (await call("GET", "/vehicles/FC101/milestones", "VIEWER")).json().data;
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe("AT_EXPORT_YARD");
  });

  it("recording the same type again moves its date: still one row", async () => {
    await call("PUT", `/vehicles/${VEHICLE}/milestones/ARRIVED`, "MANAGER", { occurredAt: "2026-10-01" });
    await call("PUT", `/vehicles/${VEHICLE}/milestones/ARRIVED`, "MANAGER", { occurredAt: "2026-10-05" });
    expect(milestones(VEHICLE)).toHaveLength(1);
    expect((milestones(VEHICLE)[0]!["occurredAt"] as Date).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(fake.rows("activityLog")).toHaveLength(2);
  });

  it("defaults the date to now", async () => {
    const before = Date.now();
    const res = await call("PUT", `/vehicles/${VEHICLE}/milestones/DELIVERED`, "MANAGER");
    expect(res.statusCode).toBe(200);
    expect(new Date(res.json().data.occurredAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it.each([
    ["an unknown type", "TELEPORTED", {}],
    ["a lower-case type", "shipped", {}],
    ["a future date", "ARRIVED", { occurredAt: "2999-01-01" }],
    ["a nonsense date", "ARRIVED", { occurredAt: "not a date" }],
    ["a very old date", "ARRIVED", { occurredAt: "1970-01-01" }],
    ["an extra field", "ARRIVED", { occurredAt: "2026-10-01", vehicleId: "v_b_fc" }],
    ["an org id in the body", "ARRIVED", { org_id: ORG_B }],
  ])("rejects %s", async (_n, type, body) => {
    const res = await call("PUT", `/vehicles/${VEHICLE}/milestones/${type}`, "ADMINISTRATOR", body);
    expect(res.statusCode).toBe(400);
    expect(milestones()).toHaveLength(0);
  });

  it("undo removes it, logs it, and a second undo is 404", async () => {
    await call("PUT", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, "MANAGER", { occurredAt: "2026-10-01" });
    expect((await call("DELETE", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, "OPERATOR")).statusCode).toBe(200);
    expect(milestones()).toHaveLength(0);
    expect(fake.rows("activityLog").map((l) => l["action"])).toEqual(["SET_MILESTONE", "UNDO_MILESTONE"]);
    expect((await call("DELETE", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, "OPERATOR")).statusCode).toBe(404);
  });

  it("undo only touches the named vehicle and type", async () => {
    await call("PUT", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, "MANAGER", {});
    await call("PUT", `/vehicles/${VEHICLE}/milestones/ARRIVED`, "MANAGER", {});
    await call("PUT", `/vehicles/v_fc_booked_future/milestones/BL_ISSUED`, "MANAGER", {});
    await call("DELETE", `/vehicles/${VEHICLE}/milestones/BL_ISSUED`, "MANAGER");
    expect(milestones().map((m) => `${m["vehicleId"]}:${m["type"]}`).sort()).toEqual(["v_fc_booked_future:BL_ISSUED", `${VEHICLE}:ARRIVED`]);
  });
});

describe("automation records milestones, add-only, in the same transaction", () => {
  const base = { track: "FC", isLegacyEntry: false, chassisNo: "MS-CHASSIS-1", brandId: "brand_a1", modelId: "model_a1" } as const;

  beforeEach(() => {
    fake.seed("serialCounter", { org_id: ORG_A, prefix: "FC", lastNumber: 200 });
    fake.seed("user", { id: "user_a_manager", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: false, name: "Test Manager A" });
  });

  it("creating an FC vehicle with an ETD records BOOKING_RECEIVED once, by the creator", async () => {
    const created = await createVehicle(actor(), { ...base, etd: "2031-01-01" });
    expect(milestones(created.id)).toMatchObject([{ type: "BOOKING_RECEIVED", recordedById: "user_a_manager", org_id: ORG_A }]);
  });

  it("creating a vehicle without an ETD records nothing", async () => {
    const created = await createVehicle(actor(), base);
    expect(milestones(created.id)).toHaveLength(0);
  });

  it("setting an ETD on a pending vehicle records BOOKING_RECEIVED; setting it again later does not add another", async () => {
    const edit = { chassisNo: "CHASSIS-AAA-1", brandId: "brand_a1", modelId: "model_a1" };
    await updateVehicle(actor(), "v_fc_pending", { ...edit, etd: "2031-01-01" });
    expect(milestones("v_fc_pending").map((m) => m["type"])).toEqual(["BOOKING_RECEIVED"]);
    await updateVehicle(actor(), "v_fc_pending", { ...edit, etd: "2031-02-01" });
    expect(milestones("v_fc_pending")).toHaveLength(1);
  });

  it("CLEARING the ETD (back to pending) deletes NO milestone: nothing is removed automatically", async () => {
    const edit = { chassisNo: "CHASSIS-AAA-1", brandId: "brand_a1", modelId: "model_a1" };
    await updateVehicle(actor(), "v_fc_pending", { ...edit, etd: "2031-01-01" });
    await updateVehicle(actor(), "v_fc_pending", edit);
    expect(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!["shipmentStatus"]).toBe("PENDING");
    expect(milestones("v_fc_pending").map((m) => m["type"])).toEqual(["BOOKING_RECEIVED"]);
    // ...and setting the ETD again does not duplicate it.
    await updateVehicle(actor(), "v_fc_pending", { ...edit, etd: "2031-03-01" });
    expect(milestones("v_fc_pending")).toHaveLength(1);
  });

  it("the daily shipped transition records SHIPPED, dated by the ETD, with no person; running again adds nothing", async () => {
    const etd = fake.rows("vehicle").find((v) => v["id"] === "v_fc_booked_past")!["etd"] as Date;
    expect(await runDailyShipmentStatusTransitions(ORG_A)).toBe(1);
    expect(milestones("v_fc_booked_past")).toMatchObject([{ type: "SHIPPED", recordedById: null, org_id: ORG_A }]);
    expect((milestones("v_fc_booked_past")[0]!["occurredAt"] as Date).getTime()).toBe(etd.getTime());
    expect(await runDailyShipmentStatusTransitions(ORG_A)).toBe(0);
    expect(milestones("v_fc_booked_past")).toHaveLength(1);
  });

  it("vehicles that do not transition get nothing (future ETD, cancelled, other org)", async () => {
    await runDailyShipmentStatusTransitions(ORG_A);
    for (const id of ["v_fc_booked_future", "v_fc_cancelled", "v_b_fc"]) expect(milestones(id), id).toHaveLength(0);
  });

  it("a milestone already recorded by staff is not overwritten by automation", async () => {
    await setMilestone(actor(), "v_fc_booked_past", "SHIPPED", { occurredAt: "2026-01-05" });
    await runDailyShipmentStatusTransitions(ORG_A);
    expect(milestones("v_fc_booked_past")).toHaveLength(1);
    expect((milestones("v_fc_booked_past")[0]!["occurredAt"] as Date).toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(milestones("v_fc_booked_past")[0]!["recordedById"]).toBe("user_a_manager");
  });
});

describe("recordMilestoneOnce", () => {
  it("many parallel calls create exactly one row and exactly one of them reports creating it", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        recordMilestoneOnce(fake.client as never, { orgId: ORG_A, vehicleId: "v_fc_pending", type: "ARRIVED", occurredAt: new Date() })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(milestones("v_fc_pending")).toHaveLength(1);
  });

  it("undoMilestone on a missing milestone is NOT_FOUND", async () => {
    await expect(undoMilestone(actor(), "v_fc_pending", "ARRIVED")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
