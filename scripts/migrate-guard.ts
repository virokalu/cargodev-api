// Safety guard for schema migrations. Every migrate command in this repo goes through
// scripts/migrate.ts, which calls this module first. Pure functions, no I/O, so they are fully tested
// (tests/migrate-guard.test.ts).
//
// This repo owns the schema, but migrations may only ever be aimed at ONE designated test database
// (and the throwaway container). Production and other environments are migrated by a person, outside
// this repo's tooling. The guard therefore refuses unless ALL of these hold:
//
//   1. MIGRATION_DATABASE_URL, MIGRATION_ALLOWED_HOST and MIGRATION_ALLOWED_DB are all set and valid.
//   2. The URL's host equals MIGRATION_ALLOWED_HOST and its database equals MIGRATION_ALLOWED_DB, exactly.
//   3. The URL is not the runtime DATABASE_URL (or DIRECT_URL): same string, or the same host, port and
//      database. DATABASE_URL is only ever COMPARED with here, never used or printed.
//   4. It is a direct connection (not a pooler), and has no parameters that could redirect it.
//
// Messages never contain a connection string: it holds a password.

export class UnsafeMigrationTargetError extends Error {
  constructor(message: string) {
    super(`${message}\n\nThe migration guard refused to run. Nothing was changed.`);
    this.name = "UnsafeMigrationTargetError";
  }
}

export interface MigrationTarget {
  /** The original URL, for the driver only. Never print it. */
  url: string;
  host: string;
  port: number;
  database: string;
}

/** Connection-string parameters that can silently redirect the connection to another server. */
const REDIRECT_PARAMS = ["host", "hostaddr", "service", "servicefile", "options"];
const RESERVED_DATABASES = new Set(["postgres", "template0", "template1"]);
const HOST_PATTERN = /^[A-Za-z0-9.-]+$/;
const DB_PATTERN = /^[A-Za-z0-9_]+$/;

interface Parts {
  host: string;
  port: number;
  database: string;
  params: URLSearchParams;
}

function parts(raw: string): Parts | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    port: url.port ? Number(url.port) : 5432,
    database,
    params: url.searchParams,
  };
}

function sameServerAndDatabase(a: Parts, b: Parts): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

export function assertSafeMigrationTarget(env: Record<string, string | undefined> = process.env): MigrationTarget {
  const raw = env["MIGRATION_DATABASE_URL"]?.trim();
  const allowedHost = env["MIGRATION_ALLOWED_HOST"]?.trim();
  const allowedDb = env["MIGRATION_ALLOWED_DB"]?.trim();

  const missing = [
    ["MIGRATION_DATABASE_URL", raw],
    ["MIGRATION_ALLOWED_HOST", allowedHost],
    ["MIGRATION_ALLOWED_DB", allowedDb],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new UnsafeMigrationTargetError(`Not set: ${missing.join(", ")}. All three are required (see docs/env.md).`);
  }

  if (!HOST_PATTERN.test(allowedHost!) && !(allowedHost === "::1")) {
    throw new UnsafeMigrationTargetError("MIGRATION_ALLOWED_HOST must be a single host name or IP address (no wildcards, ports or paths).");
  }
  if (!DB_PATTERN.test(allowedDb!) || RESERVED_DATABASES.has(allowedDb!.toLowerCase())) {
    throw new UnsafeMigrationTargetError("MIGRATION_ALLOWED_DB must be one specific database name, not a system database.");
  }

  const target = parts(raw!);
  if (!target) {
    // Do not echo the value: it may contain a password.
    throw new UnsafeMigrationTargetError("MIGRATION_DATABASE_URL is not a valid postgres:// or postgresql:// URL.");
  }

  for (const name of REDIRECT_PARAMS) {
    if (target.params.has(name)) {
      throw new UnsafeMigrationTargetError(`MIGRATION_DATABASE_URL must not use the "${name}" parameter: it can redirect the connection.`);
    }
  }

  if (target.host !== allowedHost!.toLowerCase().replace(/^\[|\]$/g, "")) {
    throw new UnsafeMigrationTargetError("The host in MIGRATION_DATABASE_URL does not equal MIGRATION_ALLOWED_HOST.");
  }
  if (target.database !== allowedDb) {
    throw new UnsafeMigrationTargetError("The database in MIGRATION_DATABASE_URL does not equal MIGRATION_ALLOWED_DB.");
  }

  // The runtime connection strings are compared, never used.
  for (const name of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const runtime = env[name]?.trim();
    if (!runtime) continue;
    const runtimeParts = parts(runtime);
    if (runtime === raw || (runtimeParts && sameServerAndDatabase(target, runtimeParts))) {
      throw new UnsafeMigrationTargetError(`MIGRATION_DATABASE_URL points at the same database as ${name}. Migrations never target the runtime database.`);
    }
  }

  // Poolers in transaction mode break migrations (advisory locks, prepared statements).
  if (target.port === 6543 || /pooler|pgbouncer/i.test(target.host) || target.params.has("pgbouncer")) {
    throw new UnsafeMigrationTargetError("MIGRATION_DATABASE_URL must be a direct (non-pooled) connection.");
  }

  return { url: raw!, host: target.host, port: target.port, database: target.database };
}

// ---------------------------------------------------------------------------------------------
// Commands. The wrapper accepts only these; it never passes arbitrary arguments to Prisma, so a
// reset, a forced push, a data-loss override or a different target cannot be added on the command line.

export type MigrateCommand =
  | { kind: "create"; name: string }
  | { kind: "deploy" }
  | { kind: "status" }
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
    case "scan":
      extra(0);
      return { kind: command };
    default:
      throw new UnsafeMigrationTargetError(
        'Unknown command. Allowed: create <name>, diff-script <name>, scan, deploy, status. ("reset", "db push", "--force-reset" and "--accept-data-loss" are never allowed.)'
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
