-- Vehicle serial uniqueness among vehicles that are NOT soft-deleted.
--
-- MIGRATION 2 OF 2, THE CONTRACT STEP. *** NOT ENABLED. NOT APPLIED. *** This folder is deliberately OUTSIDE prisma/migrations, so
-- `npm run migrate -- deploy` can never pick it up by accident. It becomes a real migration only when the maintainer moves it into
-- prisma/migrations in the same change as the schema.prisma edit in schema.prisma.patch (see README.md in this folder).
--
-- WHAT IT DOES: drops the two OLD FULL unique indexes. After it runs, only the partial indexes of migration 1 remain
-- ("Vehicle_org_serial_active_key" and "Vehicle_org_prefix_number_active_key"), so a serial held only by soft-deleted vehicles can be
-- used again, and the SAME serial may then exist on a deleted and on an active vehicle at the same time.
--
-- RUN IT ONLY AFTER ALL OF THESE:
--   1. A backup of the database exists and its restore was tried (docs/runbook.md, "Before migration 2").
--   2. Migration 1 is applied and `npm run migrate -- status` shows nothing else pending.
--   3. The converted Next app was verified on STAGING (it must not read vehicles by (org_id, serial) as if it were unique), and NO old
--      deployment reads or writes vehicles any more: an old reader that assumes one row per serial would show the wrong vehicle.
--   4. The maintainer has read this SQL and the scan result and approved it in prisma/migrations/scan-approved.txt (the scan flags DROP).
--
-- ROLLBACK IS IMPOSSIBLE AFTER THE FIRST REUSE: once a serial exists on a deleted AND on an active vehicle, re-creating the old full
-- unique index fails (it would be a duplicate). Before the first reuse the two indexes can be re-created by the statements at the end
-- of this file (kept as comments). After it, the only way back is to rename or delete one of the two vehicles by hand.
--
-- Idempotent: IF EXISTS, so running it twice does nothing the second time.

-- DropIndex
DROP INDEX IF EXISTS "Vehicle_org_id_serial_key";

-- DropIndex
DROP INDEX IF EXISTS "Vehicle_org_id_serialPrefix_serialNumber_key";

-- Rollback, valid ONLY while no serial is shared by two vehicles (run by hand, never automatically):
--   CREATE UNIQUE INDEX "Vehicle_org_id_serial_key" ON "Vehicle"("org_id", "serial");
--   CREATE UNIQUE INDEX "Vehicle_org_id_serialPrefix_serialNumber_key" ON "Vehicle"("org_id", "serialPrefix", "serialNumber");
