// Writes that carry org_id in their own where clause, against real Postgres: the SQL behaviour the in-memory fake cannot prove.
// Relation filters inside deleteMany/updateMany (photos and documents are scoped through the vehicle), Prisma's extended unique
// where on update (lookup renames: P2025 when no row of THIS org matches), and rollback of the surrounding transaction.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { minimalVehicle, ORG_A, ORG_B, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { deleteFaq, updateFaq } from "../../src/services/faq.service.js";
import { renameBrand } from "../../src/services/lookup.service.js";
import { setStaffActive } from "../../src/services/user.service.js";
import { setCustomerLoginAccess } from "../../src/services/customer-admin.service.js";

const prisma = getTestPrisma();
const actorA = { id: "staff_a", role: "ADMINISTRATOR" as const, orgId: ORG_A, name: "Administrator", email: null };

beforeEach(async () => {
  await resetDb(prisma);
  await seedTwoOrgs(prisma);
  await prisma.user.createMany({
    data: [
      { id: "staff_a", org_id: ORG_A, userType: "STAFF", name: "Administrator", role: "ADMINISTRATOR", loginEnabled: true, email: "a@example.test" },
      { id: "staff_b", org_id: ORG_B, userType: "STAFF", name: "Other Manager", role: "MANAGER", loginEnabled: true, email: "b@example.test" },
      { id: "cust_b", org_id: ORG_B, userType: "CUSTOMER", name: "Other Buyer", email: "cb@example.test", loginEnabled: false },
    ],
  });
});
afterAll(async () => {
  await closeTestPrisma();
});

describe("photos and documents are scoped through the vehicle (relation filter in a write)", () => {
  async function seedFiles() {
    const vehA = await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 1) });
    const vehB = await prisma.vehicle.create({ data: minimalVehicle(ORG_B, 2) });
    const photoA = await prisma.vehiclePhoto.create({ data: { vehicleId: vehA.id, url: "https://x.example.test/a.jpg", uploadedById: "staff_a" } });
    const photoB = await prisma.vehiclePhoto.create({ data: { vehicleId: vehB.id, url: "https://x.example.test/b.jpg", uploadedById: "staff_b" } });
    const docA = await prisma.vehicleDocument.create({ data: { vehicleId: vehA.id, url: "https://x.example.test/a.pdf", name: "a", documentType: "OTHER", uploadedById: "staff_a" } });
    const docB = await prisma.vehicleDocument.create({ data: { vehicleId: vehB.id, url: "https://x.example.test/b.pdf", name: "b", documentType: "OTHER", uploadedById: "staff_b" } });
    return { vehA, vehB, photoA, photoB, docA, docB };
  }

  it("deleteMany with the vehicle's org_id removes own rows and matches nothing of another org", async () => {
    const s = await seedFiles();
    expect((await prisma.vehiclePhoto.deleteMany({ where: { id: s.photoB.id, vehicleId: s.vehB.id, vehicle: { org_id: ORG_A } } })).count).toBe(0);
    expect((await prisma.vehicleDocument.deleteMany({ where: { id: s.docB.id, vehicleId: s.vehB.id, vehicle: { org_id: ORG_A } } })).count).toBe(0);
    expect(await prisma.vehiclePhoto.count()).toBe(2);
    expect(await prisma.vehicleDocument.count()).toBe(2);

    expect((await prisma.vehiclePhoto.deleteMany({ where: { id: s.photoA.id, vehicleId: s.vehA.id, vehicle: { org_id: ORG_A } } })).count).toBe(1);
    expect((await prisma.vehicleDocument.deleteMany({ where: { id: s.docA.id, vehicleId: s.vehA.id, vehicle: { org_id: ORG_A } } })).count).toBe(1);
    expect(await prisma.vehiclePhoto.count({ where: { id: s.photoB.id } })).toBe(1);
  });

  it("updateMany with the vehicle's org_id (release flags) is scoped the same way", async () => {
    const s = await seedFiles();
    const other = await prisma.vehiclePhoto.updateMany({ where: { id: s.photoB.id, vehicle: { org_id: ORG_A } }, data: { visibleToCustomer: true } });
    expect(other.count).toBe(0);
    expect((await prisma.vehiclePhoto.findUniqueOrThrow({ where: { id: s.photoB.id } })).visibleToCustomer).toBe(false);
    const own = await prisma.vehiclePhoto.updateMany({ where: { id: s.photoA.id, vehicle: { org_id: ORG_A } }, data: { visibleToCustomer: true } });
    expect(own.count).toBe(1);
  });
});

