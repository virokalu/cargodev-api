// The guard every migration command goes through. Runs in the normal `npm test` (no database needed).

import { describe, expect, it } from "vitest";
import {
  UnsafeMigrationTargetError,
  assertSafeMigrationTarget,
  parseApprovals,
  parseMigrateCommand,
  scanMigrationSql,
} from "../scripts/migrate-guard.js";

const HOST = "db.test.example";
const DB = "cargodev_migration_test";
const url = (host = HOST, db = DB, extra = "", port = "5432") => `postgresql://tester:example-throwaway@${host}:${port}/${db}${extra}`;
const env = (over: Record<string, string | undefined> = {}) => ({
  MIGRATION_DATABASE_URL: url(),
  MIGRATION_ALLOWED_HOST: HOST,
  MIGRATION_ALLOWED_DB: DB,
  ...over,
});
const refuses = (e: Record<string, string | undefined>, message?: RegExp) => {
  expect(() => assertSafeMigrationTarget(e)).toThrow(UnsafeMigrationTargetError);
  if (message) expect(() => assertSafeMigrationTarget(e)).toThrow(message);
};

describe("assertSafeMigrationTarget: allowed", () => {
  it("accepts the designated host and database", () => {
    expect(assertSafeMigrationTarget(env())).toMatchObject({ host: HOST, port: 5432, database: DB });
  });

  it("host comparison ignores case; a custom port is fine", () => {
    expect(() => assertSafeMigrationTarget(env({ MIGRATION_DATABASE_URL: url("DB.Test.Example", DB, "", "5433") }))).not.toThrow();
  });

  it("the local throwaway container works the same way", () => {
    const local = { MIGRATION_DATABASE_URL: url("127.0.0.1", "cargodev_test", "", "55432"), MIGRATION_ALLOWED_HOST: "127.0.0.1", MIGRATION_ALLOWED_DB: "cargodev_test" };
    expect(() => assertSafeMigrationTarget(local)).not.toThrow();
  });

  it("a runtime DATABASE_URL on a different database does not matter", () => {
    expect(() => assertSafeMigrationTarget(env({ DATABASE_URL: url("other.example", "app") }))).not.toThrow();
  });
});

describe("assertSafeMigrationTarget: refused", () => {
  it.each(["MIGRATION_DATABASE_URL", "MIGRATION_ALLOWED_HOST", "MIGRATION_ALLOWED_DB"])("%s not set", (name) => {
    refuses(env({ [name]: undefined }), new RegExp(name));
    refuses(env({ [name]: "  " }), new RegExp(name));
  });

  it("a wrong host", () => {
    refuses(env({ MIGRATION_DATABASE_URL: url("prod.example.net") }), /does not equal MIGRATION_ALLOWED_HOST/);
  });

  it("a host that merely contains the allowed host", () => {
    refuses(env({ MIGRATION_DATABASE_URL: url(`${HOST}.evil.example`) }));
    refuses(env({ MIGRATION_DATABASE_URL: `postgresql://${HOST}:pw@evil.example:5432/${DB}` }));
  });

  it("a wrong database", () => {
    refuses(env({ MIGRATION_DATABASE_URL: url(HOST, "cargodev_prod") }), /does not equal MIGRATION_ALLOWED_DB/);
    refuses(env({ MIGRATION_DATABASE_URL: url(HOST, `${DB}_2`) }));
  });

  it("the same URL as the runtime DATABASE_URL, or DIRECT_URL", () => {
    refuses(env({ DATABASE_URL: url() }), /same database as DATABASE_URL/);
    refuses(env({ DIRECT_URL: url() }), /same database as DIRECT_URL/);
  });

  it("the same server and database as the runtime URL even when the credentials or options differ", () => {
    refuses(env({ DATABASE_URL: `postgresql://app:another-example@${HOST}:5432/${DB}?sslmode=require` }), /same database as DATABASE_URL/);
  });

  it.each([
    ["a pooler port", url(HOST, DB, "", "6543")],
    ["a pooler host name", url("aws-0-region.pooler.example", DB)],
    ["a pgbouncer flag", url(HOST, DB, "?pgbouncer=true")],
  ])("%s", (_n, bad) => {
    const hostForAllow = new URL(bad).hostname;
    refuses(env({ MIGRATION_DATABASE_URL: bad, MIGRATION_ALLOWED_HOST: hostForAllow }), /direct/);
  });

  it.each(["host", "hostaddr", "service", "options"])("a %s= parameter that could redirect the connection", (param) => {
    refuses(env({ MIGRATION_DATABASE_URL: url(HOST, DB, `?${param}=evil.example`) }), /redirect/);
  });

  it.each([
    ["not a URL", "not a url"],
    ["a mysql URL", `mysql://u:p@${HOST}/${DB}`],
  ])("%s", (_n, bad) => {
    refuses(env({ MIGRATION_DATABASE_URL: bad }), /not a valid/);
  });

  it.each(["*", "%", "db.example/", "db.example:5432", "a b"])("a malformed or wildcard allowed host (%s)", (host) => {
    refuses(env({ MIGRATION_ALLOWED_HOST: host }));
  });

  it.each(["postgres", "template1", "my-db", "a*", ""])("a malformed or system allowed database (%s)", (db) => {
    refuses(env({ MIGRATION_ALLOWED_DB: db }));
  });

  it("never puts the connection string or password in a message", () => {
    for (const bad of [
      env({ MIGRATION_DATABASE_URL: url("prod.example.net") }),
      env({ MIGRATION_DATABASE_URL: "garbage example-throwaway" }),
      env({ DATABASE_URL: url() }),
    ]) {
      try {
        assertSafeMigrationTarget(bad);
        throw new Error("should have refused");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain("example-throwaway");
        expect(message).not.toContain("tester:");
        expect(message).not.toContain("@");
      }
    }
  });

  it("does not need DATABASE_URL at all", () => {
    expect(() => assertSafeMigrationTarget(env({ DATABASE_URL: undefined, DIRECT_URL: undefined }))).not.toThrow();
  });
});

describe("parseMigrateCommand", () => {
  it("accepts the five commands", () => {
    expect(parseMigrateCommand(["create", "add_remarks"])).toEqual({ kind: "create", name: "add_remarks" });
    expect(parseMigrateCommand(["diff-script", "add_remarks"])).toEqual({ kind: "diff-script", name: "add_remarks" });
    expect(parseMigrateCommand(["deploy"])).toEqual({ kind: "deploy" });
    expect(parseMigrateCommand(["status"])).toEqual({ kind: "status" });
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
