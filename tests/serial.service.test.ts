import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSerialDb } from "./helpers/fake-serial-db.js";
import { ServiceError } from "../src/lib/errors.js";

const db = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (db.current as ReturnType<typeof createFakeSerialDb>).client,
}));

import {
  assignLegacySerial,
  assignNextSerial,
  correctSerialNumber,
  previewNextSerial,
} from "../src/services/serial.service.js";

const ORG_A = "org_test_a";
const ORG_B = "org_test_b";

let fake: ReturnType<typeof createFakeSerialDb>;

beforeEach(() => {
  fake = createFakeSerialDb();
  db.current = fake;
  fake.seedCounter(ORG_A, "FC", 100);
  fake.seedCounter(ORG_A, "FL", 10);
  fake.seedCounter(ORG_B, "FC", 5);
  fake.seedCounter(ORG_B, "FL", 0);
});

describe("assignNextSerial", () => {
  it("increments the counter and returns the prefixed serial", async () => {
    const result = await assignNextSerial(fake.tx, ORG_A, "FC");
    expect(result).toEqual({ serialNumber: 101, serial: "FC101", reusedFromVehicleId: null });
    expect(fake.lastNumber(ORG_A, "FC")).toBe(101);
  });

  it("keeps FC and FL counters independent", async () => {
    await assignNextSerial(fake.tx, ORG_A, "FL");
    expect(fake.lastNumber(ORG_A, "FL")).toBe(11);
    expect(fake.lastNumber(ORG_A, "FC")).toBe(100);
  });

  it("gives sequential, distinct serials across calls", async () => {
    const first = await assignNextSerial(fake.tx, ORG_A, "FC");
    const second = await assignNextSerial(fake.tx, ORG_A, "FC");
    expect(second.serialNumber).toBe(first.serialNumber + 1);
  });

  it("rejects when the org has no counter row", async () => {
    await expect(assignNextSerial(fake.tx, "org_test_missing", "FC")).rejects.toThrow();
  });
});

describe("assignLegacySerial", () => {
  it("bumps the counter when the entered number is higher", async () => {
    const result = await assignLegacySerial(fake.tx, ORG_A, "FC", 250);
    expect(result).toEqual({ serialNumber: 250, serial: "FC250", reusedFromVehicleId: null });
    expect(fake.lastNumber(ORG_A, "FC")).toBe(250);
    expect((await assignNextSerial(fake.tx, ORG_A, "FC")).serial).toBe("FC251");
  });

  it("back-fills a lower number without touching the counter", async () => {
    const result = await assignLegacySerial(fake.tx, ORG_A, "FC", 40);
    expect(result.serial).toBe("FC40");
    expect(fake.lastNumber(ORG_A, "FC")).toBe(100);
  });

  it("does not bump when the entered number equals the counter", async () => {
    await assignLegacySerial(fake.tx, ORG_A, "FC", 100);
    expect(fake.lastNumber(ORG_A, "FC")).toBe(100);
  });

  it("throws CONFLICT with a field error when the serial exists", async () => {
    fake.seedVehicle(ORG_A, "veh_a1", "FC40");
    const error = await assignLegacySerial(fake.tx, ORG_A, "FC", 40).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({
      code: "CONFLICT",
      fieldErrors: { legacySerialNumber: "Serial FC40 already exists.", serial: "already in use" },
    });
    expect(fake.lastNumber(ORG_A, "FC")).toBe(100);
    expect((error as ServiceError).reason).toBeUndefined(); // a plain conflict: no machine reason
  });

  it("a serial held only by a DELETED vehicle is free: it is assigned, with the id of that vehicle, and a lower number leaves the counter alone", async () => {
    fake.seedVehicle(ORG_A, "veh_gone", "FC41", new Date("2026-10-01T00:00:00Z"));
    const result = await assignLegacySerial(fake.tx, ORG_A, "FC", 41);
    expect(result).toEqual({ serialNumber: 41, serial: "FC41", reusedFromVehicleId: "veh_gone" });
    expect(fake.lastNumber(ORG_A, "FC")).toBe(100); // lastNumber = max(lastNumber, entered)
  });

  it("an ACTIVE vehicle still blocks the serial even when a deleted one also had it", async () => {
    fake.seedVehicle(ORG_A, "veh_old", "FC42", new Date("2026-09-01T00:00:00Z"));
    fake.seedVehicle(ORG_A, "veh_live", "FC42");
    await expect(assignLegacySerial(fake.tx, ORG_A, "FC", 42)).rejects.toMatchObject({ code: "CONFLICT", fieldErrors: { serial: "already in use" } });
  });

  it("with several deleted vehicles the MOST RECENTLY deleted one is named", async () => {
    fake.seedVehicle(ORG_A, "veh_first", "FC43", new Date("2026-08-01T00:00:00Z"));
    fake.seedVehicle(ORG_A, "veh_last", "FC43", new Date("2026-10-01T00:00:00Z"));
    fake.seedVehicle(ORG_A, "veh_mid", "FC43", new Date("2026-09-01T00:00:00Z"));
    expect((await assignLegacySerial(fake.tx, ORG_A, "FC", 43)).reusedFromVehicleId).toBe("veh_last");
  });

  it("another organisation's vehicle with the same serial is not a holder and not a source", async () => {
    fake.seedVehicle("org_other", "veh_b", "FC44");
    fake.seedVehicle("org_other", "veh_b_gone", "FC45", new Date("2026-10-01T00:00:00Z"));
    expect(await assignLegacySerial(fake.tx, ORG_A, "FC", 44)).toMatchObject({ reusedFromVehicleId: null });
    expect(await assignLegacySerial(fake.tx, ORG_A, "FC", 45)).toMatchObject({ reusedFromVehicleId: null });
  });

  it("the automatic number never reuses and says so", async () => {
    expect(await assignNextSerial(fake.tx, ORG_A, "FC")).toEqual({ serialNumber: 101, serial: "FC101", reusedFromVehicleId: null });
  });
});

