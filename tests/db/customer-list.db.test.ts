// The staff customer list on real Postgres: `vehicleCount` counts the customer's vehicles that are not soft-deleted
// (the in-memory fake always answers 0 for a count, so only the real database can prove the filter). Fake data only.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { minimalVehicle } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { listCustomers } from "../../src/services/customer.service.js";

const prisma = getTestPrisma();
const ORG = "org_test_a";

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.organization.create({ data: { id: ORG, name: ORG } });
  await prisma.user.createMany({
    data: [
      { id: "cust_1", org_id: ORG, userType: "CUSTOMER", name: "Alpha Buyer", email: "alpha@example.test" },
      { id: "cust_2", org_id: ORG, userType: "CUSTOMER", name: "Beta Buyer", email: "beta@example.test" },
      { id: "cust_3", org_id: ORG, userType: "CUSTOMER", name: "Gamma Buyer", email: "gamma@example.test" },
    ],
  });
  await prisma.vehicle.createMany({
    data: [
      minimalVehicle(ORG, 101, { customerId: "cust_1" }),
      minimalVehicle(ORG, 102, { customerId: "cust_1" }),
      minimalVehicle(ORG, 103, { customerId: "cust_1", deletedAt: new Date("2026-10-01T00:00:00Z") }),
      minimalVehicle(ORG, 104, { customerId: "cust_2", deletedAt: new Date("2026-10-01T00:00:00Z") }),
    ],
  });
});
afterAll(closeTestPrisma);

const counts = async (contact: boolean) => {
  const rows = await listCustomers(ORG, undefined, contact);
  return Object.fromEntries(rows.map((r) => [r.id, r.vehicleCount]));
};

describe("vehicleCount on the customer list", () => {
  it("does not count a soft-deleted vehicle", async () => {
    expect(await counts(true)).toEqual({ cust_1: 2, cust_2: 0, cust_3: 0 });
  });

  it("is the same for a role that may not see contact details", async () => {
    expect(await counts(false)).toEqual({ cust_1: 2, cust_2: 0, cust_3: 0 });
  });

  it("counts a vehicle again only while it is not deleted", async () => {
    await prisma.vehicle.updateMany({ where: { org_id: ORG, serial: "FC102" }, data: { deletedAt: new Date("2026-10-02T00:00:00Z") } });
    expect((await counts(true))["cust_1"]).toBe(1);
    await prisma.vehicle.updateMany({ where: { org_id: ORG, serial: "FC103" }, data: { deletedAt: null } });
    expect((await counts(true))["cust_1"]).toBe(2);
  });
});
