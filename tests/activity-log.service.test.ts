import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, mentionsOrg, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { listActivityLog, listActivityLogFilterOptions, record } from "../src/services/activity-log.service.js";

let fake: FakePrisma;

beforeEach(() => {
  fake = createFakePrisma({ relations: { activityLog: { actor: { model: "user", fk: "actorId" } } } });
  state.fake = fake;
  fake.seed("user", { id: "user_a", name: "Actor A", org_id: ORG_A }, { id: "user_b", name: "Actor B", org_id: ORG_B });
});

const entry = (orgId: string, actorId: string, extra: Record<string, unknown> = {}) => ({
  orgId,
  actorId,
  action: "CREATE_THING",
  entity: "Thing",
  entityId: "thing_1",
  ...extra,
});

describe("record", () => {
  it("writes one row with the org, actor, action and entity", async () => {
    await record(fake.client, entry(ORG_A, "user_a"));
    expect(fake.rows("activityLog")).toHaveLength(1);
    expect(fake.rows("activityLog")[0]).toMatchObject({
      org_id: ORG_A,
      actorId: "user_a",
      action: "CREATE_THING",
      entity: "Thing",
      entityId: "thing_1",
    });
  });

  it("stores before/after only when provided", async () => {
    await record(fake.client, entry(ORG_A, "user_a"));
    await record(fake.client, entry(ORG_A, "user_a", { before: { n: 1 }, after: { n: 2 } }));
    const [bare, full] = fake.rows("activityLog");
    expect(bare).not.toHaveProperty("before");
    expect(bare).not.toHaveProperty("after");
    expect(full).toMatchObject({ before: { n: 1 }, after: { n: 2 } });
  });
});

describe("listActivityLog", () => {
  const params = { page: 1, pageSize: 10 };

  beforeEach(async () => {
    await record(fake.client, entry(ORG_A, "user_a", { action: "CREATE_VEHICLE", entity: "Vehicle" }));
    await record(fake.client, entry(ORG_A, "user_a", { action: "UPDATE_VEHICLE", entity: "Vehicle" }));
    await record(fake.client, entry(ORG_A, "user_a", { action: "CREATE_PHOTO", entity: "VehiclePhoto" }));
    await record(fake.client, entry(ORG_B, "user_b", { action: "CREATE_VEHICLE", entity: "Vehicle" }));
  });

  it("returns only the caller's org rows and resolves the actor name", async () => {
    const result = await listActivityLog(ORG_A, params);
    expect(result.total).toBe(3);
    expect(result.rows.every((r) => r.actorName === "Actor A")).toBe(true);
    expect(result.rows.map((r) => r.actorId)).not.toContain("user_b");
  });

  it("never returns org A rows to org B", async () => {
    const result = await listActivityLog(ORG_B, params);
    expect(result.total).toBe(1);
    expect(result.rows[0]?.actorName).toBe("Actor B");
  });

  it("filters entity exactly, so 'Vehicle' does not match 'VehiclePhoto'", async () => {
    const result = await listActivityLog(ORG_A, { ...params, entity: "vehicle" });
    expect(result.total).toBe(2);
  });

  it("filters action as a partial, case-insensitive match", async () => {
    const result = await listActivityLog(ORG_A, { ...params, action: "create" });
    expect(result.total).toBe(2);
  });

  it("paginates and reports totalPages", async () => {
    const result = await listActivityLog(ORG_A, { page: 2, pageSize: 2 });
    expect(result.rows).toHaveLength(1);
    expect(result).toMatchObject({ total: 3, page: 2, pageSize: 2, totalPages: 2 });
  });

  it("includes org_id in every query it runs", async () => {
    await listActivityLog(ORG_A, params);
    const queries = fake.calls.filter((c) => c.model === "activityLog" && (c.method === "findMany" || c.method === "count"));
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((c) => mentionsOrg(c.args, ORG_A))).toBe(true);
  });
});

describe("listActivityLogFilterOptions", () => {
  it("returns distinct entities and actions for this org only", async () => {
    await record(fake.client, entry(ORG_A, "user_a", { action: "A_ONE", entity: "Alpha" }));
    await record(fake.client, entry(ORG_A, "user_a", { action: "A_ONE", entity: "Alpha" }));
    await record(fake.client, entry(ORG_B, "user_b", { action: "B_ONLY", entity: "Beta" }));
    const options = await listActivityLogFilterOptions(ORG_A);
    expect(options).toEqual({ entities: ["Alpha"], actions: ["A_ONE"] });
  });
});
