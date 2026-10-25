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

const get = async (url: string, role: Role = "VIEWER", orgId = ORG_A) =>
  app.inject({ method: "GET", url, headers: await bearer(role, orgId) });

const URLS = [
  "/api/v1/vehicles",
  "/api/v1/vehicles/filter-options",
  "/api/v1/vehicles/destinations",
  "/api/v1/vehicles/FC101",
  "/api/v1/vehicles/FC102/status-history",
];

describe.each(URLS)("GET %s", (url) => {
  it("returns 401 without a token and for a forged token, in the error envelope", async () => {
    const none = await app.inject({ method: "GET", url });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } });
    expect(none.headers["cache-control"]).toBe("no-store");

    const forged = await app.inject({ method: "GET", url, headers: { authorization: "Bearer not.a.token" } });
    expect(forged.statusCode).toBe(401);
  });

  it.each(ALL_ROLES)("allows %s, with { data } and no-store", async (role) => {
    const res = await get(url, role);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(["data"]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("GET /vehicles/:serial and /status-history: other org, deleted, unknown", () => {
  it.each(["/api/v1/vehicles/FC900", "/api/v1/vehicles/FC900/status-history"])(
    "%s (a serial that exists only in the other org) is 404, never 403",
    async (url) => {
      const res = await get(url, "ADMINISTRATOR");
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
      expect(res.body).not.toContain("CHASSIS-BBB");
    }
  );

  it.each(["/api/v1/vehicles/FC106", "/api/v1/vehicles/FC106/status-history", "/api/v1/vehicles/FC999", "/api/v1/vehicles/FC999/status-history"])(
    "%s (deleted or unknown) is 404",
    async (url) => {
      expect((await get(url)).statusCode).toBe(404);
    }
  );

  it("an org B token sees org B's vehicle for a serial both orgs use, never org A's", async () => {
    const res = await get("/api/v1/vehicles/FC101", "VIEWER", ORG_B);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe("v_b_fc");
    expect(res.body).not.toContain("CHASSIS-AAA");
  });

  it("returns the detail shape with effective status, track and tri-state intact", async () => {
    const res = await get("/api/v1/vehicles/FC103");
    expect(res.json().data).toMatchObject({
      serial: "FC103", track: "FC", shipmentStatus: "SHIPPED", auctionBillPaid: false, logBook: null,
    });
    expect(res.json().data).not.toHaveProperty("org_id");
  });

  it("status history is ordered and readable", async () => {
    const res = await get("/api/v1/vehicles/FC102/status-history");
    expect(res.json().data.map((h: { id: string }) => h.id)).toEqual(["sh1", "sh2", "sh3", "sh4", "sh5"]);
    expect(res.json().data[1]).toMatchObject({ triggerLabel: "ETD saved", triggeredByName: "Staff Actor A" });
  });
});

describe("GET /vehicles: org scoping and the query string", () => {
  const rows = async (url: string, role: Role = "VIEWER", orgId = ORG_A) =>
    (await get(url, role, orgId)).json().data.rows.map((r: { serial: string }) => r.serial);

  it("lists only the token's org and never deleted vehicles", async () => {
    const a = await rows("/api/v1/vehicles?track=ALL&sort=serial&dir=asc");
    expect(a).toEqual(["FC101", "FC102", "FC103", "FC104", "FC105", "FC107", "FC108", "FC109", "FL201", "FL202"]);
    expect(await rows("/api/v1/vehicles?track=ALL&sort=serial&dir=asc", "VIEWER", ORG_B)).toEqual(["FC101", "FC900"]);
  });

  it("ignores any org id in the query string or headers", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/vehicles?track=ALL&orgId=${ORG_B}&org_id=${ORG_B}`,
      headers: { ...(await bearer("VIEWER")), "x-org-id": ORG_B },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rows.map((r: { id: string }) => r.id)).not.toContain("v_b_fc");
    expect(res.json().data.total).toBe(10);
  });

  it("defaults to the FC track, page 1, 50 per page", async () => {
    const res = await get("/api/v1/vehicles");
    expect(res.json().data).toMatchObject({ page: 1, pageSize: 50, total: 8 });
  });

  it("accepts a single ?status= and repeated ?status= parameters", async () => {
    expect(await rows("/api/v1/vehicles?status=PENDING")).toEqual(["FC101"]);
    expect(await rows("/api/v1/vehicles?status=PENDING&status=SHIPPED&sort=serial&dir=asc")).toEqual(["FC101", "FC103", "FC104"]);
  });

  it("filters and searches through the query string", async () => {
    expect(await rows("/api/v1/vehicles?track=ALL&q=chassis-aaa-2")).toEqual(["FC102"]);
    expect(await rows("/api/v1/vehicles?track=ALL&billPaid=BLANK&sort=serial&dir=asc")).toEqual([
      "FC101", "FC104", "FC105", "FC107", "FC108", "FC109", "FL201", "FL202",
    ]);
    expect(await rows("/api/v1/vehicles?track=ALL&customer=cust_a1&sort=serial&dir=asc")).toEqual(["FC101", "FL201"]);
  });

  it("paginates", async () => {
    const res = await get("/api/v1/vehicles?track=ALL&sort=serial&dir=asc&page=2&pageSize=4");
    expect(res.json().data).toMatchObject({ page: 2, pageSize: 4, total: 10, totalPages: 3 });
    expect(res.json().data.rows.map((r: { serial: string }) => r.serial)).toEqual(["FC105", "FC107", "FC108", "FC109"]);
  });

  it.each([
    ["page=0", "page"],
    ["pageSize=500", "pageSize"],
    ["track=XX", "track"],
    ["sort=nope", "sort"],
    ["dir=sideways", "dir"],
    ["status=NOT_A_STATUS", "status"],
    ["billPaid=MAYBE", "billPaid"],
    ["method=ROAD", "method"],
    ["etdFrom=not-a-date", "etdFrom"],
    ["q=" + "x".repeat(201), "q"],
  ])("rejects %s with 400 and a field error for %s", async (query, field) => {
    const res = await get(`/api/v1/vehicles?${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
    expect(Object.keys(res.json().error.fieldErrors).join(",")).toContain(field);
  });
});

describe("GET /vehicles/filter-options and /destinations", () => {
  it("filter-options returns the fixed sets", async () => {
    const res = await get("/api/v1/vehicles/filter-options");
    expect(res.json().data.tracks.map((t: { value: string }) => t.value)).toEqual(["FC", "FL"]);
    expect(res.json().data.soldCurrencies).toEqual(["JPY", "LKR", "USD"]);
  });

  it("destinations are scoped to the token's org", async () => {
    expect((await get("/api/v1/vehicles/destinations")).json().data).toEqual(["Country One", "Country Two", "Local Town"]);
    expect((await get("/api/v1/vehicles/destinations", "VIEWER", ORG_B)).json().data).toEqual(["Org B Country"]);
  });
});

