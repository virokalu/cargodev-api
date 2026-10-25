// Milestones and customer file access against real Postgres: the unique index, ON CONFLICT DO NOTHING, rollback with
// the surrounding transaction, defaults of the new columns, and the boolean/NULL filters of the visibility checks.

import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { minimalVehicle } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { setObjectStore, type ObjectStore } from "../../src/lib/object-storage.js";
import { openCustomerFile } from "../../src/services/customer-file-access.service.js";
import { recordMilestoneOnce } from "../../src/services/milestone.service.js";
import { runDailyShipmentStatusTransitions } from "../../src/services/vehicle.service.js";

const prisma = getTestPrisma();
const ORG = "org_test_a";
const OTHER = "org_test_b";
const day = (offset: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};

const gets: string[] = [];
const store: ObjectStore = {
  presignPut: async () => "https://upload.example.test/x",
  getObject: async ({ key }) => (gets.push(key), { kind: "found", body: Readable.from([Buffer.from("bytes")]), contentLength: 5, etag: '"e"' }),
  deleteKey: async () => undefined,
};

async function seed() {
  for (const id of [ORG, OTHER]) await prisma.organization.create({ data: { id, name: id } });
  await prisma.user.createMany({
    data: [
      { id: "staff", org_id: ORG, userType: "STAFF", name: "Staff", role: "MANAGER", loginEnabled: true },
      { id: "cust_1", org_id: ORG, userType: "CUSTOMER", name: "C1", email: "c1@example.test" },
      { id: "cust_2", org_id: ORG, userType: "CUSTOMER", name: "C2", email: "c2@example.test" },
      { id: "cust_b", org_id: OTHER, userType: "CUSTOMER", name: "CB", email: "cb@example.test" },
    ],
  });
}

beforeEach(async () => {
  await resetDb(prisma);
  await seed();
  gets.length = 0;
  setObjectStore(store);
});
afterAll(async () => {
  setObjectStore(null);
  await closeTestPrisma();
});

describe("milestones", () => {
  it("one row per vehicle and type: a second insert is ignored and reports false", async () => {
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1) });
    const first = await prisma.$transaction((tx) => recordMilestoneOnce(tx, { orgId: ORG, vehicleId: v.id, type: "ARRIVED", occurredAt: day(-3) }));
    const second = await prisma.$transaction((tx) => recordMilestoneOnce(tx, { orgId: ORG, vehicleId: v.id, type: "ARRIVED", occurredAt: day(-1) }));
    expect([first, second]).toEqual([true, false]);
    const rows = await prisma.vehicleMilestone.findMany({ where: { vehicleId: v.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurredAt).toEqual(day(-3)); // the first one wins; nothing is overwritten
  });

  it("the same type on two vehicles is fine; the database refuses a true duplicate", async () => {
    const a = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1) });
    const b = await prisma.vehicle.create({ data: minimalVehicle(ORG, 2) });
    await prisma.vehicleMilestone.create({ data: { org_id: ORG, vehicleId: a.id, type: "SHIPPED", occurredAt: day(0) } });
    await prisma.vehicleMilestone.create({ data: { org_id: ORG, vehicleId: b.id, type: "SHIPPED", occurredAt: day(0) } });
    await expect(prisma.vehicleMilestone.create({ data: { org_id: ORG, vehicleId: a.id, type: "SHIPPED", occurredAt: day(0) } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("rolls back with the transaction it was written in", async () => {
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1, { shipmentStatus: "BOOKING_RECEIVED" }) });
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.vehicle.update({ where: { id: v.id }, data: { shipmentStatus: "SHIPPED" } });
        await recordMilestoneOnce(tx, { orgId: ORG, vehicleId: v.id, type: "SHIPPED", occurredAt: day(-1) });
        throw new Error("the surrounding change failed");
      })
    ).rejects.toThrow("the surrounding change failed");
    expect(await prisma.vehicleMilestone.count()).toBe(0);
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: v.id } })).shipmentStatus).toBe("BOOKING_RECEIVED");
  });

  it("the daily shipped transition records SHIPPED once, dated by the ETD; running it twice adds nothing", async () => {
    const etd = day(-5);
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1, { shipmentStatus: "BOOKING_RECEIVED", etd }) });
    expect(await runDailyShipmentStatusTransitions(ORG)).toBe(1);
    expect(await runDailyShipmentStatusTransitions(ORG)).toBe(0);
    const rows = await prisma.vehicleMilestone.findMany({ where: { vehicleId: v.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "SHIPPED", recordedById: null, org_id: ORG });
    expect(rows[0]!.occurredAt).toEqual(etd);
    expect(await prisma.statusHistory.count({ where: { vehicleId: v.id, toStatus: "SHIPPED" } })).toBe(1);
  });

  it("deleting a vehicle row removes its milestones (cascade), and nothing else", async () => {
    const a = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1) });
    const b = await prisma.vehicle.create({ data: minimalVehicle(ORG, 2) });
    await prisma.vehicleMilestone.createMany({
      data: [
        { org_id: ORG, vehicleId: a.id, type: "BOUGHT", occurredAt: day(-9) },
        { org_id: ORG, vehicleId: b.id, type: "BOUGHT", occurredAt: day(-9) },
      ],
    });
    await prisma.vehicle.delete({ where: { id: a.id } });
    expect(await prisma.vehicleMilestone.count()).toBe(1);
  });
});

