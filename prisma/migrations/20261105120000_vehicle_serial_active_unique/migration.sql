-- Vehicle serial uniqueness among vehicles that are NOT soft-deleted (decision: free reuse of a deleted vehicle's serial).
--
-- MIGRATION 1 OF 2, ADDITIVE ONLY. It creates two PARTIAL unique indexes next to the existing full ones and removes nothing:
--   "Vehicle_org_id_serial_key" and "Vehicle_org_id_serialPrefix_serialNumber_key" (the old full uniques) stay, so behaviour in the
--   database does not change yet: a deleted vehicle's serial is still blocked by them. Reuse starts to work only after migration 2
--   (prisma/pending-migrations/20261105120100_vehicle_serial_drop_full_uniques), which is NOT in this folder and is not applied by
--   `deploy`.
--
-- Safe to run on existing data: the full uniques already guarantee that no two rows share a serial, so no two ACTIVE rows can either,
-- and building these indexes cannot fail on a duplicate. Every index starts with org_id (CLAUDE.md). Prisma cannot declare a partial
-- index in schema.prisma, so `npm run drift` ignores them (checked: docs/runbook.md).
--
-- Names: Vehicle_org_serial_active_key and Vehicle_org_prefix_number_active_key.

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_org_serial_active_key" ON "Vehicle"("org_id", "serial") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_org_prefix_number_active_key" ON "Vehicle"("org_id", "serialPrefix", "serialNumber") WHERE "deletedAt" IS NULL;
