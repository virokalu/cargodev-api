// The PREPARED migration prisma/pending-migrations/20261105130000_lookup_name_case_insensitive_unique, proven on real Postgres without changing the
// database: each check runs the SQL inside a transaction that is ROLLED BACK. On clean data it builds the 12 indexes; with names that differ only by case or
// by surrounding spaces it fails (unique violation) and builds nothing; other organisations, other brands and other models are independent; the old case-sensitive
// uniques are not touched. Fake data only.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { assertSafeTestDatabaseUrl } from "./guard.js";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";

const prisma = getTestPrisma();
const FOLDER = readdirSync(path.join("prisma", "pending-migrations")).find((n) => /_lookup_name_case_insensitive_unique$/.test(n))!;
const SQL = readFileSync(path.join("prisma", "pending-migrations", FOLDER, "migration.sql"), "utf8");
const A = "org_test_a";
const B = "org_test_b";

/** Runs the migration in a transaction and ALWAYS rolls it back. Returns the error code (or null), and the indexes that existed inside. */
async function tryMigration(): Promise<{ code: string | null; indexes: string[] }> {
  const client = new pg.Client({ connectionString: assertSafeTestDatabaseUrl(process.env["TEST_DATABASE_URL"]).url });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(SQL);
      const result = await client.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%_ci_key' ORDER BY 1");
      return { code: null, indexes: result.rows.map((r) => r.indexname) };
    } catch (error) {
      return { code: (error as { code?: string }).code ?? "unknown", indexes: [] };
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}
const indexesNow = async () => (await prisma.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%_ci_key'`).map((r) => r.indexname);

beforeEach(async () => {
  await resetDb(prisma);
  for (const org of [A, B]) await prisma.organization.create({ data: { id: org, name: org } });
});
afterAll(closeTestPrisma);

describe("the prepared case-insensitive unique indexes", () => {
  it("the file creates one unique index per lookup table (12), each starting with org_id and using lower(btrim(name)), and drops nothing", () => {
    const creates = [...SQL.matchAll(/^CREATE UNIQUE INDEX "(\w+)" ON "(\w+)"\(([^;]*)\);$/gm)];
    expect(creates).toHaveLength(12);
    for (const [, name, , cols] of creates) {
      expect(name).toMatch(/_ci_key$/);
      expect(cols).toMatch(/^"org_id", /);
      expect(cols).toMatch(/lower\(btrim\("name"\)\)$/);
    }
    expect(SQL).not.toMatch(/^\s*(DROP|ALTER|DELETE|UPDATE|TRUNCATE)\b/im);
    expect(SQL.split("\n").slice(0, 12).join("\n")).toMatch(/FAILS IF DUPLICATES EXIST/);
  });

  it("on clean data it builds all 12 indexes (rolled back: nothing remains)", async () => {
    const result = await tryMigration();
    expect(result.code).toBeNull();
    expect(result.indexes).toHaveLength(12);
    expect(await indexesNow()).toEqual([]);
  });

  it.each([
    ["different case", "Toyota", "toyota"],
    ["a trailing space", "Toyota", "Toyota "],
    ["a leading space", "Toyota", " Toyota"],
    ["case and spaces together", "Toyota", "  TOYOTA "],
  ])("names that differ only by %s make it FAIL with a unique violation, and nothing is built", async (_label, first, second) => {
    await prisma.brand.createMany({ data: [{ id: "b1", org_id: A, name: first }, { id: "b2", org_id: A, name: second }] });
    const result = await tryMigration();
    expect(result.code).toBe("23505");
    expect(await indexesNow()).toEqual([]);
  });

  it("a duplicate in ANY of the 12 tables stops it (checked on two with different shapes)", async () => {
    await prisma.freightAgent.createMany({ data: [{ id: "f1", org_id: A, name: "Agent", offersRoro: true, offersContainer: true }, { id: "f2", org_id: A, name: "AGENT", offersRoro: true, offersContainer: true }] });
    expect((await tryMigration()).code).toBe("23505");
  });

  it("the same name in ANOTHER organisation is fine", async () => {
    await prisma.brand.createMany({ data: [{ id: "b1", org_id: A, name: "Toyota" }, { id: "b2", org_id: B, name: "toyota" }] });
    expect((await tryMigration()).code).toBeNull();
  });

  it("the same model name under two BRANDS is fine; under one brand it fails", async () => {
    await prisma.brand.createMany({ data: [{ id: "br1", org_id: A, name: "One" }, { id: "br2", org_id: A, name: "Two" }] });
    await prisma.vehicleModelRef.createMany({ data: [{ id: "m1", org_id: A, brand_id: "br1", name: "Corolla" }, { id: "m2", org_id: A, brand_id: "br2", name: "COROLLA" }] });
    expect((await tryMigration()).code).toBeNull();
    await prisma.vehicleModelRef.create({ data: { id: "m3", org_id: A, brand_id: "br1", name: "corolla " } });
    expect((await tryMigration()).code).toBe("23505");
  });

  it("the same grade name under two MODELS is fine; under one model it fails", async () => {
    await prisma.brand.create({ data: { id: "br1", org_id: A, name: "One" } });
    await prisma.vehicleModelRef.createMany({ data: [{ id: "m1", org_id: A, brand_id: "br1", name: "M1" }, { id: "m2", org_id: A, brand_id: "br1", name: "M2" }] });
    await prisma.grade.createMany({ data: [{ id: "g1", org_id: A, model_id: "m1", name: "Base" }, { id: "g2", org_id: A, model_id: "m2", name: "BASE" }] });
    expect((await tryMigration()).code).toBeNull();
    await prisma.grade.create({ data: { id: "g3", org_id: A, model_id: "m1", name: "base" } });
    expect((await tryMigration()).code).toBe("23505");
  });

  it("the existing case-sensitive unique indexes are untouched (still 12, still case-sensitive)", async () => {
    const olds = await prisma.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%\_name\_key' ESCAPE '\'`;
    const before = olds.map((r) => r.indexname).sort();
    expect(before.length).toBeGreaterThanOrEqual(12);
    await tryMigration();
    const after = (await prisma.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%\_name\_key' ESCAPE '\'`).map((r) => r.indexname).sort();
    expect(after).toEqual(before);
    // and the old keys still allow two spellings: that is exactly the gap the new index closes
    await prisma.brand.createMany({ data: [{ id: "b1", org_id: A, name: "Toyota" }, { id: "b2", org_id: A, name: "toyota" }] });
    expect(await prisma.brand.count({ where: { org_id: A } })).toBe(2);
  });
});
