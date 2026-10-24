import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { actorA, actorB, ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { createCustomer, renameCustomer } from "../src/services/customer.service.js";
import {
  createFreightAgent,
  findOrCreateAuctionHall,
  findOrCreateBrand,
  findOrCreateGrade,
  findOrCreateInspectionBy,
  findOrCreateModel,
  findOrCreatePackingAgent,
  findOrCreateSupplier,
  findOrCreateTransportCompany,
  findOrCreateInspectionCompany,
  findOrCreateVehicleLocation,
  renameAuctionHall,
  renameBrand,
  renameInspectionBy,
  renameInspectionCompany,
  renameModel,
  renamePackingAgent,
  renameSupplier,
  renameTransportCompany,
  renameVehicleLocation,
  updateFreightAgent,
} from "../src/services/lookup.service.js";

let fake: FakePrisma;

beforeEach(() => {
  fake = createFakePrisma();
  state.fake = fake;
  fake.seed("brand", { id: "brand_a1", org_id: ORG_A, name: "Brand A" }, { id: "brand_b1", org_id: ORG_B, name: "Brand B" });
  fake.seed(
    "vehicleModelRef",
    { id: "model_a1", org_id: ORG_A, brand_id: "brand_a1", name: "Model A" },
    { id: "model_b1", org_id: ORG_B, brand_id: "brand_b1", name: "Model B" }
  );
  fake.seed("freightAgent", { id: "fa_a1", org_id: ORG_A, name: "Agent A", offersRoro: true, offersContainer: false });
  fake.seed("user", { id: "cust_a1", org_id: ORG_A, userType: "CUSTOMER", name: "Buyer A" });
});

const logs = () => fake.rows("activityLog");

describe("every lookup create writes exactly one ActivityLog row, scoped to the actor's org", () => {
  const creators = [
    ["Brand", "brand", (n: string) => findOrCreateBrand(actorA, n)],
    ["AuctionHall", "auctionHall", (n: string) => findOrCreateAuctionHall(actorA, n)],
    ["Supplier", "supplier", (n: string) => findOrCreateSupplier(actorA, n)],
    ["TransportCompany", "transportCompany", (n: string) => findOrCreateTransportCompany(actorA, n)],
    ["InspectionCompany", "inspectionCompany", (n: string) => findOrCreateInspectionCompany(actorA, n)],
    ["InspectionBy", "inspectionBy", (n: string) => findOrCreateInspectionBy(actorA, n)],
    ["PackingAgent", "packingAgent", (n: string) => findOrCreatePackingAgent(actorA, n)],
    ["VehicleLocation", "vehicleLocation", (n: string) => findOrCreateVehicleLocation(actorA, n)],
    ["VehicleModelRef", "vehicleModelRef", (n: string) => findOrCreateModel(actorA, "brand_a1", n)],
    ["Grade", "grade", (n: string) => findOrCreateGrade(actorA, "model_a1", n)],
    ["FreightAgent", "freightAgent", (n: string) => createFreightAgent(actorA, n, true, true)],
  ] as const;

  it.each(creators)("%s", async (entity, table, create) => {
    const created = await create("  Brand New  ");
    expect(created.name).toBe("Brand New");
    expect(fake.rows(table).find((r) => r["id"] === created.id)?.["org_id"]).toBe(ORG_A);

    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({
      org_id: ORG_A,
      actorId: actorA.id,
      entity,
      entityId: created.id,
      action: `CREATE_${entity.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`,
      after: expect.objectContaining({ name: "Brand New" }),
    });
  });

  it("takes the org from the acting user, so org B's actor creates in org B", async () => {
    const created = await findOrCreateBrand(actorB, "Only B");
    expect(fake.rows("brand").find((r) => r["id"] === created.id)?.["org_id"]).toBe(ORG_B);
    expect(logs()[0]).toMatchObject({ org_id: ORG_B, actorId: actorB.id });
  });

  it("reusing an existing row writes no log (nothing changed)", async () => {
    expect(await findOrCreateBrand(actorA, "brand a")).toEqual({ id: "brand_a1", name: "Brand A" });
    expect(logs()).toHaveLength(0);
  });
});

describe("every lookup rename logs before and after", () => {
  const renamers = [
    ["Brand", "brand", (id: string) => renameBrand(actorA, id, "Renamed")],
    ["AuctionHall", "auctionHall", (id: string) => renameAuctionHall(actorA, id, "Renamed")],
    ["Supplier", "supplier", (id: string) => renameSupplier(actorA, id, "Renamed")],
    ["TransportCompany", "transportCompany", (id: string) => renameTransportCompany(actorA, id, "Renamed")],
    ["InspectionCompany", "inspectionCompany", (id: string) => renameInspectionCompany(actorA, id, "Renamed")],
    ["InspectionBy", "inspectionBy", (id: string) => renameInspectionBy(actorA, id, "Renamed")],
    ["PackingAgent", "packingAgent", (id: string) => renamePackingAgent(actorA, id, "Renamed")],
    ["VehicleLocation", "vehicleLocation", (id: string) => renameVehicleLocation(actorA, id, "Renamed")],
  ] as const;

  it.each(renamers)("%s", async (entity, table, rename) => {
    fake.seed(table, { id: "row_a", org_id: ORG_A, name: "Original" }, { id: "row_b", org_id: ORG_B, name: "Foreign" });

    expect(await rename("row_a")).toEqual({ id: "row_a", name: "Renamed" });
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toMatchObject({
      org_id: ORG_A,
      actorId: actorA.id,
      entity,
      entityId: "row_a",
      before: { name: "Original" },
      after: { name: "Renamed" },
    });

    // Another org's row: NOT_FOUND, untouched, and no log.
    logs().length = 0;
    await expect(rename("row_b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.rows(table).find((r) => r["id"] === "row_b")?.["name"]).toBe("Foreign");
    expect(logs()).toHaveLength(0);
  });

  it("a conflicting rename writes nothing", async () => {
    fake.seed("brand", { id: "brand_a2", org_id: ORG_A, name: "Taken" });
    await expect(renameBrand(actorA, "brand_a1", "taken")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(logs()).toHaveLength(0);
  });

  it("model and freight agent renames log too", async () => {
    await renameModel(actorA, "model_a1", "Model Renamed");
    await updateFreightAgent(actorA, "fa_a1", "Agent Renamed", false, true);
    expect(logs().map((l) => l["entity"])).toEqual(["VehicleModelRef", "FreightAgent"]);
    expect(logs()[1]).toMatchObject({
      before: { name: "Agent A", offersRoro: true, offersContainer: false },
      after: { name: "Agent Renamed", offersRoro: false, offersContainer: true },
    });
  });
});

describe("a parent id from another org is rejected", () => {
  it("findOrCreateModel under another org's brand is NOT_FOUND and writes nothing", async () => {
    await expect(findOrCreateModel(actorA, "brand_b1", "Sneaky")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Brand not found.",
    });
    expect(fake.rows("vehicleModelRef").map((r) => r["name"])).toEqual(["Model A", "Model B"]);
    expect(logs()).toHaveLength(0);
  });

  it("findOrCreateGrade under another org's model is NOT_FOUND and writes nothing", async () => {
    await expect(findOrCreateGrade(actorA, "model_b1", "Sneaky")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Model not found.",
    });
    expect(fake.rows("grade")).toHaveLength(0);
    expect(logs()).toHaveLength(0);
  });

  it("a missing parent id is NOT_FOUND too", async () => {
    await expect(findOrCreateModel(actorA, "nope", "X")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(findOrCreateGrade(actorA, "nope", "X")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the same parent in the caller's own org works", async () => {
    await expect(findOrCreateModel(actorA, "brand_a1", "Fine")).resolves.toMatchObject({ name: "Fine" });
    await expect(findOrCreateGrade(actorA, "model_a1", "Fine")).resolves.toMatchObject({ name: "Fine" });
  });
});

describe("name validation", () => {
  it("rejects blank and over-long names with a name field error, writing nothing", async () => {
    for (const name of ["", "   ", "x".repeat(151)]) {
      await expect(findOrCreateBrand(actorA, name)).rejects.toMatchObject({
        code: "VALIDATION",
        fieldErrors: { name: expect.any(String) },
      });
      await expect(renameBrand(actorA, "brand_a1", name)).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(createFreightAgent(actorA, name, true, true)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(fake.rows("brand")).toHaveLength(2);
    expect(logs()).toHaveLength(0);
  });

  it("accepts 150 characters", async () => {
    await expect(findOrCreateBrand(actorA, "x".repeat(150))).resolves.toBeDefined();
  });

  it("validates the name before touching the database", async () => {
    await findOrCreateBrand(actorA, "").catch(() => undefined);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("freight agent capability", () => {
  it("still requires RORO or Container, and logs nothing when it fails", async () => {
    await expect(createFreightAgent(actorA, "No Cap", false, false)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateFreightAgent(actorA, "fa_a1", "Agent A", false, false)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(logs()).toHaveLength(0);
  });
});

describe("concurrent create of the same name", () => {
  it("returns the winner's row instead of a 500 when the unique constraint trips", async () => {
    const brand = (fake.client as unknown as { brand: { create: unknown } }).brand;
    brand.create = async () => {
      fake.seed("brand", { id: "brand_winner", org_id: ORG_A, name: "Racer" });
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    };
    expect(await findOrCreateBrand(actorA, "Racer")).toEqual({ id: "brand_winner", name: "Racer" });
  });

  it("any other database error still propagates", async () => {
    const brand = (fake.client as unknown as { brand: { create: unknown } }).brand;
    brand.create = async () => {
      throw new Error("connection lost");
    };
    await expect(findOrCreateBrand(actorA, "Fresh")).rejects.toThrow("connection lost");
  });
});

describe("customer quick-create and rename", () => {
  it("createCustomer creates, logs, and takes the org from the actor", async () => {
    const created = await createCustomer(actorB, "  Quick Buyer ");
    expect(created.name).toBe("Quick Buyer");
    expect(fake.rows("user").find((r) => r["id"] === created.id)).toMatchObject({ org_id: ORG_B, userType: "CUSTOMER" });
    expect(logs()[0]).toMatchObject({ org_id: ORG_B, actorId: actorB.id, action: "CREATE_CUSTOMER", entity: "User" });
  });

  it("createCustomer allows duplicate names (customers can share a name)", async () => {
    await createCustomer(actorA, "Buyer A");
    expect(fake.rows("user").filter((r) => r["name"] === "Buyer A")).toHaveLength(2);
  });

  it("renameCustomer logs before and after and rejects other orgs", async () => {
    await renameCustomer(actorA, "cust_a1", "Buyer Renamed");
    expect(logs()[0]).toMatchObject({
      action: "RENAME_CUSTOMER",
      entityId: "cust_a1",
      before: { name: "Buyer A" },
      after: { name: "Buyer Renamed" },
    });
    await expect(renameCustomer(actorB, "cust_a1", "Hijack")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.rows("user").find((r) => r["id"] === "cust_a1")?.["name"]).toBe("Buyer Renamed");
  });

  it("both reject blank names", async () => {
    await expect(createCustomer(actorA, " ")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(renameCustomer(actorA, "cust_a1", "")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(logs()).toHaveLength(0);
  });
});
