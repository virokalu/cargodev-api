import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { newVehicleFake } from "./helpers/vehicle-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const ALL_ROLES: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];

let app: FastifyInstance;
let fake: FakePrisma;

const bearer = async (role: Role, orgId = ORG_A) => ({
  authorization: `Bearer ${await signAccessToken({ sub: `user_${role}`, orgId, role, name: `Test ${role}`, email: null })}`,
});

beforeEach(async () => {
  fake = newVehicleFake();
  state.fake = fake;
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await app.close();
});

const call = async (method: string, url: string, role: Role | null, body?: unknown, orgId = ORG_A) =>
  app.inject({
    method: method as "GET",
    url: `/api/v1${url}`,
    headers: role ? await bearer(role, orgId) : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });

const A_MANAGE: Role[] = ["ADMINISTRATOR", "MANAGER"];
const A_QUICK: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR"];

// [method, url, body, roles that may call it]. Ids are a vehicle that exists only in org B, so an allowed
// role never reaches a real write here: the point of this table is the guard, not the service.
const OTHER_ORG_VEHICLE = "v_b_fc";
const WRITES: [string, string, unknown, Role[]][] = [
  ["POST", "/vehicles", {}, A_MANAGE],
  ["PUT", `/vehicles/${OTHER_ORG_VEHICLE}`, {}, A_MANAGE],
  ["DELETE", `/vehicles/${OTHER_ORG_VEHICLE}`, undefined, A_MANAGE],
  ["PATCH", `/vehicles/${OTHER_ORG_VEHICLE}/row-colour`, { rowColourStatusId: null }, A_QUICK],
  ["PATCH", `/vehicles/${OTHER_ORG_VEHICLE}/auction-bill-paid`, { auctionBillPaid: null }, A_QUICK],
  ["POST", `/vehicles/${OTHER_ORG_VEHICLE}/convert-to-export`, { destination: "Country One" }, A_MANAGE],
  ["POST", `/vehicles/${OTHER_ORG_VEHICLE}/revert-to-local`, undefined, A_MANAGE],
  ["POST", `/vehicles/${OTHER_ORG_VEHICLE}/convert-to-local`, undefined, A_MANAGE],
  ["POST", `/vehicles/${OTHER_ORG_VEHICLE}/revert-to-export`, undefined, A_MANAGE],
  ["PATCH", `/vehicles/${OTHER_ORG_VEHICLE}/serial`, { serialNumber: 5000 }, ["ADMINISTRATOR"]],
  ["POST", `/vehicles/${OTHER_ORG_VEHICLE}/photos`, { url: "https://files.example.test/x.jpg" }, A_QUICK],
  ["POST", `/vehicles/${OTHER_ORG_VEHICLE}/photos-added`, { count: 1 }, A_QUICK],
  ["POST", `/vehicles/${OTHER_ORG_VEHICLE}/documents`, { url: "https://files.example.test/x.pdf", name: "x", documentType: "OTHER" }, A_QUICK],
  ["PUT", `/vehicles/${OTHER_ORG_VEHICLE}/auction-sheet`, { url: "https://files.example.test/x.jpg" }, A_QUICK],
  ["DELETE", `/vehicles/${OTHER_ORG_VEHICLE}/photos/p1`, undefined, A_MANAGE],
  ["DELETE", `/vehicles/${OTHER_ORG_VEHICLE}/documents/d1`, undefined, A_MANAGE],
];

