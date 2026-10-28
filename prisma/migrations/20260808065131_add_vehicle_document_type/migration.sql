-- CreateEnum
CREATE TYPE "VehicleDocumentType" AS ENUM ('LC', 'EC', 'ED', 'BL', 'INSPECTION_REPORT', 'OTHER');

-- AlterTable
ALTER TABLE "VehicleDocument" ADD COLUMN     "documentType" "VehicleDocumentType" NOT NULL DEFAULT 'OTHER';
