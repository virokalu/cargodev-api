/*
  Warnings:

  - You are about to drop the `RemarkEntry` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "RemarkEntry" DROP CONSTRAINT "RemarkEntry_authorId_fkey";

-- DropForeignKey
ALTER TABLE "RemarkEntry" DROP CONSTRAINT "RemarkEntry_vehicleId_fkey";

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "vehicleRemark" TEXT;

-- DropTable
DROP TABLE "RemarkEntry";
