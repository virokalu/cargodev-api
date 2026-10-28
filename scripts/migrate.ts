// The only way to run a migration command in this repo:   npm run migrate -- <command>
//
//   create <name>       generate a migration from schema.prisma WITHOUT applying it (migrate dev --create-only)
//   diff-script <name>  same, without a shadow database: diffs the database against schema.prisma (read-only)
//   scan                print the SQL of every migration and scan it for unsafe changes
//   deploy              scan, then apply pending migrations. NEVER run without the maintainer's approval for that run
//   status              read-only: target, what _prisma_migrations holds, pending migrations, scan result
//   drift               read-only: compare the live database with prisma/schema.prisma (names only, no data)
//
// It uses MIGRATION_DATABASE_URL, else DIRECT_URL. It does not check which database that is: the maintainer
// compares the printed host before every deploy (docs/runbook.md). There is no way to pass raw flags to
// Prisma, so reset, db push, --force-reset and --accept-data-loss cannot be used from here.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import pg from "pg";
import {
  UnsafeMigrationTargetError,
  analyzeHistory,
  buildPrismaEnv,
  parseApprovals,
  parseMigrateCommand,
  redactConnectionStrings,
  resolveMigrationTarget,
  summarizeDiff,
  withReadOnlyOption,
  scanMigrationSql,
  type HistoryRow,
  type MigrationTarget,
} from "./migrate-tools.js";

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const config = path.join("scripts", "prisma.migrate.config.ts");
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");

function runPrisma(args: string[], target: MigrationTarget, capture: boolean | "both" = false) {
  // The child sees MIGRATION_DATABASE_URL only. The runtime connection strings are removed.
  const env = buildPrismaEnv(process.env, target);
  return spawnSync(process.execPath, [prismaCli, ...args, "--config", config], {
    cwd: root,
    env,
    stdio: capture === "both" ? ["ignore", "pipe", "pipe"] : capture ? ["ignore", "pipe", "inherit"] : "inherit",
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

interface TargetState {
  /** The _prisma_migrations table exists. */
  tracked: boolean;
  applied: HistoryRow[];
  /** Application tables already exist (so an empty history means "not baselined", not "empty database"). */
  tablesExist: boolean;
}

/** Read-only look at the target database. */
async function inspectTarget(target: MigrationTarget): Promise<TargetState> {
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    const tables = await client.query("SELECT to_regclass('public.\"Vehicle\"') AS vehicle, to_regclass('public.\"Organization\"') AS org");
    const tablesExist = Boolean(tables.rows[0]?.vehicle || tables.rows[0]?.org);
    const exists = await client.query("SELECT to_regclass('public._prisma_migrations') AS t");
    if (!exists.rows[0]?.t) return { tracked: false, applied: [], tablesExist };
    const rows = await client.query(
      "SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations ORDER BY started_at, migration_name"
    );
    return {
      tracked: true,
      tablesExist,
      applied: rows.rows.map((r: { migration_name: string; finished: boolean; rolled_back: boolean }) => ({
        name: r.migration_name,
        finished: r.finished,
        rolledBack: r.rolled_back,
      })),
    };
  } finally {
    await client.end();
  }
}

/** Prints the state and returns what is pending and the reasons deploy must stop. */
function reportTarget(state: TargetState, all: string[]): { pending: string[]; stops: string[] } {
  console.log(`_prisma_migrations: ${state.tracked ? `exists, ${state.applied.length} row(s)` : "does not exist"}; application tables: ${state.tablesExist ? "present" : "absent"}`);
  for (const row of state.applied) {
    const label = row.rolledBack ? "ROLLED BACK" : row.finished ? "applied" : "UNFINISHED";
    console.log(`  ${label.padEnd(11)} ${row.name}`);
  }
  return analyzeHistory(state.applied, all, state.tracked, state.tablesExist);
}

function newMigrationDirName(name: string): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${stamp}_${name}`;
}

async function main(): Promise<number> {
  const command = parseMigrateCommand(process.argv.slice(2));
  const target = resolveMigrationTarget();
  console.log(`Target: ${target.host}:${target.port}/${target.database}`);
  console.log(`Project ref: ${target.projectRef ?? "(not a Supabase URL)"}  <- compare with your private notes before any deploy`);

  switch (command.kind) {
    case "status": {
      const all = migrationNames();
      const { pending, stops } = reportTarget(await inspectTarget(target), all);
      console.log(`Pending (${pending.length}): ${pending.join(", ") || "none"}`);
      for (const stop of stops) console.log(`WOULD STOP deploy: ${stop}`);
      const blocked = pending.length > 0 ? scan(pending, false) : [];
      console.log(blocked.length > 0 ? `Scan: unapproved findings in ${blocked.join(", ")}` : "Scan: no unapproved findings in the pending migrations.");
      return 0;
    }

    case "scan":
      return scan(migrationNames(), true).length === 0 ? 0 : 1;

    case "drift": {
      // Prisma's diff only reads. The session option asks the server to refuse writes as well.
      const readOnly: MigrationTarget = { ...target, url: withReadOnlyOption(target.url) };
      const result = runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"], readOnly, "both");
      if (result.status !== 0) {
        // Tool output is passed through a redactor: an error from the driver can contain the connection string.
        console.error(redactConnectionStrings(String(result.stderr ?? "")).trim() || "prisma migrate diff failed.");
        return result.status ?? 1;
      }
      const differences = summarizeDiff(String(result.stdout ?? ""));
      if (differences.length === 0) {
        console.log("Drift: no differences between the database and prisma/schema.prisma.");
        return 0;
      }
      console.log(`Drift: ${differences.length} difference(s). Statements that would make the database match schema.prisma:`);
      for (const d of differences) console.log(`  ${d}`);
      return 0;
    }

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
      const { pending, stops } = reportTarget(await inspectTarget(target), all);
      if (stops.length > 0) {
        for (const stop of stops) console.error(`\nSTOPPED. ${stop}`);
        return 1;
      }
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
    // Prisma and pg errors can contain the connection string, so only this tool's own messages are printed.
    process.exit(1);
  }
);
