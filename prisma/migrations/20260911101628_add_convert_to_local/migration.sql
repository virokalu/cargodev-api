-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "convertedToLocal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "convertedToLocalAt" TIMESTAMP(3);
