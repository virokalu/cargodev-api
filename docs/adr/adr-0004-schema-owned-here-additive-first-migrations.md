# ADR 0004: This repo owns the database schema; additive-first migrations

- Status: **Accepted**
- Date: 2026-10-25
- Supersedes the earlier rule that the schema is owned by the CargoDev repo and this repo never migrates.

## Context

CargoDev's Next.js backend is being retired, so the schema can no longer live there. But the database is
still shared with that app while it runs, and some environments hold real data. A migration that drops or
renames something would break the old app instantly, and a migration run against the wrong database would
be unrecoverable.

## Decision

1. **This repo owns `prisma/schema.prisma` and `prisma/migrations/`.** Changes go through reviewed migrations,
   one migration per slice with a descriptive name. Agents and developers leave new migration files in the
   working tree for review.
2. **Additive first.** Every migration must be safe to run while the old app is live: new tables, new nullable
   columns or columns with a safe default, added enum values. No drops, renames, type changes, or new NOT NULL
   columns without a default. Removing old things is a separate "contract" migration that a maintainer approves
   explicitly.
3. **New tables** carry `org_id`, an index starting with `org_id`, and `ENABLE ROW LEVEL SECURITY` with no
   policies (so a direct database role without bypass rights sees nothing).
4. **One designated target.** Migration commands run only through `npm run migrate -- <command>`, which runs
   `scripts/migrate-guard.ts` first. It refuses unless `MIGRATION_DATABASE_URL` has the host in
   `MIGRATION_ALLOWED_HOST` and the database in `MIGRATION_ALLOWED_DB`, is not the runtime `DATABASE_URL` or
   `DIRECT_URL`, and is a direct connection. The tool exposes no raw Prisma flags, so `migrate reset`, `db push`
   and `--accept-data-loss` are unreachable. A maintainer applies migrations to every other environment by hand.
5. **Scan before applying.** The generated SQL is printed and scanned for DROP, ALTER COLUMN TYPE, RENAME,
   TRUNCATE, DELETE and NOT NULL without DEFAULT. A flagged migration is not applied until a maintainer lists it
   in `prisma/migrations/scan-approved.txt`.
6. **Drift or a requested reset means stop.** If `migrate dev` reports drift or wants to reset, ask. If it cannot
   create its shadow database, do not loosen permissions: use `diff-script`, which needs none.

## Consequences

- The test harness still rebuilds its throwaway database from `schema.prisma`; once migrations exist, a test
  should also prove that applying them yields the same schema.
- `prisma/migrations/` does not exist yet. The first migration must be a baseline of the current production
  schema (marked as already applied there by a maintainer, not run), otherwise `deploy` against an existing
  database would try to create tables that already exist.
- Row level security with no policies only protects roles that do not bypass it. The API's own database role
  must be allowed to bypass it (or policies must be added later); that is a deployment decision.
