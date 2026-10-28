// Helpers for scripts/migrate.ts: the fixed command list, the SQL scan, and the Prisma environment.
// Pure functions, no I/O, tested in tests/migrate-tools.test.ts.
//
// There is no check on which database is targeted: whatever MIGRATION_DATABASE_URL (or, if that is
// not set, DIRECT_URL) points at is what migrations run against. The maintainer compares the printed host
// before every deploy (docs/runbook.md). What the tool does enforce:
//   - only the fixed commands below exist (no reset, no db push, no raw flags, no --accept-data-loss);
//   - the generated SQL is printed and scanned before anything is applied;
//   - the Prisma process only ever sees the one URL, through the migrate config.
// Messages never contain a connection string: it holds a password.

export class UnsafeMigrationTargetError extends Error {
  constructor(message: string) {
    super(`${message}\n\nThe migration tool refused to run. Nothing was changed.`);
    this.name = "UnsafeMigrationTargetError";
  }
}

export interface MigrationTarget {
  /** The original URL, for the driver only. Never print it. */
  url: string;
  host: string;
  port: number;
  database: string;
  /** Supabase project ref when the URL is a Supabase one, else null. Shown on the terminal only. */
  projectRef: string | null;
}

/**
 * The Supabase project ref in a connection URL, or null.
 *  - pooler URL: the user name is `postgres.<ref>` (the pooler host is shared by every project in a region,
 *    so the host alone does not identify the project);
 *  - direct URL: the host is `db.<ref>.supabase.co`.
 * Printed to the terminal so the maintainer can compare it with the private notes; never written to a file.
 */
export function projectRefFromUrl(url: URL): string | null {
  const user = decodeURIComponent(url.username);
  const fromUser = /^postgres\.([a-z0-9]+)$/i.exec(user);
  if (fromUser) return fromUser[1]!.toLowerCase();
  const fromHost = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(url.hostname);
  return fromHost ? fromHost[1]!.toLowerCase() : null;
}

/** MIGRATION_DATABASE_URL, else DIRECT_URL (the direct, non-pooled connection, as in CargoDev). */
export function resolveMigrationTarget(env: Record<string, string | undefined> = process.env): MigrationTarget {
  const raw = (env["MIGRATION_DATABASE_URL"] ?? env["DIRECT_URL"])?.trim();
  if (!raw) throw new UnsafeMigrationTargetError("Set MIGRATION_DATABASE_URL or DIRECT_URL (see docs/env.md).");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Do not echo the value: it may contain a password.
    throw new UnsafeMigrationTargetError("The migration database URL is not a valid postgres:// or postgresql:// URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new UnsafeMigrationTargetError("The migration database URL is not a valid postgres:// or postgresql:// URL.");
  }
  return {
    url: raw,
    host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    projectRef: projectRefFromUrl(url),
  };
}

// ---------------------------------------------------------------------------------------------
// What _prisma_migrations says, compared with the migrations folder.

export interface HistoryRow {
  name: string;
  finished: boolean;
  rolledBack: boolean;
}

export interface HistoryAnalysis {
  pending: string[];
  /** Reasons `deploy` must stop. Empty means the history is fine to continue from. */
  stops: string[];
}

/**
 * Mirrors Prisma's own reading of the table: a row with rolled_back_at set was resolved as rolled back and is
 * ignored. A row with neither finished_at nor rolled_back_at is a failed or interrupted run and stops deploy,
 * even if a finished row with the same name exists.
 */
export function analyzeHistory(
  rows: readonly HistoryRow[],
  folder: readonly string[],
  tracked: boolean,
  tablesExist: boolean
): HistoryAnalysis {
  const stops: string[] = [];
  const live = rows.filter((r) => !r.rolledBack);

  if (tablesExist && (!tracked || rows.length === 0)) {
    stops.push(
      "The tables already exist but _prisma_migrations is empty or missing. Nothing may be applied and migrate resolve must not be run by this tool: the maintainer baselines the history."
    );
  }
  const unfinished = [...new Set(live.filter((r) => !r.finished).map((r) => r.name))];
  if (unfinished.length > 0) {
    stops.push(`Unfinished or failed migrations recorded: ${unfinished.join(", ")}. The maintainer resolves these.`);
  }
  const unknown = [...new Set(live.map((r) => r.name).filter((n) => !folder.includes(n)))];
  if (unknown.length > 0) {
    stops.push(`The database has migrations that are not in prisma/migrations/: ${unknown.join(", ")}. The histories do not match.`);
  }

  const done = new Set(live.filter((r) => r.finished).map((r) => r.name));
  return { pending: folder.filter((n) => !done.has(n)), stops };
}

// ---------------------------------------------------------------------------------------------
// Commands. The wrapper accepts only these; it never passes arbitrary arguments to Prisma, so a
// reset, a forced push, a data-loss override or a different target cannot be added on the command line.

export type MigrateCommand =
  | { kind: "create"; name: string }
  | { kind: "deploy" }
  | { kind: "status" }
  | { kind: "drift" }
  | { kind: "diff-script"; name: string }
  | { kind: "scan" };

const NAME_PATTERN = /^[a-z][a-z0-9_]{2,60}$/;

export function parseMigrateCommand(args: readonly string[]): MigrateCommand {
  const [command, ...rest] = args;
  const extra = (n: number) => {
    if (rest.length !== n) throw new UnsafeMigrationTargetError(`Unexpected arguments for "${command}". Extra flags are not accepted.`);
  };
  switch (command) {
    case "create":
    case "diff-script": {
      extra(1);
      const name = rest[0]!;
      if (!NAME_PATTERN.test(name)) {
        throw new UnsafeMigrationTargetError("Migration name must be lowercase letters, digits and underscores (3 to 61 characters), e.g. add_vehicle_remarks.");
      }
      return { kind: command, name };
    }
    case "deploy":
    case "status":
    case "drift":
    case "scan":
      extra(0);
      return { kind: command };
    default:
      throw new UnsafeMigrationTargetError(
        'Unknown command. Allowed: create <name>, diff-script <name>, scan, deploy, status, drift. ("reset", "db push", "--force-reset" and "--accept-data-loss" are never allowed.)'
      );
  }
}

