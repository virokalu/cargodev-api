// The helpers behind `npm run migrate`: the fixed command list, the SQL scan and the Prisma environment.
// Runs in the normal `npm test` (no database needed).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  UnsafeMigrationTargetError,
  buildPrismaEnv,
  parseApprovals,
  analyzeHistory,
  parseMigrateCommand,
  redactConnectionStrings,
  summarizeDiff,
  withReadOnlyOption,
  projectRefFromUrl,
  resolveMigrationTarget,
  scanMigrationSql,
} from "../scripts/migrate-tools.js";

const root = path.resolve(import.meta.dirname, "..");
const HOST = "db.test.example";
const DB = "app_db_example";
const url = (host = HOST, db = DB, extra = "", port = "5432") => `postgresql://tester:example-throwaway@${host}:${port}/${db}${extra}`;

describe("parseMigrateCommand", () => {
  it("accepts the six commands", () => {
    expect(parseMigrateCommand(["create", "add_remarks"])).toEqual({ kind: "create", name: "add_remarks" });
    expect(parseMigrateCommand(["diff-script", "add_remarks"])).toEqual({ kind: "diff-script", name: "add_remarks" });
    expect(parseMigrateCommand(["deploy"])).toEqual({ kind: "deploy" });
    expect(parseMigrateCommand(["status"])).toEqual({ kind: "status" });
    expect(parseMigrateCommand(["drift"])).toEqual({ kind: "drift" });
    expect(parseMigrateCommand(["scan"])).toEqual({ kind: "scan" });
  });

  it.each([
    [["reset"]],
    [["migrate", "reset"]],
    [["db", "push"]],
    [["dev"]],
    [[]],
    [["deploy", "--accept-data-loss"]],
    [["deploy", "--force-reset"]],
    [["status", "--url", "postgresql://x"]],
    [["drift", "--url", "postgresql://x"]],
    [["drift", "extra"]],
    [["create", "add_remarks", "--accept-data-loss"]],
    [["create"]],
    [["create", "Bad Name"]],
    [["create", "../x"]],
    [["create", "x"]],
  ])("refuses %j", (args) => {
    expect(() => parseMigrateCommand(args)).toThrow(UnsafeMigrationTargetError);
  });
});

