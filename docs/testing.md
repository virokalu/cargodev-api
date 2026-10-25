# Testing

Tools: Vitest, `app.inject()` for routes, an in-memory fake database for fast unit tests, and a **real Postgres** (a throwaway container) for everything that depends on how the database actually behaves.

| Command | What it runs | Needs a database? |
|---|---|---|
| `npm test` | Unit and route tests against an in-memory fake | No |
| `npm run test:db` | The real-Postgres tests in `tests/db` | Yes: a throwaway one, see below |
| `npm run test:all` | Both | Yes |

CI runs both in the required `ci` job.

## Per-route checklist

- [ ] 401 without a token
- [ ] 403 for each disallowed role
- [ ] 404 for an id belonging to another org (seed two orgs, call with org A token on org B ids)
- [ ] 400 with `fieldErrors` for invalid input
- [ ] Response matches the envelope and sends `Cache-Control: no-store`

## Service tests

- Legacy serial bump: `lastNumber = max(lastNumber, entered)`
- ETD set/cleared produces the right status transition and a `StatusHistory` row
- Tri-state `null` survives an update (not coerced to `false`)
- FL vehicles strip shipping fields
- FC freight-agent capability (RORO/Container) is rejected when wrong
- A staff id is rejected as `customerId`
- An `ActivityLog` row exists after each mutation

## Contract tests

- Envelope shape and error codes match `docs/api-contract.md`
- Unexpected errors never leak their message

## Real-database tests (`tests/db`)

The in-memory fake proves our logic. It cannot prove anything that depends on Postgres itself, so these tests run against a real one:

- **NULL handling.** `{ not: id }` and a top-level `NOT` on a nullable column drop the NULL rows (SQL three-valued logic), while `NOT` over a relation filter keeps rows with no related row. Found while writing `null-semantics.db.test.ts`; it exposed a real bug in the row-colour filter.
- **Serial numbers.** Parallel creates get distinct, gap-free serials; the counter never moves backwards under concurrent legacy entries; the unique constraints are the backstop.
- **Advisory locks.** A second session is refused while the first holds the job lock, the lock is released on commit, rollback and a dying connection, and two scheduler instances run a job one at a time.
- **Vehicle and dashboard SQL.** The effective-status filters, relation search and ordering, NULLs-first/last ordering, soft delete, org scoping, and that the dashboard's counts agree with the list each bar links to.

Files named `*.concurrency.db.test.ts` need **real concurrent connections** (Docker or the CI service container). A single-session or in-process Postgres serializes everything, so they would pass for the wrong reason or fail confusingly. Run them only against a real server.

### Running them locally

You need Docker. Everything is fake data in a container that is thrown away.

```powershell
npm run db:test:up        # starts postgres on 127.0.0.1:55432 and prints the URL to set
$env:TEST_DATABASE_URL = "postgresql://postgres:example-throwaway-password@127.0.0.1:55432/cargodev_test"
npm run test:db
npm run db:test:down      # when finished
```

No `sh`? Run what `scripts/test-db.sh` runs:

```powershell
docker run -d --rm --name cargodev-api-test-db -e POSTGRES_PASSWORD=example-throwaway-password -e POSTGRES_DB=cargodev_test -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data postgres:16 -c fsync=off
```

### How the schema gets there

`tests/db/global-setup.ts` runs `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`, which only **prints** SQL (it never connects), and applies it to the throwaway database. It never runs `migrate dev`, `migrate deploy` or `db push`. The schema is rebuilt from `prisma/schema.prisma` on every run, so it cannot drift from the schema file (and, once migrations exist, a test should confirm that applying them gives the same schema). Each test starts from empty tables.

### The safety guard

The setup **drops and recreates the `public` schema**, so it must be impossible to aim it at a database that matters (`tests/db/guard.ts`, tested by `tests/db-guard.test.ts`). It refuses to run unless **all** of these hold:

1. `TEST_DATABASE_URL` is set. The harness reads that variable only and **never reads `DATABASE_URL`**. The tests overwrite `DATABASE_URL` with an unreachable address, so even code that forgot to use the test client could not reach a real database.
2. The host is `localhost`, `127.0.0.1` or `::1`, or the CI service container (`postgres`, only when `CI=true`). URLs with `host=`, `hostaddr=` or `service=` parameters are refused because they can redirect the connection.
3. The database name starts with `cargodev_test`.
4. The database is **empty or was created by this harness** (a marker comment on the schema). This catches what 1 to 3 cannot: a real database reached through an SSH tunnel looks like `localhost`.

It never prints the connection string (it contains a password).

If you see "The database test harness refused to run", read the message: it says which rule failed and nothing was changed.

## Migrations (separate from the test harness)

`npm run migrate -- <command>` is the only way to run migration commands. It runs the guard (`scripts/migrate-guard.ts`, tested by `tests/migrate-guard.test.ts`) first and refuses unless all of these hold:

1. `MIGRATION_DATABASE_URL`, `MIGRATION_ALLOWED_HOST` and `MIGRATION_ALLOWED_DB` are all set. The URL's host equals the allowed host and its database equals the allowed database, exactly.
2. The URL is not the runtime `DATABASE_URL` or `DIRECT_URL` (same string, or same host, port and database). Those two are only compared, never used or printed, and are removed from the environment of the Prisma process.
3. It is a direct connection: poolers (port 6543, `pooler`/`pgbouncer`) and redirecting parameters (`host=`, `hostaddr=`, `service=`, `options=`) are refused.

Commands: `create <name>` (generates a migration, does **not** apply it), `diff-script <name>` (same, without a shadow database), `scan`, `deploy`, `status`. There is no way to pass raw flags, so `reset`, `db push`, `--force-reset` and `--accept-data-loss` cannot be used.

Flow: `create` → read the printed SQL and scan → `deploy` (scans again, applies only pending migrations to the test database) → `npm run test:db`. The scan flags DROP, ALTER COLUMN TYPE, RENAME, TRUNCATE, DELETE, NOT NULL without DEFAULT, and a new table missing `org_id`, an `org_id`-first index or row level security. A flagged migration is not applied until a maintainer lists it in `prisma/migrations/scan-approved.txt`.

If `migrate dev` cannot create its shadow database, do not loosen permissions: use `diff-script <name>`. If it reports drift or asks to reset, stop and ask.

## Rules

- Test data is fake. No real names, org ids, hostnames or customer data.
- Test-harness commands run **only** against a local or CI throwaway container, through `npm run test:db`. Migrations run only through the guarded `npm run migrate`, against the designated test database. Never against a shared or production database.
- Do not build secret-looking fixtures as string literals (`password: "..."`): the secret scan has no allow-list. Build them at runtime or use an obviously fake value containing `example`.
- Anything that depends on real SQL behaviour (NULLs, locks, constraints, concurrency) gets a test in `tests/db`.
- Fix a bug by first writing the test that reproduces it.