// ---------------------------------------------------------------------------------------------
// SQL scan (printed before anything is applied). Anything it finds means: stop and ask.

export interface ScanFinding {
  rule: string;
  statement: string;
}

/** Remove -- comments and /* *\/ comments, keeping string literals intact. */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      i += 1;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
      i += 1;
    } else if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const c of stripComments(sql)) {
    if (quote) {
      current += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === ";") {
      if (current.trim()) statements.push(current.trim().replace(/\s+/g, " "));
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim()) statements.push(current.trim().replace(/\s+/g, " "));
  return statements;
}

/** Destructive or unsafe-while-the-old-app-is-live changes (additive-first policy). */
export function scanMigrationSql(sql: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const add = (rule: string, statement: string) => findings.push({ rule, statement: statement.slice(0, 200) });

  const statements = splitStatements(sql);
  const createdTables = new Map<string, string>();
  const rlsTables = new Set<string>();
  const orgIndexTables = new Set<string>();

  for (const s of statements) {
    if (/\bDROP\b/i.test(s)) add("DROP", s);
    if (/\bALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\b(SET\s+DATA\s+)?TYPE\b/i.test(s)) add("ALTER COLUMN TYPE", s);
    if (/\bRENAME\b/i.test(s)) add("RENAME", s);
    if (/\bTRUNCATE\b/i.test(s)) add("TRUNCATE", s);
    if (/\bDELETE\s+FROM\b/i.test(s)) add("DELETE", s);

    if (/^ALTER\s+TABLE\b/i.test(s)) {
      if (/\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/i.test(s)) add("NOT NULL without DEFAULT (SET NOT NULL)", s);
      // Each ADD COLUMN clause on its own: NOT NULL needs a DEFAULT.
      for (const clause of s.split(/\bADD\s+COLUMN\b/i).slice(1)) {
        const column = clause.split(/,\s*(?=ADD\b|ALTER\b|DROP\b)/i)[0]!;
        if (/\bNOT\s+NULL\b/i.test(column) && !/\bDEFAULT\b/i.test(column)) add("NOT NULL without DEFAULT (ADD COLUMN)", s);
      }
    }

    const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(?:public"?\.)?"?([A-Za-z0-9_]+)"?\s*\(([\s\S]*)\)\s*$/i.exec(s);
    if (create) {
      createdTables.set(create[1]!, create[2]!);
      continue;
    }
    const rls = /^ALTER\s+TABLE\s+(?:ONLY\s+)?"?(?:public"?\.)?"?([A-Za-z0-9_]+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY$/i.exec(s);
    if (rls) rlsTables.add(rls[1]!);
    const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+(?:ONLY\s+)?"?(?:public"?\.)?"?([A-Za-z0-9_]+)"?\s*(?:USING\s+\w+\s*)?\(\s*"?([A-Za-z0-9_]+)"?/i.exec(s);
    if (index && index[2]!.toLowerCase() === "org_id") orgIndexTables.add(index[1]!);
  }

  // Every new table: an org_id column, an index starting with org_id, and RLS enabled (no policies).
  for (const [table, body] of createdTables) {
    if (!/"?org_id"?\s/i.test(body)) add(`new table "${table}" has no org_id column`, `CREATE TABLE ${table}`);
    if (!orgIndexTables.has(table)) add(`new table "${table}" has no index starting with org_id`, `CREATE TABLE ${table}`);
    if (!rlsTables.has(table)) add(`new table "${table}" does not ENABLE ROW LEVEL SECURITY`, `CREATE TABLE ${table}`);
  }

  return findings;
}

/** Migration names listed (one per line, # comments allowed) in prisma/migrations/scan-approved.txt. */
export function parseApprovals(text: string): Set<string> {
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean)
  );
}

// ---------------------------------------------------------------------------------------------
// The environment the Prisma process runs in. It gets MIGRATION_DATABASE_URL and nothing that could be
// mistaken for a runtime or test connection, and it is always started with --config
// scripts/prisma.migrate.config.ts (there is no root prisma.config.ts to fall back to).

const STRIPPED_FROM_PRISMA_ENV = ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL", "SHADOW_DATABASE_URL", "POSTGRES_URL", "PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPORT", "PGSERVICE", "PGSERVICEFILE"];

export function buildPrismaEnv(env: NodeJS.ProcessEnv, target: MigrationTarget): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env, MIGRATION_DATABASE_URL: target.url };
  for (const name of STRIPPED_FROM_PRISMA_ENV) delete child[name];
  return child;
}

// ---------------------------------------------------------------------------------------------
// drift: compare the live database with prisma/schema.prisma (read-only).

/** The same URL with the session asked to be read-only. The original string is not changed. */
export function withReadOnlyOption(raw: string): string {
  const url = new URL(raw);
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  return url.toString();
}

/** Removes anything that looks like a connection string, so tool output can never carry a password. */
export function redactConnectionStrings(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi, "[connection string removed]");
}

/**
 * The differences in a `prisma migrate diff --script` output, one line per statement (names only: this is
 * schema, never data). An empty list means the database matches the schema.
 */
export function summarizeDiff(script: string): string[] {
  const statements = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  return statements.map((s) => (s.length > 200 ? `${s.slice(0, 200)}...` : s));
}
