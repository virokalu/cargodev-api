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

  it("creating an FC vehicle with an ETD records BOOKING_RECEIVED once, as a system milestone (no person attached)", async () => {
    const created = await createVehicle(actor(), { ...base, etd: "2031-01-01" });
    expect(milestones(created.id)).toMatchObject([{ type: "BOOKING_RECEIVED", recordedById: null, org_id: ORG_A }]);
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

  it("clearing the ETD (back to pending) removes the automatic BOOKING_RECEIVED nobody touched, and logs it; setting it again records it again", async () => {
    const edit = { chassisNo: "CHASSIS-AAA-1", brandId: "brand_a1", modelId: "model_a1" };
    await updateVehicle(actor(), "v_fc_pending", { ...edit, etd: "2031-01-01" });
    await updateVehicle(actor(), "v_fc_pending", edit);
    expect(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!["shipmentStatus"]).toBe("PENDING");
    expect(milestones("v_fc_pending")).toHaveLength(0);
    expect(fake.rows("activityLog").filter((l) => l["action"] === "AUTO_REMOVE_MILESTONE")).toMatchObject([
      { entityId: "v_fc_pending", actorId: "user_a_manager", org_id: ORG_A, before: { type: "BOOKING_RECEIVED" } },
    ]);
    await updateVehicle(actor(), "v_fc_pending", { ...edit, etd: "2031-03-01" });
    expect(milestones("v_fc_pending").map((m) => m["type"])).toEqual(["BOOKING_RECEIVED"]);
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

describe("the removal rule, branch by branch", () => {
  const edit = { chassisNo: "CHASSIS-AAA-1", brandId: "brand_a1", modelId: "model_a1" };
  const removalLogs = () => fake.rows("activityLog").filter((l) => l["action"] === "AUTO_REMOVE_MILESTONE");
  const seedMilestone = (vehicleId: string, type: string, recordedById: string | null) =>
    fake.seed("vehicleMilestone", { id: `m_${vehicleId}_${type}`, org_id: ORG_A, vehicleId, type, occurredAt: new Date("2026-05-01"), recordedById });
  const types = (vehicleId: string) => milestones(vehicleId).map((m) => m["type"]).sort();

  beforeEach(() => {
    fake.seed("user", { id: "user_a_manager", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: false, name: "Test Manager A" });
  });

  it("a milestone a staff member recorded is NEVER removed", async () => {
    await updateVehicle(actor(), "v_fc_pending", { ...edit, etd: "2031-01-01" }); // system BOOKING_RECEIVED
    await setMilestone(actor(), "v_fc_pending", "BOOKING_RECEIVED", { occurredAt: "2026-06-01" }); // a person takes it over
    await updateVehicle(actor(), "v_fc_pending", edit); // ETD cleared
    expect(types("v_fc_pending")).toEqual(["BOOKING_RECEIVED"]);
    expect(milestones("v_fc_pending")[0]!["recordedById"]).toBe("user_a_manager");
    expect(removalLogs()).toHaveLength(0);
  });

  it("a milestone recorded by staff before automation ran stays and automation does not overwrite it", async () => {
    await setMilestone(actor(), "v_fc_pending", "BOOKING_RECEIVED", { occurredAt: "2026-06-01" });
    await updateVehicle(actor(), "v_fc_pending", { ...edit, etd: "2031-01-01" });
    await updateVehicle(actor(), "v_fc_pending", edit);
    expect(milestones("v_fc_pending")).toHaveLength(1);
    expect((milestones("v_fc_pending")[0]!["occurredAt"] as Date).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("reverting SHIPPED (ETD cleared) removes the untouched system SHIPPED and BOOKING_RECEIVED but LEAVES later milestones", async () => {
    // FC104 is SHIPPED with an ETD.
    seedMilestone("v_fc_shipped", "BOOKING_RECEIVED", null);
    seedMilestone("v_fc_shipped", "SHIPPED", null);
    seedMilestone("v_fc_shipped", "BL_ISSUED", "user_a_manager");
    seedMilestone("v_fc_shipped", "ARRIVED", null);
    seedMilestone("v_fc_shipped", "DELIVERED", "user_a_manager");
    await updateVehicle(actor(), "v_fc_shipped", { ...edit, chassisNo: "CHASSIS-AAA-4" });
    expect(fake.rows("vehicle").find((v) => v["id"] === "v_fc_shipped")!["shipmentStatus"]).toBe("PENDING");
    expect(types("v_fc_shipped")).toEqual(["ARRIVED", "BL_ISSUED", "DELIVERED"]);
    expect(removalLogs().map((l) => (l["before"] as { type: string }).type).sort()).toEqual(["BOOKING_RECEIVED", "SHIPPED"]);
  });

  it("reverting SHIPPED keeps a SHIPPED milestone a person recorded, and still removes the untouched BOOKING_RECEIVED", async () => {
    seedMilestone("v_fc_shipped", "BOOKING_RECEIVED", null);
    seedMilestone("v_fc_shipped", "SHIPPED", "user_a_manager");
    await updateVehicle(actor(), "v_fc_shipped", { ...edit, chassisNo: "CHASSIS-AAA-4" });
    expect(types("v_fc_shipped")).toEqual(["SHIPPED"]);
    expect(removalLogs()).toHaveLength(1);
  });

  it("only the statuses actually LEFT are touched: leaving BOOKING_RECEIVED does not remove a SHIPPED milestone", async () => {
    // FC102: BOOKING_RECEIVED with a future ETD. A stray automatic SHIPPED milestone (above the status being left) stays.
    seedMilestone("v_fc_booked_future", "BOOKING_RECEIVED", null);
    seedMilestone("v_fc_booked_future", "SHIPPED", null);
    await updateVehicle(actor(), "v_fc_booked_future", { chassisNo: "CHASSIS-AAA-2", brandId: "brand_a1", modelId: "model_a2" });
    expect(fake.rows("vehicle").find((v) => v["id"] === "v_fc_booked_future")!["shipmentStatus"]).toBe("PENDING");
    expect(types("v_fc_booked_future")).toEqual(["SHIPPED"]);
  });

  it("an edit that does not change the status removes nothing, whatever the milestones are", async () => {
    seedMilestone("v_fc_booked_future", "BOOKING_RECEIVED", null);
    await updateVehicle(actor(), "v_fc_booked_future", { ...edit, chassisNo: "CHASSIS-AAA-2", etd: "2031-05-05" });
    expect(types("v_fc_booked_future")).toEqual(["BOOKING_RECEIVED"]);
    expect(removalLogs()).toHaveLength(0);
  });

  it("nothing is removed from another vehicle or another org", async () => {
    await updateVehicle(actor(), "v_fc_pending", { ...edit, etd: "2031-01-01" });
    seedMilestone("v_fc_booked_future", "BOOKING_RECEIVED", null);
    fake.seed("vehicleMilestone", { id: "m_b", org_id: ORG_B, vehicleId: "v_b_fc", type: "BOOKING_RECEIVED", occurredAt: new Date(), recordedById: null });
    await updateVehicle(actor(), "v_fc_pending", edit);
    expect(milestones().map((m) => `${m["vehicleId"]}:${m["type"]}`).sort()).toEqual(["v_b_fc:BOOKING_RECEIVED", "v_fc_booked_future:BOOKING_RECEIVED"]);
  });

  it("an FL vehicle never goes through the ETD rule: its milestones are untouched by an edit", async () => {
    seedMilestone("v_fl_native", "BOUGHT", null);
    await updateVehicle(actor(), "v_fl_native", { chassisNo: "CHASSIS-LLL-1", brandId: "brand_a1", modelId: "model_a2" });
    expect(types("v_fl_native")).toEqual(["BOUGHT"]);
  });

  it("the edit itself fails (and so removes nothing) for a vehicle of another org", async () => {
    seedMilestone("v_fc_booked_future", "BOOKING_RECEIVED", null);
    await expect(updateVehicle(actor({ orgId: ORG_B }), "v_fc_booked_future", edit)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(types("v_fc_booked_future")).toEqual(["BOOKING_RECEIVED"]);
  });
});
