-- Lookup names are unique ignoring case and surrounding spaces, per organisation (and per brand for models, per model for grades).
--
-- ADDITIVE ONLY, NOT ENABLED. This folder is outside prisma/migrations on purpose, so `deploy` never applies it by accident.
--
-- *** THIS MIGRATION FAILS IF DUPLICATES EXIST. *** A unique index cannot be built while two rows of one table have names that differ only by case
-- or by surrounding spaces ("Toyota", "toyota", "Toyota "). Everything runs in one transaction, so a failure changes nothing, but the deploy stops.
-- Before enabling it: run `npm run check:lookup-case` against the target database (read only); it must exit 0. If it finds groups, merge them
-- first (docs/lookup-duplicates-merge-plan.md: repoint the vehicles to one row, then delete or rename the other).
--
-- It does NOT remove the existing case-sensitive unique indexes ("<Table>_org_id_name_key" and the model and grade ones): they stay next to
-- the new ones. Names follow <Table>_org_name_ci_key (models: <Table>_org_brand_name_ci_key, grades: <Table>_org_model_name_ci_key).
-- Prisma cannot declare an expression index in schema.prisma; it ignores them (`npm run drift` stays clean, as for the serial indexes).

-- CreateIndex
CREATE UNIQUE INDEX "Brand_org_name_ci_key" ON "Brand"("org_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "VehicleModelRef_org_brand_name_ci_key" ON "VehicleModelRef"("org_id", "brand_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "Grade_org_model_name_ci_key" ON "Grade"("org_id", "model_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "AuctionHall_org_name_ci_key" ON "AuctionHall"("org_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_org_name_ci_key" ON "Supplier"("org_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "TransportCompany_org_name_ci_key" ON "TransportCompany"("org_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "InspectionCompany_org_name_ci_key" ON "InspectionCompany"("org_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "InspectionBy_org_name_ci_key" ON "InspectionBy"("org_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "VehicleLocation_org_name_ci_key" ON "VehicleLocation"("org_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "FreightAgent_org_name_ci_key" ON "FreightAgent"("org_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "PackingAgent_org_name_ci_key" ON "PackingAgent"("org_id", lower(btrim("name")));

-- CreateIndex
CREATE UNIQUE INDEX "RowColourStatus_org_name_ci_key" ON "RowColourStatus"("org_id", lower(btrim("name")));