describe("scanMigrationSql", () => {
  const rules = (sql: string) => scanMigrationSql(sql).map((f) => f.rule);

  it.each([
    ["DROP TABLE", 'DROP TABLE "Old";', "DROP"],
    ["DROP COLUMN", 'ALTER TABLE "Vehicle" DROP COLUMN "x";', "DROP"],
    ["DROP INDEX", 'DROP INDEX "idx";', "DROP"],
    ["type change", 'ALTER TABLE "Vehicle" ALTER COLUMN "yom" TYPE BIGINT;', "ALTER COLUMN TYPE"],
    ["type change (SET DATA TYPE)", 'ALTER TABLE "Vehicle" ALTER COLUMN "yom" SET DATA TYPE BIGINT;', "ALTER COLUMN TYPE"],
    ["rename column", 'ALTER TABLE "Vehicle" RENAME COLUMN "a" TO "b";', "RENAME"],
    ["rename table", 'ALTER TABLE "Vehicle" RENAME TO "V2";', "RENAME"],
    ["truncate", 'TRUNCATE TABLE "Vehicle";', "TRUNCATE"],
    ["delete", 'DELETE FROM "Vehicle" WHERE true;', "DELETE"],
    ["new NOT NULL column without default", 'ALTER TABLE "Vehicle" ADD COLUMN "x" TEXT NOT NULL;', "NOT NULL without DEFAULT (ADD COLUMN)"],
    ["SET NOT NULL", 'ALTER TABLE "Vehicle" ALTER COLUMN "x" SET NOT NULL;', "NOT NULL without DEFAULT (SET NOT NULL)"],
    ["lower case", 'alter table "Vehicle" drop column "x";', "DROP"],
    ["multi-line", 'ALTER TABLE "Vehicle"\n  DROP COLUMN "x";', "DROP"],
  ])("flags %s", (_n, sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it.each([
    ["nullable column", 'ALTER TABLE "Vehicle" ADD COLUMN "x" TEXT;'],
    ["NOT NULL with a default", 'ALTER TABLE "Vehicle" ADD COLUMN "x" TEXT NOT NULL DEFAULT \'a\';'],
    ["added enum value", `ALTER TYPE "ShipmentStatus" ADD VALUE 'ON_HOLD';`],
    ["a new index", 'CREATE INDEX "Vehicle_x_idx" ON "Vehicle"("x");'],
    ["a statement mentioning DROP only in a comment", '-- DROP TABLE x\nALTER TABLE "Vehicle" ADD COLUMN "x" TEXT;'],
    ["a string literal containing the word", `ALTER TABLE "Vehicle" ADD COLUMN "x" TEXT DEFAULT 'DROP me';`.replace("DROP me", "keep")],
  ])("allows %s", (_n, sql) => {
    expect(rules(sql)).toEqual([]);
  });

  it("a second NOT NULL column without a default in the same statement is still caught", () => {
    expect(rules('ALTER TABLE "V" ADD COLUMN "a" TEXT NOT NULL DEFAULT \'x\', ADD COLUMN "b" TEXT NOT NULL;')).toContain(
      "NOT NULL without DEFAULT (ADD COLUMN)"
    );
  });

  describe("every new table needs org_id, an org_id-first index and row level security", () => {
    const table = (name: string, withOrg = true) => `CREATE TABLE "${name}" ("id" TEXT NOT NULL, ${withOrg ? '"org_id" TEXT NOT NULL,' : ""} CONSTRAINT "${name}_pkey" PRIMARY KEY ("id"));`;
    const index = (name: string) => `CREATE INDEX "${name}_org_id_idx" ON "${name}"("org_id", "id");`;
    const rls = (name: string) => `ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY;`;

    it("a complete new table is clean", () => {
      expect(rules([table("Thing"), index("Thing"), rls("Thing")].join("\n"))).toEqual([]);
    });
    it("missing org_id", () => {
      expect(rules([table("Thing", false), rls("Thing")].join("\n"))).toContain('new table "Thing" has no org_id column');
    });
    it("missing index", () => {
      expect(rules([table("Thing"), rls("Thing")].join("\n"))).toContain('new table "Thing" has no index starting with org_id');
    });
    it("an index where org_id is not the first column does not count", () => {
      const sql = [table("Thing"), 'CREATE INDEX "t" ON "Thing"("id", "org_id");', rls("Thing")].join("\n");
      expect(rules(sql)).toContain('new table "Thing" has no index starting with org_id');
    });
    it("missing row level security", () => {
      expect(rules([table("Thing"), index("Thing")].join("\n"))).toContain('new table "Thing" does not ENABLE ROW LEVEL SECURITY');
    });
    it("an index or RLS on a different table does not count", () => {
      const sql = [table("Thing"), table("Other"), index("Other"), rls("Other")].join("\n");
      expect(rules(sql)).toEqual(expect.arrayContaining(['new table "Thing" has no index starting with org_id', 'new table "Thing" does not ENABLE ROW LEVEL SECURITY']));
    });
  });
});

describe("parseApprovals", () => {
  it("reads names, ignoring blanks and comments", () => {
    expect([...parseApprovals("# header\n20260101000000_a  # reviewed\n\n20260102000000_b\r\n")]).toEqual(["20260101000000_a", "20260102000000_b"]);
  });
});

describe("resolveMigrationTarget", () => {
  const u = (host: string, db: string) => `postgresql://tester:example-throwaway@${host}:5432/${db}`;

  it("uses MIGRATION_DATABASE_URL when set", () => {
    expect(resolveMigrationTarget({ MIGRATION_DATABASE_URL: u(HOST, DB), DIRECT_URL: u("other.example", "x") })).toMatchObject({ host: HOST, port: 5432, database: DB });
  });

  it("falls back to DIRECT_URL, never to DATABASE_URL", () => {
    expect(resolveMigrationTarget({ DIRECT_URL: u(HOST, DB), DATABASE_URL: u("runtime.example", "app") })).toMatchObject({ host: HOST, database: DB });
    expect(() => resolveMigrationTarget({ DATABASE_URL: u("runtime.example", "app") })).toThrow(UnsafeMigrationTargetError);
  });

  it("refuses when nothing is set or the value is not a postgres URL, without echoing it", () => {
    expect(() => resolveMigrationTarget({})).toThrow(/MIGRATION_DATABASE_URL or DIRECT_URL/);
    for (const bad of ["not a url example-throwaway", `mysql://tester:example-throwaway@${HOST}/${DB}`]) {
      try {
        resolveMigrationTarget({ MIGRATION_DATABASE_URL: bad });
        throw new Error("should have refused");
      } catch (error) {
        expect((error as Error).message).not.toContain("example-throwaway");
      }
    }
  });
});

describe("the Prisma process environment", () => {
  const target = resolveMigrationTarget({ MIGRATION_DATABASE_URL: `postgresql://tester:example-throwaway@${HOST}:5432/${DB}` });

  it("buildPrismaEnv gives Prisma MIGRATION_DATABASE_URL and removes every other connection setting", () => {
    const child = buildPrismaEnv(
      { DATABASE_URL: "x", DIRECT_URL: "x", TEST_DATABASE_URL: "x", SHADOW_DATABASE_URL: "x", POSTGRES_URL: "x", PGHOST: "x", PGDATABASE: "x", PATH: "/usr/bin" },
      target
    );
    expect(child["MIGRATION_DATABASE_URL"]).toBe(target.url);
    for (const name of ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL", "SHADOW_DATABASE_URL", "POSTGRES_URL", "PGHOST", "PGDATABASE"]) {
      expect(child[name]).toBeUndefined();
    }
    expect(child["PATH"]).toBe("/usr/bin");
  });

  it("there is no root prisma.config.ts for a bare prisma command to pick up", () => {
    expect(existsSync(path.join(root, "prisma.config.ts"))).toBe(false);
  });

  it("the migrate config reads MIGRATION_DATABASE_URL only; unset, its URL is an inert placeholder", async () => {
    const source = readFileSync(path.join(root, "scripts", "prisma.migrate.config.ts"), "utf8");
    const code = source.split(/\r?\n/).filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(code.replace(/MIGRATION_DATABASE_URL/g, "")).not.toMatch(/DATABASE_URL|DIRECT_URL/);
    const saved = { ...process.env };
    try {
      process.env["DATABASE_URL"] = "postgresql://user:password@runtime.example:5432/app";
      process.env["DIRECT_URL"] = "postgresql://user:password@runtime.example:5432/app";
      delete process.env["MIGRATION_DATABASE_URL"];
      vi.resetModules();
      const config = (await import("../scripts/prisma.migrate.config.js")).default;
      expect(String(config.datasource?.url)).not.toContain("runtime.example");
    } finally {
      process.env = saved;
    }
  }, 30_000);
});

describe("projectRefFromUrl (fake refs only)", () => {
  const ref = (u: string) => projectRefFromUrl(new URL(u));

  it("pooler URL: the part of the user name after postgres.", () => {
    expect(ref("postgresql://postgres.fakeprojectref:example-pw@aws-0-region.pooler.example.test:5432/postgres")).toBe("fakeprojectref");
    expect(ref("postgresql://postgres.AbC123:example-pw@aws-0-region.pooler.example.test:6543/postgres")).toBe("abc123");
  });

  it("direct URL: the middle part of db.<ref>.supabase.co", () => {
    expect(ref("postgresql://postgres:example-pw@db.fakeprojectref.supabase.co:5432/postgres")).toBe("fakeprojectref");
  });

  it("anything else has no ref", () => {
    expect(ref("postgresql://tester:example-pw@localhost:5432/app")).toBeNull();
    expect(ref("postgresql://postgres:example-pw@db.example.test:5432/postgres")).toBeNull();
    expect(ref("postgresql://postgres.:example-pw@host.example.test/app")).toBeNull();
    expect(ref("postgresql://postgres:example-pw@db.fake.extra.supabase.co/app")).toBeNull();
  });

  it("resolveMigrationTarget exposes it, and never the password", () => {
    const target = resolveMigrationTarget({ DIRECT_URL: "postgresql://postgres.fakeprojectref:example-pw@aws-0-region.pooler.example.test:5432/postgres" });
    expect(target.projectRef).toBe("fakeprojectref");
    expect(JSON.stringify({ ...target, url: undefined })).not.toContain("example-pw");
  });
});

describe("analyzeHistory: which rows stop deploy", () => {
  const folder = ["001_a", "002_b"];
  const row = (name: string, state: "done" | "unfinished" | "rolledBack") => ({
    name,
    finished: state === "done",
    rolledBack: state === "rolledBack",
  });

  it("a clean history has nothing pending and no stops", () => {
    expect(analyzeHistory([row("001_a", "done"), row("002_b", "done")], folder, true, true)).toEqual({ pending: [], stops: [] });
  });

  it("pending migrations are the folder entries without a finished row", () => {
    expect(analyzeHistory([row("001_a", "done")], folder, true, true).pending).toEqual(["002_b"]);
  });

  it("a rolled-back row is ignored, like Prisma does, even next to a finished row of the same name", () => {
    const result = analyzeHistory([row("001_a", "done"), row("002_b", "rolledBack"), row("002_b", "done")], folder, true, true);
    expect(result).toEqual({ pending: [], stops: [] });
  });

  it("a rolled-back row alone leaves the migration pending, with no stop", () => {
    expect(analyzeHistory([row("001_a", "done"), row("002_b", "rolledBack")], folder, true, true)).toEqual({ pending: ["002_b"], stops: [] });
  });

  it("a row with neither finished nor rolled back STOPS, even if a finished row with the same name exists", () => {
    const result = analyzeHistory([row("001_a", "done"), row("002_b", "unfinished"), row("002_b", "done")], folder, true, true);
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]).toContain("002_b");
  });

  it("an unfinished row alone stops too", () => {
    expect(analyzeHistory([row("001_a", "unfinished")], folder, true, true).stops[0]).toContain("001_a");
  });

  it("a migration the database has but the folder does not stops", () => {
    expect(analyzeHistory([row("001_a", "done"), row("999_x", "done")], folder, true, true).stops[0]).toContain("999_x");
  });

  it("a rolled-back row that is not in the folder does not stop", () => {
    expect(analyzeHistory([row("999_x", "rolledBack"), row("001_a", "done"), row("002_b", "done")], folder, true, true).stops).toEqual([]);
  });

  it("tables present but the history empty or missing stops, and nothing is pending to apply", () => {
    expect(analyzeHistory([], folder, true, true).stops[0]).toContain("maintainer baselines");
    expect(analyzeHistory([], folder, false, true).stops[0]).toContain("maintainer baselines");
  });

  it("an empty database with no tables is not a stop: everything is pending", () => {
    expect(analyzeHistory([], folder, false, false)).toEqual({ pending: folder, stops: [] });
  });
});

