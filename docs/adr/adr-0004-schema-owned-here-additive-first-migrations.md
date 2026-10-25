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
4. **One entry point; no check on the target; a human approves every deploy.** Migration commands run only
   through `npm run migrate -- <command>`, which accepts a fixed list of commands, so `migrate reset`, `db push`,
   `--accept-data-loss` and `migrate resolve` are unreachable. It targets `MIGRATION_DATABASE_URL`, else
   `DIRECT_URL` (the direct connection, as in CargoDev), and does not check the host, the database name or any
   suffix. Because nothing in the tool identifies the environment, the control is procedural: agents may run
   `status`, `scan`, `create` and `diff-script`, but never `deploy` without the maintainer's explicit approval
   for that specific run, and the runbook requires comparing the printed host and, for databases with real data,
   a backup confirmed with a teammate. The database name
   (for example Supabase's default `postgres`) is neither required nor treated as a warning sign.
5. **Scan before applying.** The generated SQL is printed and scanned for DROP, ALTER COLUMN TYPE, RENAME,
   TRUNCATE, DELETE and NOT NULL without DEFAULT. A flagged migration is not applied until a maintainer lists it
   in `prisma/migrations/scan-approved.txt`.
6. **Drift, a requested reset, or an untracked database means stop.** If \`_prisma_migrations\` is empty or missing but the tables exist, \`deploy\` applies nothing and the maintainer baselines the history.  If `migrate dev` reports drift or wants to reset, ask. If it cannot
   create its shadow database, do not loosen permissions: use `diff-script`, which needs none.

## Consequences

- The test harness still rebuilds its throwaway database from `schema.prisma`; once migrations exist, a test
  should also prove that applying them yields the same schema.
- `prisma/migrations/` does not exist yet. The first migration must be a baseline of the current production
  schema (marked as already applied there by a maintainer, not run), otherwise `deploy` against an existing
  database would try to create tables that already exist.
- **Row level security stays "enabled, no policies" on every new table.** It blocks any database role that does
  not bypass RLS (for example a direct client using the project's public API keys). The API's own database role
  **must bypass RLS**, otherwise it would see no rows; the maintainer verifies this for each environment before
  a table goes live. Agents never create or alter database roles.
- A dedicated least-privilege API role (no DDL, no access beyond the tables it needs) is a hardening follow-up,
  not part of this decision.
