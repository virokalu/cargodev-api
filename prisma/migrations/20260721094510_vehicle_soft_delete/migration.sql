-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Vehicle_org_id_deletedAt_idx" ON "Vehicle"("org_id", "deletedAt");
