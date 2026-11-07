# Pending migrations

Migrations in this folder are **written and scanned but NOT enabled**. `npm run migrate -- deploy` only applies what is in `prisma/migrations`, so nothing here runs by accident.

## 20261105120100_vehicle_serial_drop_full_uniques (migration 2 of the serial uniqueness change, ADR 0009)

Drops the two old FULL unique indexes on `"Vehicle"`, so only the partial indexes of migration 1 (`WHERE "deletedAt" IS NULL`) remain and a deleted vehicle's serial can be used again.

Do not enable it until **all** of these are true (the full checklist is in `docs/runbook.md`, "Before migration 2"):

- migration 1 (`20261105120000_vehicle_serial_active_unique`) is applied, and `npm run migrate -- status` and `drift` are clean;
- a backup exists and its restore was tried;
- the converted Next app was verified on staging with this migration applied, and **no old deployment reads or writes vehicles**;
- the maintainer read the SQL and the scan result (the scan flags two `DROP INDEX`) and approved it in `prisma/migrations/scan-approved.txt`.

**Rollback is impossible after the first reuse of a serial.**

### To enable it (one reviewed change)

1. Move the folder `20261105120100_vehicle_serial_drop_full_uniques` into `prisma/migrations`.
2. Apply the schema change that goes with it: `git apply prisma/migrations/20261105120100_vehicle_serial_drop_full_uniques/schema.prisma.patch` (it removes the two `@@unique` lines from `Vehicle`). Do both in the same commit: with the old indexes dropped and the lines still there, `npm run migrate -- drift` reports a difference.
3. Add the migration's name to `prisma/migrations/scan-approved.txt` (maintainer only).
4. Run the unit and real-database test suites. `tests/db/serial-uniqueness.db.test.ts` currently reads the migration from this folder: update its `MIGRATION_2` path to `prisma/migrations` in the same change (the test fails loudly if the file is missing).

What this folder deliberately does not do: it does not touch `prisma/schema.prisma` on its own. `schema.prisma` has to keep the two `@@unique` lines until the indexes are really dropped, because the real-database tests, `drift` and the generated client all follow `schema.prisma`.
