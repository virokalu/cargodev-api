// Serial numbers against real Postgres: the counter SQL and the unique constraints that are
// the backstop behind the application checks. Sequential behaviour only; the parallel
// behaviour is in serial.concurrency.db.test.ts.

import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { ORG_A, ORG_B, minimalVehicle, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import {
  assignLegacySerial,
  assignNextSerial,
  correctSerialNumber,
  previewNextSerial,
} from "../../src/services/serial.service.js";

const prisma = getTestPrisma();
const counter = async (org: string, prefix: "FC" | "FL") =>
  (await prisma.serialCounter.findUniqueOrThrow({ where: { org_id_prefix: { org_id: org, prefix } } })).lastNumber;

/** What createVehicle does in one transaction: take a serial, then insert the vehicle. */
const createNext = (org: string, prefix: "FC" | "FL" = "FC") =>
  prisma.$transaction(async (tx) => {
    const { serialNumber, serial } = await assignNextSerial(tx, org, prefix);
    await tx.vehicle.create({ data: minimalVehicle(org, serialNumber, { serialPrefix: prefix }) });
    return serial;
  });

beforeEach(async () => {
  await resetDb(prisma);
  await seedTwoOrgs(prisma);
});
afterAll(closeTestPrisma);

describe("assignNextSerial", () => {
  it("hands out 1, 2, 3 and stores the vehicle with that serial", async () => {
    expect([await createNext(ORG_A), await createNext(ORG_A), await createNext(ORG_A)]).toEqual(["FC1", "FC2", "FC3"]);
    expect(await counter(ORG_A, "FC")).toBe(3);
    expect(await prisma.vehicle.count({ where: { org_id: ORG_A } })).toBe(3);
  });

  it("keeps FC and FL counters and the two orgs independent", async () => {
    await createNext(ORG_A, "FC");
    await createNext(ORG_A, "FC");
    await createNext(ORG_A, "FL");
    await createNext(ORG_B, "FC");
    expect([await counter(ORG_A, "FC"), await counter(ORG_A, "FL"), await counter(ORG_B, "FC"), await counter(ORG_B, "FL")]).toEqual([2, 1, 1, 0]);
  });

  it("a failed insert rolls the counter back too, so no serial number is burned", async () => {
    await createNext(ORG_A); // FC1
    await expect(
      prisma.$transaction(async (tx) => {
        const { serialNumber } = await assignNextSerial(tx, ORG_A, "FC");
        await tx.vehicle.create({ data: minimalVehicle(ORG_A, serialNumber) });
        throw new Error("something later in createVehicle failed");
      })
    ).rejects.toThrow("something later");
    expect(await counter(ORG_A, "FC")).toBe(1);
    expect(await createNext(ORG_A)).toBe("FC2"); // no gap
  });

  it("fails when the org has no counter row", async () => {
    await expect(prisma.$transaction((tx) => assignNextSerial(tx, "org_db_test_missing", "FC"))).rejects.toThrow();
  });
});

describe("assignLegacySerial: lastNumber = max(lastNumber, entered)", () => {
  it("bumps the counter when the entered number is higher, so the next new serial continues from it", async () => {
    await prisma.$transaction((tx) => assignLegacySerial(tx, ORG_A, "FC", 250));
    expect(await counter(ORG_A, "FC")).toBe(250);
    expect(await createNext(ORG_A)).toBe("FC251");
  });

  it("never lowers the counter", async () => {
    await prisma.serialCounter.update({ where: { org_id_prefix: { org_id: ORG_A, prefix: "FC" } }, data: { lastNumber: 100 } });
    await prisma.$transaction((tx) => assignLegacySerial(tx, ORG_A, "FC", 40));
    await prisma.$transaction((tx) => assignLegacySerial(tx, ORG_A, "FC", 100)); // equal
    expect(await counter(ORG_A, "FC")).toBe(100);
  });

  it("rejects a serial that already exists, through the application check", async () => {
    await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 40) });
    await expect(prisma.$transaction((tx) => assignLegacySerial(tx, ORG_A, "FC", 40))).rejects.toMatchObject({
      code: "CONFLICT",
      fieldErrors: { legacySerialNumber: "Serial FC40 already exists." },
    });
  });

  it("the same serial in another org is not a conflict", async () => {
    await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 40) });
    await expect(prisma.$transaction((tx) => assignLegacySerial(tx, ORG_B, "FC", 40))).resolves.toMatchObject({ serial: "FC40" });
  });
});

describe("correctSerialNumber", () => {
  it("lets a vehicle keep its own number, bumps up, never down, and refuses another vehicle's number", async () => {
    const own = await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 40) });
    await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 41) });
    await expect(prisma.$transaction((tx) => correctSerialNumber(tx, ORG_A, "FC", 40, own.id))).resolves.toMatchObject({ serial: "FC40" });
    await expect(prisma.$transaction((tx) => correctSerialNumber(tx, ORG_A, "FC", 41, own.id))).rejects.toMatchObject({ code: "CONFLICT" });
    await prisma.$transaction((tx) => correctSerialNumber(tx, ORG_A, "FC", 500, own.id));
    await prisma.$transaction((tx) => correctSerialNumber(tx, ORG_A, "FC", 3, own.id));
    expect(await counter(ORG_A, "FC")).toBe(500);
  });
});

describe("previewNextSerial", () => {
  it("shows the next serial without consuming it", async () => {
    await createNext(ORG_A);
    expect(await previewNextSerial(ORG_A, "FC")).toBe("FC2");
    expect(await previewNextSerial(ORG_A, "FC")).toBe("FC2");
    expect(await counter(ORG_A, "FC")).toBe(1);
    expect(await previewNextSerial(ORG_B, "FC")).toBe("FC1");
    expect(await previewNextSerial("org_db_test_missing", "FL")).toBe("FL1");
  });
});

describe("the database constraints behind the application checks", () => {
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      return e instanceof Prisma.PrismaClientKnownRequestError ? e.code : "other";
    }
  };

  it("rejects a second vehicle with the same serial in the same org (P2002)", async () => {
    await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 7) });
    expect(await code(prisma.vehicle.create({ data: minimalVehicle(ORG_A, 7) }))).toBe("P2002");
  });

  it("rejects the same prefix and number in the same org even if the serial text differs (P2002)", async () => {
    await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 7) });
    expect(await code(prisma.vehicle.create({ data: minimalVehicle(ORG_A, 7, { serial: "FC-7-alt" }) }))).toBe("P2002");
  });

  it("allows the same serial in a different org", async () => {
    await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 7) });
    expect(await code(prisma.vehicle.create({ data: minimalVehicle(ORG_B, 7) }))).toBeNull();
  });

  it("allows FC7 and FL7 together (the prefix is part of the key)", async () => {
    await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 7) });
    expect(await code(prisma.vehicle.create({ data: minimalVehicle(ORG_A, 7, { serialPrefix: "FL" }) }))).toBeNull();
  });

  it("one counter row per org and prefix", async () => {
    expect(await code(prisma.serialCounter.create({ data: { org_id: ORG_A, prefix: "FC", lastNumber: 0 } }))).toBe("P2002");
  });
});