describe("lookup renames: id and org_id together in the unique where", () => {
  it("renames this org's brand", async () => {
    const brand = await prisma.brand.create({ data: { org_id: ORG_A, name: "Toyota" } });
    expect((await renameBrand(actorA, brand.id, "Toyota Motor")).id).toBe(brand.id);
    expect((await prisma.brand.findUniqueOrThrow({ where: { id: brand.id } })).name).toBe("Toyota Motor");
  });

  it("another org's brand is a 404 and stays as it was, with no activity row", async () => {
    const brand = await prisma.brand.create({ data: { org_id: ORG_B, name: "Honda" } });
    await expect(renameBrand(actorA, brand.id, "Hacked")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await prisma.brand.findUniqueOrThrow({ where: { id: brand.id } })).name).toBe("Honda");
    expect(await prisma.activityLog.count()).toBe(0);
  });

  it("the database itself answers P2025 for an id of another org (what the service maps to 404)", async () => {
    const brand = await prisma.brand.create({ data: { org_id: ORG_B, name: "Honda" } });
    await expect(prisma.brand.update({ where: { id: brand.id, org_id: ORG_A }, data: { name: "x" } })).rejects.toMatchObject({ code: "P2025" });
  });
});

describe("accounts and help articles", () => {
  it("setStaffActive: another org's staff is a 404 and stays active", async () => {
    await expect(setStaffActive(actorA, "staff_b", false)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "staff_b" } })).loginEnabled).toBe(true);
    expect(await prisma.activityLog.count()).toBe(0);
  });

  it("setStaffActive on this org's staff works and writes one activity row in the same transaction", async () => {
    await prisma.user.create({ data: { id: "staff_a2", org_id: ORG_A, userType: "STAFF", name: "Second", role: "MANAGER", loginEnabled: true, email: "a2@example.test" } });
    await setStaffActive(actorA, "staff_a2", false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "staff_a2" } })).loginEnabled).toBe(false);
    expect(await prisma.activityLog.count({ where: { action: "DEACTIVATE_STAFF" } })).toBe(1);
  });

  it("setCustomerLoginAccess: another org's customer is a 404 and unchanged", async () => {
    await expect(setCustomerLoginAccess(actorA, "cust_b", { loginEnabled: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "cust_b" } })).loginEnabled).toBe(false);
  });

  it("updateFaq and deleteFaq: another org's article is a 404 and untouched; this org's works", async () => {
    const faqB = await prisma.faq.create({ data: { org_id: ORG_B, question: "keep", answer: "a" } });
    const faqA = await prisma.faq.create({ data: { org_id: ORG_A, question: "mine", answer: "a" } });
    await expect(updateFaq(actorA, faqB.id, { question: "hacked" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteFaq(actorA, faqB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await prisma.faq.findUniqueOrThrow({ where: { id: faqB.id } })).question).toBe("keep");

    expect((await updateFaq(actorA, faqA.id, { question: "mine, edited" })).question).toBe("mine, edited");
    await deleteFaq(actorA, faqA.id);
    expect(await prisma.faq.count({ where: { id: faqA.id } })).toBe(0);
    expect(await prisma.activityLog.count({ where: { action: { in: ["UPDATE_FAQ", "DELETE_FAQ"] } } })).toBe(2);
  });
});
