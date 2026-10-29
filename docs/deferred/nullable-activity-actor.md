# Deferred: a nullable actor on the activity log (a "contract" migration)

**Status:** not built. Needs the maintainer's approval as a schema change (CLAUDE.md: additive-first migrations only).

## Why

`ActivityLog.actorId` is required and points at a user. The daily retention job changes data on its own, with no person behind it. Today its one summary row per org per run is attributed to the org's **oldest administrator account**, and the row's `after` carries `{ ..., "system": true, "job": "retention" }` so a reader can tell it was automatic. An org with no administrator is skipped (nothing is removed there), because a change that cannot be logged is not made.

## What the later change would be

1. Make `ActivityLog.actorId` **nullable** (dropping a NOT NULL is a relaxing change, but it is not purely additive, so it needs the explicit "contract" approval and a reviewed migration; the scan flags it).
2. Keep the foreign key (a null actor has no row to point at).
3. Update the readers that assume an actor: `listActivityLog` returns `actorName: null` for a system row; clients show "System" (the activity-log API contract gets a MINOR version note).
4. Switch the retention job (and any future automatic job) to write `actorId: null` with the same `system: true, job` metadata, and stop requiring an administrator.
5. Tests: a real-Postgres test that a system row can be written and read, that human mutations still require an actor, and that the retention job runs in an org with no administrator.

## Until then

Nothing to do. The attribution to the oldest administrator is a stand-in and is labelled as such in the row.