describe("drift helpers (fake data only)", () => {
  it("summarizeDiff: an empty migration means no differences", () => {
    expect(summarizeDiff("-- This is an empty migration.\n")).toEqual([]);
    expect(summarizeDiff("")).toEqual([]);
    expect(summarizeDiff("\n\n  \n")).toEqual([]);
  });

  it("summarizeDiff: lists each statement on one line, ignoring comments", () => {
    const script = [
      "-- CreateTable",
      'CREATE TABLE "Widget" (',
      '    "id" TEXT NOT NULL,',
      '    "name" TEXT',
      ");",
      "",
      "-- AlterTable",
      'ALTER TABLE "Vehicle" ADD COLUMN "note" TEXT;',
      "",
      "-- CreateIndex",
      'CREATE INDEX "Widget_name_idx" ON "Widget"("name");',
    ].join("\n");
    expect(summarizeDiff(script)).toEqual([
      'CREATE TABLE "Widget" ( "id" TEXT NOT NULL, "name" TEXT )',
      'ALTER TABLE "Vehicle" ADD COLUMN "note" TEXT',
      'CREATE INDEX "Widget_name_idx" ON "Widget"("name")',
    ]);
  });

  it("summarizeDiff: very long statements are cut", () => {
    const [line] = summarizeDiff(`ALTER TABLE "T" ADD COLUMN "c" TEXT DEFAULT '${"x".repeat(500)}';`);
    expect(line!.length).toBeLessThan(260);
    expect(line!.endsWith("...")).toBe(true);
  });

  it("withReadOnlyOption: asks for a read-only session, keeps the rest, does not touch the original", () => {
    const original = "postgresql://tester:example-pw@db.test.example:5432/app_db_example?sslmode=require";
    const changed = withReadOnlyOption(original);
    const url = new URL(changed);
    expect(url.searchParams.get("options")).toBe("-c default_transaction_read_only=on");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.host).toBe("db.test.example:5432");
    expect(url.pathname).toBe("/app_db_example");
    expect(original).not.toContain("options");
  });

  it("withReadOnlyOption replaces an options value that was already there", () => {
    const url = new URL(withReadOnlyOption("postgresql://u:example-pw@h.example/db?options=-c%20default_transaction_read_only%3Doff"));
    expect(url.searchParams.getAll("options")).toEqual(["-c default_transaction_read_only=on"]);
  });

  it("redactConnectionStrings removes URLs wherever they appear in an error text", () => {
    const text = 'Error: P1001 Can\'t reach postgresql://tester:example-pw@db.test.example:5432/app?x=1 (see "postgres://u:example-pw@h/x") end';
    const cleaned = redactConnectionStrings(text);
    expect(cleaned).not.toContain("example-pw");
    expect(cleaned).not.toContain("db.test.example");
    expect(cleaned).toContain("[connection string removed]");
    expect(cleaned).toContain("P1001");
  });

  it("the drift command code never prints the URL", () => {
    const source = readFileSync(path.join(root, "scripts", "migrate.ts"), "utf8");
    const drift = source.slice(source.indexOf('case "drift"'), source.indexOf('case "create"'));
    expect(drift).not.toMatch(/console\.\w+\([^;]*\burl\b/);
    expect(drift).toContain("redactConnectionStrings");
  });
});
