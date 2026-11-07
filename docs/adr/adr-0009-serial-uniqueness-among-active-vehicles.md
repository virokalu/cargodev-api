# ADR 0009: Serial uniqueness among non-deleted vehicles

- Status: **Accepted** (decision of the owner, 2026-11-05)
- Date: 2026-11-05
- Replaces: the earlier rule "a serial number is never reissued" (design notes and `CLAUDE.md`), and the guarded-reuse proposal ("option C").

## Context

A vehicle has a serial such as `FC1024` (the track prefix and a number). The database held two **full** unique indexes on it:
`(org_id, serial)` and `(org_id, serialPrefix, serialNumber)`. Deleting a vehicle is a **soft delete** (`deletedAt` is set, the row stays), so a
deleted vehicle kept its serial for ever: nobody could create a vehicle with it, and an administrator could not correct a vehicle to it.

The business does not want that. A serial typed by mistake, a vehicle entered twice, or a test entry that was deleted should not burn a number
for good. The owner decided: **uniqueness applies only to vehicles that are not soft-deleted.** When a vehicle is deleted its serial is free; a
new vehicle may be created with it, or an administrator may correct a vehicle to it ("free reuse").

## Options considered

1. **Never reuse** (the old behaviour). Safe for paperwork, but a deleted entry blocks its serial for ever and the only cure is editing the
   database by hand. Rejected by the owner.
2. **Guarded reuse** (option C, built in contract 1.6.0 and 1.7.0): a conflict with a deleted vehicle's serial is a `409` with a machine
   `reason`, unless an administrator sends a flag; a MANAGER sending the flag is a `403`. More code, two reasons, a flag clients must learn, and
   still a person deciding something the business had already decided. Replaced by this ADR.
3. **Suffix the serial of a deleted vehicle** (for example `FC1024` becomes `FC1024-del-<id>`) so the full unique index frees the number.
   Rejected: it rewrites a business identifier that old paperwork, PDFs and the activity log quote, destroys the link between "the serial printed
   on the paper" and the row, and cannot be undone cleanly.
4. **A composite unique including `deletedAt`** (`(org_id, serial, deletedAt)`). Rejected: in PostgreSQL two `NULL` values are never equal, so
   it would allow two **active** vehicles with the same serial, which is the one thing that must never happen.
5. **Partial unique indexes** `WHERE "deletedAt" IS NULL` (chosen). The database itself refuses two active vehicles with one serial, ignores
   deleted rows, and nothing is renamed.

## Decision

- Two **partial unique indexes** on `"Vehicle"`, both starting with `org_id` and both `WHERE "deletedAt" IS NULL`:
  `Vehicle_org_serial_active_key (org_id, serial)` and `Vehicle_org_prefix_number_active_key (org_id, serialPrefix, serialNumber)`.
- **Two migrations, in this order:**
  1. *Migration 1* (`prisma/migrations/20261105120000_vehicle_serial_active_unique`, additive) creates the partial indexes **next to** the old full
     ones. Nothing changes for users yet: the old indexes still block a deleted vehicle's serial.
  2. *Migration 2* (`prisma/pending-migrations/20261105120100_vehicle_serial_drop_full_uniques`, the contract step) drops the old full indexes. It is
     **not enabled**: it lives outside `prisma/migrations`, so `deploy` cannot apply it, together with a patch that removes the two `@@unique` lines
     from `schema.prisma`. Reuse starts to work only after it has run.
- **Code** (already deployed with migration 1; it works in both database states):
  - every lookup by serial filters `deletedAt: null`: the vehicle detail and every route that resolves a serial (timeline, files, PDF images,
    status history, milestones), the legacy-serial assignment, the serial correction, and the link-request matching;
  - creating (ADMINISTRATOR or MANAGER, as before) or correcting (ADMINISTRATOR only, as before) to a serial held **only by deleted vehicles**
    succeeds; a clash with an **active** vehicle is `409 CONFLICT` with `fieldErrors.serial: "already in use"` (and the old
    `legacySerialNumber` / `serialNumber` key). A database violation (Prisma `P2002`, Postgres `23505`) on the new indexes is mapped to the same `409`,
    so two requests that pass the application check together still end with exactly one winner;
  - **traceability:** the answer of create and of the correction carries `serialReused: boolean`, and the activity log entry records
    `reusedFromVehicleId`, the id of the **most recent** deleted vehicle that held the serial (only when one did);
  - the body field `reuseDeletedSerial` is **deprecated**: accepted and ignored for one contract version, no `403`; the reasons
    `SERIAL_PREVIOUSLY_USED` and `SERIAL_REUSE_NOT_ENABLED` are no longer returned;
  - **the counter is unaffected:** automatic serials come from `lastNumber + 1` and never go back; entering a legacy serial still sets
    `lastNumber = max(lastNumber, entered)`, so a reused lower number leaves the counter where it is.
- **Restore:** there is no restore or undelete path today. When one is added it must answer `409` if an active vehicle now holds the serial (a
  skipped, documented test marks the place: `tests/serial-reuse.test.ts`).

## Business risk (read this before running migration 2)

After migration 2 **the same serial can belong to two different vehicles over time**: the deleted one and the active one. Anything that stored only
the serial *text* can become ambiguous:

- **Old paperwork, PDFs, e-mails and customer messages** that quote `FC1024` may refer to the earlier, deleted vehicle. Nothing in the database can
  tell which one a printed serial meant.
- **Link requests** store the serial a customer typed (`serialEntered`). A pending request typed before the reuse can match a different, newer
  vehicle. Staff approve a request by choosing the vehicle (the id), so a wrong match needs a person to confirm it, but they should look at it.
- **Customer notifications and chat bodies** contain the serial text; the rows carry the vehicle id, the text does not.
- **Reports and the dashboard** show the serial next to a vehicle **id**; ids stay unambiguous, the displayed text can repeat.

What stays unambiguous: the activity log (`entityId` is the vehicle id), notifications and chat rows (a `vehicleId`), reports (rows keyed by id),
files (keyed by vehicle id), and every API object that has an `id`. **Clients must identify a vehicle by its `id`, never by its serial alone**
(`docs/staff-frontend-integration.md`, contract 1.8.0).

## Consequences

- A deleted vehicle's serial may appear on a new vehicle. The activity log of that creation names the vehicle it came from, so a person can see it.
- **Rollback becomes impossible after the first reuse.** Re-creating the old full unique index fails once a serial exists on a deleted and an active
  vehicle. Before the first reuse, migration 2 can be undone by re-creating the two old indexes (the statements are in its header).
- Prisma cannot declare a partial index in `schema.prisma`. It ignores them (`npm run drift` is clean with them present; see `docs/runbook.md`). The
  indexes are guarded by a test that reads `pg_index` and fails if either disappears or loses its predicate or its `org_id`
  (`tests/db/serial-uniqueness.db.test.ts`).
- The `@@unique` lines are removed from `schema.prisma` **in the same change that enables migration 2**, not before: until the old indexes are
  dropped, the schema must keep describing them, or `drift` would report the difference.
- Run order and approvals are in `docs/runbook.md` ("Before migration 2"). Migration 2 is flagged by the migration scan (`DROP`); only the maintainer
  approves it in `prisma/migrations/scan-approved.txt`.
