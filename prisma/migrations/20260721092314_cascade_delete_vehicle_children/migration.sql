-- DropForeignKey
ALTER TABLE "RemarkEntry" DROP CONSTRAINT "RemarkEntry_vehicleId_fkey";

-- DropForeignKey
ALTER TABLE "StatusHistory" DROP CONSTRAINT "StatusHistory_vehicleId_fkey";

-- DropForeignKey
ALTER TABLE "VehicleDocument" DROP CONSTRAINT "VehicleDocument_vehicleId_fkey";

-- DropForeignKey
ALTER TABLE "VehiclePhoto" DROP CONSTRAINT "VehiclePhoto_vehicleId_fkey";

-- AddForeignKey
ALTER TABLE "RemarkEntry" ADD CONSTRAINT "RemarkEntry_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehiclePhoto" ADD CONSTRAINT "VehiclePhoto_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleDocument" ADD CONSTRAINT "VehicleDocument_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusHistory" ADD CONSTRAINT "StatusHistory_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
