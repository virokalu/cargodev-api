import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, mentionsOrg, type FakePrisma } from "./helpers/fake-prisma.js";
import { actorA, actorB, ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import {
  createFreightAgent,
  findOrCreateAuctionHall,
  findOrCreateBrand,
  findOrCreateModel,
  getBrandById,
  getFreightAgentById,
  listFreightAgents,
  listRowColourStatuses,
  renameAuctionHall,
  renameBrand,
  renameModel,
  searchBrands,
  searchFreightAgents,
  updateFreightAgent,
} from "../src/services/lookup.service.js";

let fake: FakePrisma;

beforeEach(() => {
  fake = createFakePrisma();
  state.fake = fake;
  fake.seed(
    "brand",
    { id: "brand_a1", org_id: ORG_A, name: "Testbrand" },
    { id: "brand_a2", org_id: ORG_A, name: "Otherbrand" },
    { id: "brand_b1", org_id: ORG_B, name: "Testbrand" }
  );
  fake.seed(
    "vehicleModelRef",
    { id: "model_a1", org_id: ORG_A, brand_id: "brand_a1", name: "Alpha" },
    { id: "model_b1", org_id: ORG_B, brand_id: "brand_b1", name: "Alpha" }
  );
  fake.seed("auctionHall", { id: "hall_a1", org_id: ORG_A, name: "Hall One" }, { id: "hall_b1", org_id: ORG_B, name: "Hall One" });
  fake.seed(
    "freightAgent",
    { id: "fa_a1", org_id: ORG_A, name: "Agent A", offersRoro: true, offersContainer: false },
    { id: "fa_a2", org_id: ORG_A, name: "Agent Both", offersRoro: true, offersContainer: true },
    { id: "fa_b1", org_id: ORG_B, name: "Agent B", offersRoro: true, offersContainer: true }
  );
  fake.seed(
    "rowColourStatus",
    { id: "rc_a1", org_id: ORG_A, name: "Green", colour: "#00ff00", transportCellOnly: false },
    { id: "rc_b1", org_id: ORG_B, name: "Blue", colour: "#0000ff", transportCellOnly: false }
  );
});

describe("brands", () => {
  it("search is case-insensitive, sorted and scoped to the org", async () => {
    expect(await searchBrands(ORG_A, "BRAND")).toEqual([
      { id: "brand_a2", name: "Otherbrand" },
      { id: "brand_a1", name: "Testbrand" },
    ]);
  });

  it("getBrandById returns null for another org's brand", async () => {
    expect(await getBrandById(ORG_A, "brand_b1")).toBeNull();
    expect(await getBrandById(ORG_A, "brand_a1")).toEqual({ id: "brand_a1", name: "Testbrand" });
  });

  it("findOrCreate reuses an existing row regardless of case and whitespace", async () => {
    expect(await findOrCreateBrand(actorA, "  TESTBRAND ")).toEqual({ id: "brand_a1", name: "Testbrand" });
    expect(fake.rows("brand")).toHaveLength(3);
  });

  it("findOrCreate creates a trimmed row in the caller's org only", async () => {
    const created = await findOrCreateBrand(actorA, "  Brand New ");
    expect(created.name).toBe("Brand New");
    expect(fake.rows("brand").find((r) => r["id"] === created.id)?.["org_id"]).toBe(ORG_A);
  });

  it("the same name in two orgs stays two rows (no cross-org reuse)", async () => {
    const inB = await findOrCreateBrand(actorB, "Otherbrand");
    expect(inB.id).not.toBe("brand_a2");
    expect(fake.rows("brand").find((r) => r["id"] === inB.id)?.["org_id"]).toBe(ORG_B);
  });

  it("rename works within the org", async () => {
    expect(await renameBrand(actorA, "brand_a1", " Renamed ")).toEqual({ id: "brand_a1", name: "Renamed" });
  });

  it("rename returns NOT_FOUND for another org's brand and leaves it untouched", async () => {
    await expect(renameBrand(actorA, "brand_b1", "Hijack")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.rows("brand").find((r) => r["id"] === "brand_b1")?.["name"]).toBe("Testbrand");
  });

  it("rename returns NOT_FOUND for a missing id", async () => {
    await expect(renameBrand(actorA, "nope", "X")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rename to an existing name in the same org is a CONFLICT", async () => {
    await expect(renameBrand(actorA, "brand_a1", "otherbrand")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rename to its own name (different case) is allowed", async () => {
    await expect(renameBrand(actorA, "brand_a1", "TESTBRAND")).resolves.toMatchObject({ name: "TESTBRAND" });
  });
});

describe("models", () => {
  it("findOrCreateModel is scoped to brand and org", async () => {
    expect(await findOrCreateModel(actorA, "brand_a1", "alpha")).toEqual({ id: "model_a1", name: "Alpha" });
    const created = await findOrCreateModel(actorA, "brand_a2", "alpha");
    expect(created.id).not.toBe("model_a1");
  });
  it("renameModel returns NOT_FOUND for another org's model", async () => {
    await expect(renameModel(actorA, "model_b1", "X")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("renameModel conflicts only within the same brand", async () => {
    await findOrCreateModel(actorA, "brand_a1", "Beta");
    await expect(renameModel(actorA, "model_a1", "beta")).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("auction halls", () => {
  it("findOrCreate reuses within the org and rename blocks cross-org ids", async () => {
    expect(await findOrCreateAuctionHall(actorA, "hall one")).toEqual({ id: "hall_a1", name: "Hall One" });
    await expect(renameAuctionHall(actorA, "hall_b1", "X")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("freight agents", () => {
  it("lists only this org's agents", async () => {
    expect((await listFreightAgents(ORG_A)).map((a) => a.id)).toEqual(["fa_a1", "fa_a2"]);
  });

  it("search filters by shipping method capability", async () => {
    expect((await searchFreightAgents(ORG_A, "agent", "CONTAINER")).map((a) => a.id)).toEqual(["fa_a2"]);
    expect((await searchFreightAgents(ORG_A, "agent", "RORO")).map((a) => a.id).sort()).toEqual(["fa_a1", "fa_a2"]);
  });

  it("getFreightAgentById returns null for another org's agent", async () => {
    expect(await getFreightAgentById(ORG_A, "fa_b1")).toBeNull();
  });

  it("create rejects an agent with neither RORO nor Container", async () => {
    await expect(createFreightAgent(actorA, "No Capability", false, false)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(fake.rows("freightAgent")).toHaveLength(3);
  });

  it("create reuses an existing agent by name and ignores the new capability flags", async () => {
    const reused = await createFreightAgent(actorA, "agent a", false, true);
    expect(reused).toMatchObject({ id: "fa_a1", offersRoro: true, offersContainer: false });
  });

  it("create makes a new agent with explicit capability in the caller's org", async () => {
    const created = await createFreightAgent(actorA, " New Agent ", false, true);
    expect(created).toMatchObject({ name: "New Agent", offersRoro: false, offersContainer: true });
    expect(fake.rows("freightAgent").find((r) => r["id"] === created.id)?.["org_id"]).toBe(ORG_A);
  });

  it("update returns NOT_FOUND for another org's agent and validates capability first", async () => {
    await expect(updateFreightAgent(actorA, "fa_b1", "X", true, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updateFreightAgent(actorA, "fa_a1", "X", false, false)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("update conflicts on a duplicate name within the org", async () => {
    await expect(updateFreightAgent(actorA, "fa_a1", "agent both", true, true)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("row colour statuses", () => {
  it("lists only this org's statuses", async () => {
    expect((await listRowColourStatuses(ORG_A)).map((r) => r.id)).toEqual(["rc_a1"]);
  });
});

describe("org scoping", () => {
  it("every query includes org_id", async () => {
    await searchBrands(ORG_A, "a");
    await getBrandById(ORG_A, "brand_a1");
    await findOrCreateBrand(actorA, "Zed");
    await listFreightAgents(ORG_A);
    await listRowColourStatuses(ORG_A);
    const reads = fake.calls.filter((c) => c.method.startsWith("find"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => mentionsOrg(c.args, ORG_A))).toBe(true);
  });
});
