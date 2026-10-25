-- "Inspection Location" renamed to "Inspection By" everywhere in the app —
-- RENAME (not DROP+ADD) preserves the small amount of existing data.
ALTER TABLE "InspectionLocation" RENAME TO "InspectionBy";
ALTER TABLE "InspectionBy" RENAME CONSTRAINT "InspectionLocation_pkey" TO "InspectionBy_pkey";
ALTER TABLE "InspectionBy" RENAME CONSTRAINT "InspectionLocation_org_id_fkey" TO "InspectionBy_org_id_fkey";
ALTER INDEX "InspectionLocation_org_id_name_key" RENAME TO "InspectionBy_org_id_name_key";

ALTER TABLE "Vehicle" RENAME COLUMN "inspectionLocationId" TO "inspectionById";
ALTER TABLE "Vehicle" RENAME CONSTRAINT "Vehicle_inspectionLocationId_fkey" TO "Vehicle_inspectionById_fkey";
ALTER INDEX "Vehicle_org_id_inspectionLocationId_idx" RENAME TO "Vehicle_org_id_inspectionById_idx";