describe.each(WRITES)("%s %s", (method, url, body, allowed) => {
  it("is 401 without a token", async () => {
    const res = await call(method, url, null, body);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it.each(ALL_ROLES.filter((r) => !allowed.includes(r)))("is 403 for %s", async (role) => {
    const res = await call(method, url, role, body);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it.each(allowed)("lets %s past the guard", async (role) => {
    const res = await call(method, url, role, body);
    expect([401, 403]).not.toContain(res.statusCode);
  });
});

describe("a vehicle in another org is 404, never 403", () => {
  const targets = WRITES.filter(([, url]) => url.includes(OTHER_ORG_VEHICLE) && !url.endsWith("/serial") || url.endsWith("/serial"));
  it.each(targets.map(([m, u, b]) => [m, u, b] as [string, string, unknown]))("%s %s", async (method, url, body) => {
    const res = await call(method, url, "ADMINISTRATOR", body);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("and the other org's vehicle is untouched", async () => {
    await call("DELETE", `/vehicles/${OTHER_ORG_VEHICLE}`, "ADMINISTRATOR");
    const row = fake.rows("vehicle").find((v) => v["id"] === OTHER_ORG_VEHICLE);
    expect(row?.["deletedAt"]).toBeNull();
  });
});

describe("a soft-deleted or unknown vehicle id is 404 on writes", () => {
  it.each(["v_fc_deleted", "nope"])("%s", async (id) => {
    expect((await call("DELETE", `/vehicles/${id}`, "ADMINISTRATOR")).statusCode).toBe(404);
    expect((await call("PATCH", `/vehicles/${id}/auction-bill-paid`, "ADMINISTRATOR", { auctionBillPaid: true })).statusCode).toBe(404);
  });
});

describe("body validation is a 400 in the envelope", () => {
  it.each([
    ["PATCH", "/vehicles/v_fc_pending/auction-bill-paid", {}],
    ["PATCH", "/vehicles/v_fc_pending/auction-bill-paid", { auctionBillPaid: "yes" }],
    ["PATCH", "/vehicles/v_fc_pending/row-colour", {}],
    ["PATCH", "/vehicles/v_fc_pending/row-colour", { rowColourStatusId: 5 }],
    ["POST", "/vehicles/v_fl_native/convert-to-export", {}],
    ["POST", "/vehicles/v_fl_native/convert-to-export", { destination: "   " }],
    ["PATCH", "/vehicles/v_fc_pending/serial", { serialNumber: 0 }],
    ["PATCH", "/vehicles/v_fc_pending/serial", { serialNumber: 1.5 }],
    ["PATCH", "/vehicles/v_fc_pending/serial", { serialNumber: "7" }],
    ["POST", "/vehicles/v_fc_pending/photos-added", { count: 0 }],
    ["POST", "/vehicles/v_fc_pending/documents", { url: "x", name: "n", documentType: "NOPE" }],
  ])("%s %s %j", async (method, url, body) => {
    const res = await call(method, url, "ADMINISTRATOR", body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("an empty create body lists field errors", async () => {
    const res = await call("POST", "/vehicles", "MANAGER", {});
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().error.fieldErrors ?? {}).length).toBeGreaterThan(0);
  });
});

describe("quick edits", () => {
  it("auction-bill-paid keeps null as null and writes an ActivityLog row", async () => {
    const res = await call("PATCH", "/vehicles/v_fc_booked_future/auction-bill-paid", "OPERATOR", { auctionBillPaid: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { auctionBillPaid: null } });
    const row = fake.rows("vehicle").find((v) => v["id"] === "v_fc_booked_future");
    expect(row?.["auctionBillPaid"]).toBeNull();
    expect(fake.rows("activityLog").map((r) => r["action"])).toContain("UPDATE_VEHICLE_AUCTION_BILL_PAID");
  });

  it("row-colour refuses a status from another org (400) and changes nothing", async () => {
    const res = await call("PATCH", "/vehicles/v_fc_pending/row-colour", "MANAGER", { rowColourStatusId: "rc_b_cancel" });
    expect(res.statusCode).toBe(400);
    const row = fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending");
    expect(row?.["rowColourStatusId"]).toBeNull();
  });

  it("row-colour accepts one of this org's statuses and clears with null", async () => {
    expect((await call("PATCH", "/vehicles/v_fc_pending/row-colour", "MANAGER", { rowColourStatusId: "rc_done" })).statusCode).toBe(200);
    expect(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")?.["rowColourStatusId"]).toBe("rc_done");
    expect((await call("PATCH", "/vehicles/v_fc_pending/row-colour", "MANAGER", { rowColourStatusId: null })).statusCode).toBe(200);
    expect(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")?.["rowColourStatusId"]).toBeNull();
  });
});

describe("delete is a soft delete", () => {
  it("sets deletedAt, logs it, and the vehicle disappears from reads", async () => {
    const res = await call("DELETE", "/vehicles/v_fc_pending", "MANAGER");
    expect(res.statusCode).toBe(200);
    const row = fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending");
    expect(row?.["deletedAt"]).toBeInstanceOf(Date);
    expect(fake.rows("activityLog").map((r) => r["action"])).toContain("DELETE_VEHICLE");
    expect((await call("GET", "/vehicles/FC101", "VIEWER")).statusCode).toBe(404);
  });
});

describe("check-chassis and next-serial", () => {
  it.each(ALL_ROLES)("%s may check a chassis number", async (role) => {
    const res = await call("GET", "/vehicles/check-chassis?chassisNo=chassis-aaa-1", role);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { duplicate: true } });
  });

  it("does not see the other org's chassis numbers", async () => {
    const res = await call("GET", "/vehicles/check-chassis?chassisNo=CHASSIS-BBB-1", "VIEWER");
    expect(res.json()).toEqual({ data: { duplicate: false } });
  });

  it("requires chassisNo and a token", async () => {
    expect((await call("GET", "/vehicles/check-chassis", "VIEWER")).statusCode).toBe(400);
    expect((await call("GET", "/vehicles/check-chassis?chassisNo=x", null)).statusCode).toBe(401);
  });

  it("next-serial validates the track and needs a token", async () => {
    expect((await call("GET", "/vehicles/next-serial?track=XX", "VIEWER")).statusCode).toBe(400);
    expect((await call("GET", "/vehicles/next-serial", "VIEWER")).statusCode).toBe(400);
    expect((await call("GET", "/vehicles/next-serial?track=FC", null)).statusCode).toBe(401);
    const ok = await call("GET", "/vehicles/next-serial?track=FC", "VIEWER");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.serial).toMatch(/^FC\d+$/);
  });
});

describe("file reads", () => {
  it.each(["/vehicles/FC101/files", "/vehicles/FC101/pdf-images"])("%s: 401 without a token, 200 for every role", async (url) => {
    expect((await call("GET", url, null)).statusCode).toBe(401);
    for (const role of ALL_ROLES) expect((await call("GET", url, role)).statusCode).toBe(200);
  });

  it.each(["/vehicles/FC900/files", "/vehicles/FC900/pdf-images", "/vehicles/FC106/files"])(
    "%s (other org or deleted) is 404",
    async (url) => {
      expect((await call("GET", url, "ADMINISTRATOR")).statusCode).toBe(404);
    }
  );
});

describe("the org comes from the token, not the request", () => {
  it("an org B token cannot delete an org A vehicle by id", async () => {
    const res = await call("DELETE", "/vehicles/v_fc_pending", "ADMINISTRATOR", undefined, ORG_B);
    expect(res.statusCode).toBe(404);
    expect(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")?.["deletedAt"]).toBeNull();
  });
});