describe("correctSerialNumber", () => {
  it("allows keeping the vehicle's own current number", async () => {
    fake.seedVehicle(ORG_A, "veh_a1", "FC40");
    const result = await correctSerialNumber(fake.tx, ORG_A, "FC", 40, "veh_a1");
    expect(result.serial).toBe("FC40");
  });

  it("throws CONFLICT when another vehicle holds the number", async () => {
    fake.seedVehicle(ORG_A, "veh_a1", "FC40");
    fake.seedVehicle(ORG_A, "veh_a2", "FC41");
    const error = await correctSerialNumber(fake.tx, ORG_A, "FC", 41, "veh_a1").catch(
      (e: unknown) => e
    );
    expect(error).toMatchObject({
      code: "CONFLICT",
      fieldErrors: { serialNumber: "Serial FC41 already exists.", serial: "already in use" },
    });
  });

  it("a number held only by a deleted vehicle can be corrected to; the deleted vehicle's id comes back", async () => {
    fake.seedVehicle(ORG_A, "veh_a1", "FC40");
    fake.seedVehicle(ORG_A, "veh_gone", "FC46", new Date("2026-10-01T00:00:00Z"));
    expect(await correctSerialNumber(fake.tx, ORG_A, "FC", 46, "veh_a1")).toEqual({ serialNumber: 46, serial: "FC46", reusedFromVehicleId: "veh_gone" });
    expect(fake.lastNumber(ORG_A, "FC")).toBe(100);
  });

  it("the correcting vehicle itself is never its own holder", async () => {
    fake.seedVehicle(ORG_A, "veh_a1", "FC40");
    expect((await correctSerialNumber(fake.tx, ORG_A, "FC", 40, "veh_a1")).reusedFromVehicleId).toBeNull();
  });

  it("bumps the counter up but never down", async () => {
    await correctSerialNumber(fake.tx, ORG_A, "FC", 500, "veh_a1");
    expect(fake.lastNumber(ORG_A, "FC")).toBe(500);
    await correctSerialNumber(fake.tx, ORG_A, "FC", 3, "veh_a1");
    expect(fake.lastNumber(ORG_A, "FC")).toBe(500);
  });
});

describe("previewNextSerial", () => {
  it("returns the next serial without incrementing", async () => {
    expect(await previewNextSerial(ORG_A, "FC")).toBe("FC101");
    expect(await previewNextSerial(ORG_A, "FC")).toBe("FC101");
    expect(fake.lastNumber(ORG_A, "FC")).toBe(100);
  });

  it("starts at 1 when the counter row does not exist", async () => {
    expect(await previewNextSerial("org_test_missing", "FL")).toBe("FL1");
  });
});

describe("org isolation", () => {
  it("assigning in org A never changes org B's counters", async () => {
    await assignNextSerial(fake.tx, ORG_A, "FC");
    await assignLegacySerial(fake.tx, ORG_A, "FL", 900);
    expect(fake.lastNumber(ORG_B, "FC")).toBe(5);
    expect(fake.lastNumber(ORG_B, "FL")).toBe(0);
  });

  it("an org A serial does not block the same serial in org B", async () => {
    fake.seedVehicle(ORG_A, "veh_a1", "FC40");
    const result = await assignLegacySerial(fake.tx, ORG_B, "FC", 40);
    expect(result.serial).toBe("FC40");
  });

  it("correcting in org B ignores org A's vehicles and leaves org A's counter alone", async () => {
    fake.seedVehicle(ORG_A, "veh_a1", "FC7");
    const result = await correctSerialNumber(fake.tx, ORG_B, "FC", 7, "veh_b1");
    expect(result.serial).toBe("FC7");
    expect(fake.lastNumber(ORG_A, "FC")).toBe(100);
  });

  it("preview is scoped to the org", async () => {
    expect(await previewNextSerial(ORG_A, "FC")).toBe("FC101");
    expect(await previewNextSerial(ORG_B, "FC")).toBe("FC6");
  });
});

// Parallel creates giving distinct serials needs real concurrent connections, so it is not
// faked here: see tests/db/serial.concurrency.db.test.ts (run with npm run test:db).
