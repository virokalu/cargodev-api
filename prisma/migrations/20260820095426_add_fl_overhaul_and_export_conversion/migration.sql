-- AlterEnum
ALTER TYPE "VehicleDocumentType" ADD VALUE 'PURCHASE_INVOICE';
ALTER TYPE "VehicleDocumentType" ADD VALUE 'SALES_INVOICE';
ALTER TYPE "VehicleDocumentType" ADD VALUE 'CUSTOMER_SHAKEN_SHO';
ALTER TYPE "VehicleDocumentType" ADD VALUE 'CASH_RECEIPT';

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "convertedToExport" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "convertedToExportAt" TIMESTAMP(3),
ADD COLUMN     "supplierId" TEXT,
ADD COLUMN     "hasPartnership" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "partnerName" TEXT,
ADD COLUMN     "deliveryDate" TIMESTAMP(3),
ADD COLUMN     "paidByCustomer" BOOLEAN,
ADD COLUMN     "sellingPrice" DECIMAL(12,2),
ADD COLUMN     "sellingPriceCurrency" TEXT;

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_org_id_name_key" ON "Supplier"("org_id", "name");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_supplierId_idx" ON "Vehicle"("org_id", "supplierId");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
