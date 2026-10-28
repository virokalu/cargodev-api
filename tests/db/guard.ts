// Safety guard for the real-Postgres test harness.
//
// The harness DROPS and recreates the `public` schema of whatever TEST_DATABASE_URL points
// at, so it must be impossible to aim it at a database that matters. Three independent
// checks, all of which must pass:
//
//   1. The host is the local machine (or the CI service container).
//   2. The database name starts with `cargodev_test`.
//   3. The database is empty, or was created by this harness (a marker comment on the schema).
//      This catches the case checks 1 and 2 cannot: a real database reached through an SSH
//      tunnel or port-forward appears as localhost, and could even be named like a test DB.
//
// This module never reads DATABASE_URL (the application's connection string). It only looks
// at the value it is given, and at CI, to recognise the CI service container.

export const HARNESS_SENTINEL = "cargodev-api-test-harness";
export const TEST_DB_NAME_PREFIX = "cargodev_test";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** Connection-string parameters that can silently redirect the connection to another host. */
const HOST_OVERRIDE_PARAMS = ["host", "hostaddr", "service", "servicefile"];

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(`${message}\n\nThe database test harness refused to run. Nothing was changed.`);
    this.name = "UnsafeTestDatabaseError";
  }
}

export interface SafeTestDatabase {
  /** The original URL, for the driver only. Never print it: it contains a password. */
  url: string;
  host: string;
  port: number;
  database: string;
  user: string;
}

export function assertSafeTestDatabaseUrl(
  raw: string | undefined,
  env: Record<string, string | undefined> = process.env
): SafeTestDatabase {
  if (!raw || raw.trim() === "") {
    throw new UnsafeTestDatabaseError(
      "TEST_DATABASE_URL is not set.\nStart the throwaway database with `npm run db:test:up` and export the URL it prints."
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Do not echo the value: it may contain a password.
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL is not a valid URL.");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new UnsafeTestDatabaseError("TEST_DATABASE_URL must be a postgres:// or postgresql:// URL.");
  }

  const host = url.hostname.toLowerCase();
  // The CI service container is reachable as `localhost` from a normal runner job. The name
  // `postgres` is the service's DNS name only if the job itself runs in a container, and is
  // accepted only when CI=true.
  const isCiContainerHost = host === "postgres" && env["CI"] === "true";
  if (!LOCAL_HOSTS.has(host) && !isCiContainerHost) {
    throw new UnsafeTestDatabaseError(
      `TEST_DATABASE_URL points at host "${host}". Only localhost, 127.0.0.1 or ::1 (or the CI service container) are allowed.`
    );
  }

  for (const param of HOST_OVERRIDE_PARAMS) {
    if (url.searchParams.has(param)) {
      throw new UnsafeTestDatabaseError(
        `TEST_DATABASE_URL has a "${param}" parameter, which can redirect the connection to another host.`
      );
    }
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database.startsWith(TEST_DB_NAME_PREFIX)) {
    throw new UnsafeTestDatabaseError(
      `The database name "${database}" must start with "${TEST_DB_NAME_PREFIX}" so a real database can never be mistaken for a test one.`
    );
  }

  return {
    url: raw,
    host,
    port: url.port ? Number(url.port) : 5432,
    database,
    user: decodeURIComponent(url.username),
  };
}

export interface SchemaState {
  /** Tables in the public schema. */
  tableCount: number;
  /** The public schema's comment, or null. */
  comment: string | null;
}

/**
 * Whether the harness may wipe the public schema.
 *  - "empty":   no tables, safe to create ours.
 *  - "harness": left by a previous harness run, safe to recreate.
 *  - "refuse":  has tables but no harness marker. Something else lives here.
 */
export function decideSchemaWipe(state: SchemaState): "empty" | "harness" | "refuse" {
  if (state.comment === HARNESS_SENTINEL) return "harness";
  if (state.tableCount === 0) return "empty";
  return "refuse";
}
