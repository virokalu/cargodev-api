import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, mentionsOrg, type FakePrisma } from "./helpers/fake-prisma.js";
import { actorA, actorB, ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import {
  createCustomer,
  createCustomerFull,
  getCustomerById,
  listCustomers,
  renameCustomer,
  searchCustomers,
  updateCustomer,
} from "../src/services/customer.service.js";

let fake: FakePrisma;

beforeEach(() => {
  fake = createFakePrisma();
  state.fake = fake;
  fake.seed(
    "user",
    { id: "cust_a1", org_id: ORG_A, userType: "CUSTOMER", name: "Alpha Buyer", email: null, phone: null, country: null, address: null },
    { id: "cust_a2", org_id: ORG_A, userType: "CUSTOMER", name: "Another Buyer", email: "x@example.test", phone: null, country: null, address: null },
    { id: "cust_b1", org_id: ORG_B, userType: "CUSTOMER", name: "Beta Buyer", email: null, phone: null, country: null, address: null },
    { id: "staff_a1", org_id: ORG_A, userType: "STAFF", name: "Staff Person", email: null, phone: null, country: null, address: null }
  );
});

describe("getCustomerById", () => {
  it("returns a customer in the caller's org", async () => {
    expect(await getCustomerById(ORG_A, "cust_a1")).toEqual({ id: "cust_a1", name: "Alpha Buyer" });
  });
  it("returns null for another org's customer", async () => {
    expect(await getCustomerById(ORG_A, "cust_b1")).toBeNull();
  });
  it("returns null for a staff id (a staff id is never a customer)", async () => {
    expect(await getCustomerById(ORG_A, "staff_a1")).toBeNull();
  });
});

describe("searchCustomers / listCustomers", () => {
  it("search is case-insensitive and org-scoped", async () => {
    const found = await searchCustomers(ORG_A, "BUYER");
    expect(found.map((c) => c.id).sort()).toEqual(["cust_a1", "cust_a2"]);
    expect(await searchCustomers(ORG_A, "beta")).toEqual([]);
  });
  it("list returns only this org's customers, ordered by name", async () => {
    const rows = await listCustomers(ORG_A, undefined, true);
    expect(rows.map((r) => r.name)).toEqual(["Alpha Buyer", "Another Buyer"]);
  });
  it("list filters by query across name and email", async () => {
    const rows = await listCustomers(ORG_A, "x@example", true);
    expect(rows.map((r) => r.id)).toEqual(["cust_a2"]);
  });
  it("includes org_id in every query", async () => {
    await listCustomers(ORG_A, undefined, true);
    await searchCustomers(ORG_A, "a");
    expect(fake.calls.filter((c) => c.model === "user").every((c) => mentionsOrg(c.args, ORG_A))).toBe(true);
  });
});

describe("createCustomer", () => {
  it("creates a trimmed, login-disabled customer in the given org", async () => {
    const created = await createCustomer(actorA, "  New Buyer  ");
    expect(created.name).toBe("New Buyer");
    expect(fake.rows("user").find((r) => r["id"] === created.id)).toMatchObject({
      org_id: ORG_A,
      userType: "CUSTOMER",
      loginEnabled: false,
    });
  });
});

describe("createCustomerFull", () => {
  it("creates the customer and writes an ActivityLog row in the same transaction", async () => {
    const created = await createCustomerFull(actorA, { name: "Full Buyer", email: "FULL@Example.test" });
    expect(created).toMatchObject({ name: "Full Buyer", email: "full@example.test", vehicleCount: 0 });
    const log = fake.rows("activityLog");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ org_id: ORG_A, actorId: actorA.id, action: "CREATE_CUSTOMER", entity: "User" });
  });
  it("takes the org from the actor", async () => {
    const created = await createCustomerFull(actorB, { name: "Org B Buyer" });
    expect(fake.rows("user").find((r) => r["id"] === created.id)?.["org_id"]).toBe(ORG_B);
  });
  it("rejects a blank name with field errors and writes nothing", async () => {
    const error = await createCustomerFull(actorA, { name: "  " }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION", fieldErrors: { name: "Name is required" } });
    expect(fake.rows("activityLog")).toHaveLength(0);
  });
  it("rejects an invalid email", async () => {
    const error = await createCustomerFull(actorA, { name: "X", email: "not-an-email" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION", fieldErrors: { email: "Enter a valid email address" } });
  });
});

describe("updateCustomer", () => {
  it("updates, and logs before and after", async () => {
    const updated = await updateCustomer(actorA, "cust_a1", { name: "Alpha Renamed", phone: " 123 " });
    expect(updated).toMatchObject({ name: "Alpha Renamed", phone: "123" });
    const log = fake.rows("activityLog")[0];
    expect(log).toMatchObject({ action: "UPDATE_CUSTOMER", before: { name: "Alpha Buyer" } });
  });
  it("returns NOT_FOUND for another org's customer and changes nothing", async () => {
    const error = await updateCustomer(actorA, "cust_b1", { name: "Hijack" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(fake.rows("user").find((r) => r["id"] === "cust_b1")?.["name"]).toBe("Beta Buyer");
    expect(fake.rows("activityLog")).toHaveLength(0);
  });
  it("returns NOT_FOUND when the id is a staff account", async () => {
    await expect(updateCustomer(actorA, "staff_a1", { name: "X" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("returns NOT_FOUND for a missing id", async () => {
    await expect(updateCustomer(actorA, "nope", { name: "X" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("renameCustomer", () => {
  it("renames within the org", async () => {
    expect(await renameCustomer(actorA, "cust_a1", " Renamed ")).toEqual({ id: "cust_a1", name: "Renamed" });
  });
  it("allows a duplicate name (customers can share names)", async () => {
    expect(await renameCustomer(actorA, "cust_a1", "Another Buyer")).toMatchObject({ name: "Another Buyer" });
  });
  it("returns NOT_FOUND for another org's customer", async () => {
    await expect(renameCustomer(actorA, "cust_b1", "X")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.rows("user").find((r) => r["id"] === "cust_b1")?.["name"]).toBe("Beta Buyer");
  });
});