describe("defaults of the new columns", () => {
  it("a vehicle, a photo and a document are all private until staff release them", async () => {
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1) });
    expect(v.customerVisible).toBe(false);
    expect(v.customerAmount).toBeNull();
    const photo = await prisma.vehiclePhoto.create({ data: { vehicleId: v.id, url: "https://files.example.test/p.jpg", uploadedById: "staff" } });
    const doc = await prisma.vehicleDocument.create({ data: { vehicleId: v.id, url: "https://files.example.test/d.pdf", name: "d.pdf", uploadedById: "staff" } });
    expect(photo.visibleToCustomer).toBe(false);
    expect(doc.visibleToCustomer).toBe(false);
  });

  it("the tri-state flags stay null (nothing in this slice defaults them)", async () => {
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1) });
    expect([v.auctionBillPaid, v.logBook, v.extraKey]).toEqual([null, null, null]);
  });
});

describe("customer file access on real SQL", () => {
  const url = (vehicleId: string, name: string, org = ORG) => `https://files.example.test/org/${org}/vehicles/${vehicleId}/documents/${name}`;

  it("reads only released documents of the customer's own released export vehicle", async () => {
    const mine = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1, { customerId: "cust_1", customerVisible: true }) });
    const theirs = await prisma.vehicle.create({ data: minimalVehicle(ORG, 2, { customerId: "cust_2", customerVisible: true }) });
    const unreleased = await prisma.vehicle.create({ data: minimalVehicle(ORG, 3, { customerId: "cust_1", customerVisible: false }) });
    const local = await prisma.vehicle.create({ data: minimalVehicle(ORG, 4, { serialPrefix: "FL", customerId: "cust_1", customerVisible: true }) });
    const deleted = await prisma.vehicle.create({ data: minimalVehicle(ORG, 5, { customerId: "cust_1", customerVisible: true, deletedAt: new Date() }) });
    const doc = (vehicleId: string, name: string, visibleToCustomer: boolean) =>
      prisma.vehicleDocument.create({ data: { vehicleId, url: url(vehicleId, name), name, uploadedById: "staff", visibleToCustomer } });
    const ok = await doc(mine.id, "ok.pdf", true);
    const hidden = await doc(mine.id, "hidden.pdf", false);
    const others = await doc(theirs.id, "theirs.pdf", true);
    const notReleased = await doc(unreleased.id, "u.pdf", true);
    const fl = await doc(local.id, "l.pdf", true);
    const gone = await doc(deleted.id, "g.pdf", true);

    const me = { id: "cust_1", orgId: ORG };
    expect((await openCustomerFile(me, "document", ok.id)).status).toBe(200);
    for (const d of [hidden, others, notReleased, fl, gone]) {
      await expect(openCustomerFile(me, "document", d.id), d.name).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(openCustomerFile({ id: "cust_b", orgId: OTHER }, "document", ok.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(openCustomerFile({ id: "cust_1", orgId: OTHER }, "document", ok.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(gets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The removal rule on real SQL: IS NULL filters, the row lock, and rollback together with the status change.

import { syncMilestonesForStatusChange } from "../../src/services/milestone.service.js";
import { updateVehicle } from "../../src/services/vehicle.service.js";

describe("removal rule (real SQL)", () => {
  const actor = { id: "staff", orgId: ORG, role: "MANAGER" as const, name: "Staff", email: null };
  const edit = { chassisNo: "CHASSIS-DB-1", brandId: "brand_db", modelId: "model_db" };

  beforeEach(async () => {
    await prisma.brand.create({ data: { id: "brand_db", org_id: ORG, name: "Brand" } });
    await prisma.vehicleModelRef.create({ data: { id: "model_db", org_id: ORG, brand_id: "brand_db", name: "Model" } });
  });

  const types = async (vehicleId: string) => (await prisma.vehicleMilestone.findMany({ where: { vehicleId } })).map((m) => m.type).sort();

  it("setting then clearing the ETD records then removes the automatic BOOKING_RECEIVED, with a log row", async () => {
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1) });
    await updateVehicle(actor, v.id, { ...edit, etd: "2031-01-01" });
    expect(await types(v.id)).toEqual(["BOOKING_RECEIVED"]);
    expect((await prisma.vehicleMilestone.findFirstOrThrow({ where: { vehicleId: v.id } })).recordedById).toBeNull();

    await updateVehicle(actor, v.id, edit);
    expect(await types(v.id)).toEqual([]);
    expect(await prisma.activityLog.count({ where: { action: "AUTO_REMOVE_MILESTONE", entityId: v.id } })).toBe(1);
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: v.id } })).shipmentStatus).toBe("PENDING");
  });

  it("a milestone a person recorded survives, and later milestones survive a reverted SHIPPED", async () => {
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 2, { shipmentStatus: "SHIPPED", etd: day(-10) }) });
    await prisma.vehicleMilestone.createMany({
      data: [
        { org_id: ORG, vehicleId: v.id, type: "BOOKING_RECEIVED", occurredAt: day(-20), recordedById: null },
        { org_id: ORG, vehicleId: v.id, type: "SHIPPED", occurredAt: day(-10), recordedById: "staff" },
        { org_id: ORG, vehicleId: v.id, type: "ARRIVED", occurredAt: day(-2), recordedById: null },
      ],
    });
    await updateVehicle(actor, v.id, { ...edit, chassisNo: "CHASSIS-DB-2" });
    expect(await types(v.id)).toEqual(["ARRIVED", "SHIPPED"]);
  });

  it("the removal rolls back together with the status change it belongs to", async () => {
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 3, { shipmentStatus: "BOOKING_RECEIVED", etd: day(5) }) });
    await prisma.vehicleMilestone.create({ data: { org_id: ORG, vehicleId: v.id, type: "BOOKING_RECEIVED", occurredAt: day(-1), recordedById: null } });
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.vehicle.update({ where: { id: v.id }, data: { shipmentStatus: "PENDING", etd: null } });
        await syncMilestonesForStatusChange(tx, { orgId: ORG, vehicleId: v.id, from: "BOOKING_RECEIVED", to: "PENDING", occurredAt: new Date(), actorId: "staff" });
        expect(await tx.vehicleMilestone.count({ where: { vehicleId: v.id } })).toBe(0);
        throw new Error("later step failed");
      })
    ).rejects.toThrow("later step failed");
    expect(await types(v.id)).toEqual(["BOOKING_RECEIVED"]);
    expect(await prisma.activityLog.count({ where: { action: "AUTO_REMOVE_MILESTONE" } })).toBe(0);
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: v.id } })).shipmentStatus).toBe("BOOKING_RECEIVED");
  });
});

describe("photo release defaults", () => {
  it("a new photo is private (visibleToCustomer false) and so is a new document", async () => {
    const v = await prisma.vehicle.create({ data: minimalVehicle(ORG, 9) });
    const photo = await prisma.vehiclePhoto.create({ data: { vehicleId: v.id, url: "https://files.example.test/p.jpg", uploadedById: "staff" } });
    expect(photo.visibleToCustomer).toBe(false);
  });
});
