// The only way to run a migration command in this repo:   npm run migrate -- <command>
//
//   create <name>       generate a migration from schema.prisma WITHOUT applying it (migrate dev --create-only)
//   diff-script <name>  same, without a shadow database: diffs the test DB against schema.prisma (read-only)
//   scan                print the SQL of every migration and scan it for unsafe changes
//   deploy              scan, then apply pending migrations to the designated test DB
//   status              show which migrations are applied
//
// Every command runs the guard (scripts/migrate-guard.ts) first. There is no way to pass raw flags to
// Prisma, so reset, db push, --force-reset and --accept-data-loss cannot be used from here.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import pg from "pg";
import {
  UnsafeMigrationTargetError,
  assertSafeMigrationTarget,
  buildPrismaEnv,
  parseApprovals,
  parseMigrateCommand,
  scanMigrationSql,
  type MigrationTarget,
} from "./migrate-guard.js";

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const config = path.join("scripts", "prisma.migrate.config.ts");
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");

function runPrisma(args: string[], target: MigrationTarget, capture = false) {
  // The child sees MIGRATION_DATABASE_URL only. The runtime connection strings are removed.
  const env = buildPrismaEnv(process.env, target);
  return spawnSync(process.execPath, [prismaCli, ...args, "--config", config], {
    cwd: root,
    env,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
}

function migrationNames(): string[] {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(migrationsDir, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();
}

function approvals(): Set<string> {
  const file = path.join(migrationsDir, "scan-approved.txt");
  return existsSync(file) ? parseApprovals(readFileSync(file, "utf8")) : new Set();
}

/** Prints the SQL and the scan result. Returns the migrations with unapproved findings. */
function scan(names: string[], printSql: boolean): string[] {
  const approved = approvals();
  const blocked: string[] = [];
  for (const name of names) {
    const sql = readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
    console.log(`\n=== ${name} ===`);
    if (printSql) console.log(sql);
    const findings = scanMigrationSql(sql);
    if (findings.length === 0) {
      console.log("SCAN: clean (no DROP, ALTER COLUMN TYPE, RENAME, TRUNCATE, DELETE, NOT NULL without DEFAULT; new tables have org_id, index and RLS).");
      continue;
    }
    for (const f of findings) console.log(`SCAN: ${f.rule}\n      ${f.statement}`);
    if (approved.has(name)) {
      console.log(`SCAN: findings above are approved in prisma/migrations/scan-approved.txt.`);
    } else {
      blocked.push(name);
    }
  }
  return blocked;
}

async function appliedMigrations(target: MigrationTarget): Promise<Set<string>> {
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  try {
    const exists = await client.query("SELECT to_regclass('public._prisma_migrations') AS t");
    if (!exists.rows[0]?.t) return new Set();
    const rows = await client.query("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL");
    return new Set(rows.rows.map((r: { migration_name: string }) => r.migration_name));
  } finally {
    await client.end();
  }
}

function newMigrationDirName(name: string): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${stamp}_${name}`;
}

async function main(): Promise<number> {
  const command = parseMigrateCommand(process.argv.slice(2));
  const target = assertSafeMigrationTarget();
  console.log(`Target: ${target.host}:${target.port}/${target.database} (allowed by MIGRATION_ALLOWED_HOST / MIGRATION_ALLOWED_DB)`);

  switch (command.kind) {
    case "status":
      return runPrisma(["migrate", "status"], target).status ?? 1;

    case "scan":
      return scan(migrationNames(), true).length === 0 ? 0 : 1;

    case "create": {
      const before = new Set(migrationNames());
      const result = runPrisma(["migrate", "dev", "--create-only", "--name", command.name], target);
      if (result.status !== 0) {
        console.error(
          "\nmigrate dev did not complete. If it reported drift or wants to reset: STOP and ask, do not accept a reset.\n" +
            "If it could not create its shadow database, do not loosen permissions: use `diff-script <name>` instead."
        );
        return result.status ?? 1;
      }
      const created = migrationNames().filter((n) => !before.has(n));
      console.log("\nCreated (NOT applied, NOT staged):", created.join(", ") || "(nothing)");
      return scan(created, true).length === 0 ? 0 : 1;
    }

    case "diff-script": {
      const result = runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"], target, true);
      const sql = typeof result.stdout === "string" ? result.stdout : "";
      if (result.status !== 0) return result.status ?? 1;
      if (!/\S/.test(sql) || /-- This is an empty migration/i.test(sql)) {
        console.log("No schema changes to migrate.");
        return 0;
      }
      const dir = newMigrationDirName(command.name);
      mkdirSync(path.join(migrationsDir, dir), { recursive: true });
      writeFileSync(path.join(migrationsDir, dir, "migration.sql"), sql);
      console.log("\nCreated (NOT applied, NOT staged):", dir);
      return scan([dir], true).length === 0 ? 0 : 1;
    }

    case "deploy": {
      const all = migrationNames();
      const applied = await appliedMigrations(target);
      const pending = all.filter((n) => !applied.has(n));
      if (pending.length === 0) {
        console.log("No pending migrations.");
        return 0;
      }
      console.log(`Pending: ${pending.join(", ")}`);
      const blocked = scan(pending, true);
      if (blocked.length > 0) {
        console.error(
          `\nSTOPPED. Unsafe or unreviewed changes in: ${blocked.join(", ")}.\n` +
            "Do not apply. Ask the maintainer; only they add a migration name to prisma/migrations/scan-approved.txt."
        );
        return 1;
      }
      return runPrisma(["migrate", "deploy"], target).status ?? 1;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof UnsafeMigrationTargetError ? error.message : "Migration command failed.");
    // Prisma and pg errors can contain the connection string, so only the guard's own messages are printed.
    process.exit(1);
  }
);
