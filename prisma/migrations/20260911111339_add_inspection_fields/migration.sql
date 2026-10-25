-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "hasInspection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inspectionCompanyId" TEXT,
ADD COLUMN     "inspectionDate" TIMESTAMP(3),
ADD COLUMN     "inspectionLocationId" TEXT;

-- CreateTable
CREATE TABLE "InspectionCompany" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "InspectionCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionLocation" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "InspectionLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InspectionCompany_org_id_name_key" ON "InspectionCompany"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionLocation_org_id_name_key" ON "InspectionLocation"("org_id", "name");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_inspectionCompanyId_idx" ON "Vehicle"("org_id", "inspectionCompanyId");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_inspectionLocationId_idx" ON "Vehicle"("org_id", "inspectionLocationId");

-- AddForeignKey
ALTER TABLE "InspectionCompany" ADD CONSTRAINT "InspectionCompany_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionLocation" ADD CONSTRAINT "InspectionLocation_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_inspectionCompanyId_fkey" FOREIGN KEY ("inspectionCompanyId") REFERENCES "InspectionCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_inspectionLocationId_fkey" FOREIGN KEY ("inspectionLocationId") REFERENCES "InspectionLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
