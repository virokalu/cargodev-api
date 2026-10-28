// Runs once before the real-database tests. Builds the schema in the throwaway database from
// prisma/schema.prisma using `prisma migrate diff` (an offline, read-only command that only
// PRINTS SQL). No `migrate dev`, `migrate deploy` or `db push` is ever run. The SQL is applied
// only to the database that passed the safety guard.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  HARNESS_SENTINEL,
  UnsafeTestDatabaseError,
  assertSafeTestDatabaseUrl,
  decideSchemaWipe,
  type SchemaState,
} from "./guard.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The CREATE TABLE/TYPE/INDEX statements for the whole schema, from the schema file alone. */
export function generateSchemaSql(testDatabaseUrl: string): string {
  // A minimal environment on purpose: the application's DATABASE_URL must not reach this child.
  const { DATABASE_URL: _unused, ...inherited } = process.env;
  const sql = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules/prisma/build/index.js"),
      "migrate",
      "diff",
      "--config",
      "scripts/prisma.test.config.ts",
      "--from-empty",
      "--to-schema",
      "prisma/schema.prisma",
      "--script",
    ],
    { cwd: repoRoot, env: { ...inherited, TEST_DATABASE_URL: testDatabaseUrl }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );

  // The Prisma CLI can exit 0 with no output when its schema engine fails to start.
  // Never continue with an empty or partial schema.
  if (!/CREATE TABLE/.test(sql)) {
    throw new Error("`prisma migrate diff` produced no CREATE TABLE statements, so the test schema cannot be built.");
  }
  return sql;
}

async function readSchemaState(client: pg.Client): Promise<SchemaState> {
  const tables = await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'"
  );
  const comment = await client.query<{ c: string | null }>(
    "SELECT obj_description('public'::regnamespace, 'pg_namespace') AS c"
  );
  return { tableCount: Number(tables.rows[0]?.n ?? 0), comment: comment.rows[0]?.c ?? null };
}

export default async function setup(): Promise<void> {
  const db = assertSafeTestDatabaseUrl(process.env["TEST_DATABASE_URL"]);
  const sql = generateSchemaSql(db.url);

  const client = new pg.Client({ connectionString: db.url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Could not connect to the test database at ${db.host}:${db.port}/${db.database} ` +
        `(${(error as Error).message}). Start it with \`npm run db:test:up\`.`
    );
  }

  try {
    const state = await readSchemaState(client);
    if (decideSchemaWipe(state) === "refuse") {
      throw new UnsafeTestDatabaseError(
        `The database "${db.database}" already has ${state.tableCount} table(s) and was not created by this test harness. ` +
          "Refusing to wipe it. Use a fresh, empty database."
      );
    }

    // Only reached for an empty database or one this harness created earlier.
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query(sql);
    await client.query(`COMMENT ON SCHEMA public IS '${HARNESS_SENTINEL}'`);
  } finally {
    await client.end();
  }
}
