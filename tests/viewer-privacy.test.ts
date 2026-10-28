// A VIEWER must not see customers' contact details: not in the customer list, not by searching for them, not in the by-customer
// report. Other roles are unchanged. Key sets are asserted exactly. Fake data only.

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { newVehicleFake, vehicleRow } from "./helpers/vehicle-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));

import { buildApp } from "../src/app.js";
import { canSeeCustomerContact } from "../src/config/roles.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const ROLES: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];

let app: FastifyInstance;
let fake: FakePrisma;

const headers = async (role: Role) => ({
  authorization: `Bearer ${await signAccessToken({ sub: `staff_${role}`, orgId: ORG_A, role, name: role, email: null })}`,
});
const get = async (role: Role, url: string) => app.inject({ method: "GET", url, headers: await headers(role) });

/** The rows of the two customers seeded here (the shared vehicle fake seeds a few more). */
const mine = (res: { json: () => { data: Array<{ id: string }> } }) => res.json().data.filter((r) => r.id === "cust_1" || r.id === "cust_2");

const FULL_KEYS = ["address", "country", "createdAt", "email", "id", "name", "phone", "vehicleCount"];
const RESTRICTED_KEYS = ["country", "createdAt", "id", "name", "vehicleCount"];

beforeEach(async () => {
  fake = newVehicleFake();
  state.fake = fake;
  fake.seed(
    "user",
    { id: "cust_1", org_id: ORG_A, userType: "CUSTOMER", name: "Alpha Buyer", email: "alpha.buyer@example.test", phone: "0770000001", country: "LK", address: "1 Example Road", createdAt: new Date("2026-01-01") },
    { id: "cust_2", org_id: ORG_A, userType: "CUSTOMER", name: "Beta Buyer", email: "beta.buyer@example.test", phone: "0770000002", country: "LK", address: null, createdAt: new Date("2026-01-02") },
    { id: "cust_other", org_id: ORG_B, userType: "CUSTOMER", name: "Other Org Buyer", email: "other@example.test", phone: "0770000003", country: null, address: null, createdAt: new Date("2026-01-03") }
  );
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await app.close();
});

describe("the role rule", () => {
  it("only a VIEWER is restricted", () => {
    expect(ROLES.map((r) => [r, canSeeCustomerContact(r)])).toEqual([
      ["ADMINISTRATOR", true],
      ["MANAGER", true],
      ["OPERATOR", true],
      ["VIEWER", false],
    ]);
  });
});

describe("GET /customers", () => {
  it.each(ROLES.filter((r) => r !== "VIEWER"))("%s still gets the full row", async (role) => {
    const res = await get(role, "/api/v1/customers");
    expect(res.statusCode).toBe(200);
    expect(mine(res)).toHaveLength(2);
    for (const row of res.json().data) expect(Object.keys(row).sort()).toEqual(FULL_KEYS);
    expect(mine(res)[0]).toMatchObject({ email: "alpha.buyer@example.test", phone: "0770000001", address: "1 Example Road" });
  });

  it("a VIEWER gets names, country and counts only: the contact keys are not there at all", async () => {
    const res = await get("VIEWER", "/api/v1/customers");
    expect(res.statusCode).toBe(200);
    expect(mine(res)).toHaveLength(2);
    for (const row of res.json().data) expect(Object.keys(row).sort()).toEqual(RESTRICTED_KEYS);
    const text = res.body;
    expect(text).not.toMatch(/example\.test|0770000|Example Road|"email"|"phone"|"address"/);
  });

  it("a VIEWER cannot find a customer by email or phone (a search would otherwise reveal it)", async () => {
    for (const q of ["alpha.buyer", "@example.test", "077000", "0770000002"]) {
      const res = await get("VIEWER", `/api/v1/customers?q=${encodeURIComponent(q)}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data, q).toEqual([]);
    }
    // ...but can still search by name.
    const byName = await get("VIEWER", "/api/v1/customers?q=alpha");
    expect(byName.json().data.map((r: { id: string }) => r.id)).toEqual(["cust_1"]);
  });

  it("other roles can still search by email and phone", async () => {
    for (const q of ["alpha.buyer", "0770000002"]) {
      const res = await get("MANAGER", `/api/v1/customers?q=${encodeURIComponent(q)}`);
      expect(res.json().data.length, q).toBe(1);
    }
  });

  it("another org's customers are never listed, whatever the role", async () => {
    for (const role of ROLES) expect((await get(role, "/api/v1/customers?q=other")).json().data).toEqual([]);
  });
});

describe("GET /customers/search and /customers/:id carry no contact fields for anyone", () => {
  it.each(ROLES)("%s: search returns id and name only", async (role) => {
    const res = await get(role, "/api/v1/customers/search?q=buyer");
    expect(res.statusCode).toBe(200);
    for (const row of res.json().data) expect(Object.keys(row).sort()).toEqual(["id", "name"]);
  });

  it.each(ROLES)("%s: detail returns id and name only", async (role) => {
    const res = await get(role, "/api/v1/customers/cust_1");
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().data).sort()).toEqual(["id", "name"]);
  });
});

describe("GET /reports/by-customer", () => {
  beforeEach(() => {
    fake.seed("vehicle", vehicleRow({ id: "veh_1", org_id: ORG_A, serial: "FC1", customerId: "cust_1" }));
  });

  it.each(ROLES.filter((r) => r !== "VIEWER"))("%s still gets the customer's email and phone", async (role) => {
    const res = await get(role, "/api/v1/reports/by-customer?track=FC");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.customers[0]).toMatchObject({ customerName: "Alpha Buyer", email: "alpha.buyer@example.test", phone: "0770000001" });
  });

  it("a VIEWER gets the group without email or phone (the keys are absent)", async () => {
    const res = await get("VIEWER", "/api/v1/reports/by-customer?track=FC");
    expect(res.statusCode).toBe(200);
    const group = res.json().data.customers[0];
    expect(group.customerName).toBe("Alpha Buyer");
    expect(Object.keys(group).sort()).toEqual(["country", "customerId", "customerName", "statusCounts", "vehicles"]);
    expect(res.body).not.toMatch(/example\.test|0770000/);
  });
});
