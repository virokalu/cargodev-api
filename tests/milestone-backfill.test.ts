import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countByType, planMilestoneBackfill } from "../src/services/milestone-backfill.js";

const d = (s: string) => new Date(s);
const root = path.resolve(import.meta.dirname, "..");

const vehicles = [
  { id: "v1", org_id: "org_a", purchaseDate: d("2026-01-10") },
  { id: "v2", org_id: "org_a", purchaseDate: null },
  { id: "v3", org_id: "org_b", purchaseDate: d("2026-02-01") },
];

describe("planMilestoneBackfill", () => {
  it("plans BOUGHT from the purchase date and the status milestones from the FIRST time the status was entered", () => {
    const planned = planMilestoneBackfill(
      vehicles,
      [
        { vehicleId: "v1", toStatus: "PENDING", createdAt: d("2026-01-10") },
        { vehicleId: "v1", toStatus: "BOOKING_RECEIVED", createdAt: d("2026-03-05") },
        { vehicleId: "v1", toStatus: "PENDING", createdAt: d("2026-03-06") },
        { vehicleId: "v1", toStatus: "BOOKING_RECEIVED", createdAt: d("2026-03-01") },
        { vehicleId: "v1", toStatus: "SHIPPED", createdAt: d("2026-04-01") },
      ],
      new Set()
    );
    const of = (type: string) => planned.find((p) => p.vehicleId === "v1" && p.type === type);
    expect(of("BOUGHT")?.occurredAt).toEqual(d("2026-01-10"));
    expect(of("BOOKING_RECEIVED")?.occurredAt).toEqual(d("2026-03-01"));
    expect(of("SHIPPED")?.occurredAt).toEqual(d("2026-04-01"));
    expect(planned.filter((p) => p.vehicleId === "v1")).toHaveLength(3);
  });

  it("never invents a date: no purchase date and no history means nothing", () => {
    expect(planMilestoneBackfill([vehicles[1]!], [], new Set())).toEqual([]);
    expect(planMilestoneBackfill(vehicles, [], new Set()).map((p) => p.vehicleId).sort()).toEqual(["v1", "v3"]);
  });

  it("plans only the types that are knowable (never bill paid, yard, certificate, B/L, arrived, delivered)", () => {
    const types = new Set(
      planMilestoneBackfill(vehicles, [{ vehicleId: "v1", toStatus: "SHIPPED", createdAt: d("2026-04-01") }], new Set()).map((p) => p.type)
    );
    expect([...types].sort()).toEqual(["BOUGHT", "SHIPPED"]);
  });

  it("is idempotent: milestones that already exist are skipped, so a second run plans nothing", () => {
    const history = [{ vehicleId: "v1", toStatus: "SHIPPED" as const, createdAt: d("2026-04-01") }];
    const first = planMilestoneBackfill(vehicles, history, new Set());
    const existing = new Set(first.map((p) => `${p.vehicleId}:${p.type}`));
    expect(planMilestoneBackfill(vehicles, history, existing)).toEqual([]);
  });

  it("keeps each vehicle's own org", () => {
    const planned = planMilestoneBackfill(vehicles, [], new Set());
    expect(planned.find((p) => p.vehicleId === "v3")?.org_id).toBe("org_b");
  });

  it("countByType returns counts only", () => {
    expect(countByType(planMilestoneBackfill(vehicles, [], new Set()))).toEqual({ BOUGHT: 2 });
  });
});

describe("the backfill script's safety properties", () => {
  const source = readFileSync(path.join(root, "scripts", "backfill-milestones.ts"), "utf8");
  const code = source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("is a dry run unless --apply is passed, and accepts nothing else", () => {
    expect(code).toContain('args.includes("--apply")');
    expect(code).toContain('a !== "--apply"');
    expect(code.indexOf("if (!apply)")).toBeLessThan(code.indexOf("createMany"));
  });

  it("targets MIGRATION_DATABASE_URL only: it never reads DATABASE_URL or DIRECT_URL", () => {
    // The only environment read in the whole script is MIGRATION_DATABASE_URL.
    expect(code.match(/process\.env\[[^\]]*\]/g)).toEqual(['process.env["MIGRATION_DATABASE_URL"]']);
    expect(code).not.toMatch(/process\.env\.|process\.env\)|\{ \.\.\.process\.env/);
    expect(code).toContain("resolveMigrationTarget({ MIGRATION_DATABASE_URL: url })");
  });

  it("prints counts and the target only: no row, name, serial or date is ever logged", () => {
    const logs = code.split("\n").filter((l) => /console\.(log|error)/.test(l)).join("\n");
    expect(logs).not.toMatch(/serial|name|chassis|email|purchaseDate|occurredAt|\.id\b/);
  });

  it("is registered as an npm script", () => {
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts["backfill:milestones"]).toContain("backfill-milestones.ts");
  });
});
