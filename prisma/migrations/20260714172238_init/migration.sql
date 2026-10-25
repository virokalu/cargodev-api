-- CreateEnum
CREATE TYPE "SerialPrefix" AS ENUM ('FC', 'FL');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'BOOKING_RECEIVED', 'SHIPPED');

-- CreateEnum
CREATE TYPE "ShippingMethod" AS ENUM ('RORO', 'CONTAINER');

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('STAFF', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('ADMINISTRATOR', 'MANAGER', 'OPERATOR', 'VIEWER');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "userType" "UserType" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "address" TEXT,
    "password" TEXT,
    "loginEnabled" BOOLEAN NOT NULL DEFAULT false,
    "role" "StaffRole",
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SerialCounter" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "prefix" "SerialPrefix" NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SerialCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleModelRef" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "VehicleModelRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Grade" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Grade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuctionHall" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "AuctionHall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportCompany" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "TransportCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleLocation" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "VehicleLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreightAgent" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "offersRoro" BOOLEAN NOT NULL DEFAULT false,
    "offersContainer" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FreightAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RowColourStatus" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "transportCellOnly" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RowColourStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "serialPrefix" "SerialPrefix" NOT NULL,
    "serialNumber" INTEGER NOT NULL,
    "serial" TEXT NOT NULL,
    "auctionItemNo" TEXT,
    "chassisNo" TEXT,
    "shipmentStatus" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "modelId" TEXT,
    "gradeId" TEXT,
    "yom" INTEGER,
    "auctionHallId" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "etd" TIMESTAMP(3),
    "eta" TIMESTAMP(3),
    "auctionLotNo" TEXT,
    "customerId" TEXT,
    "destination" TEXT,
    "blNo" TEXT,
    "auctionBillPaid" BOOLEAN,
    "logBook" BOOLEAN,
    "extraKey" BOOLEAN,
    "auctionSheetUrl" TEXT,
    "docsArrivedDate" TIMESTAMP(3),
    "nameChangeDeadline" TIMESTAMP(3),
    "transportById" TEXT,
    "vehicleLocationId" TEXT,
    "freightAgentId" TEXT,
    "shippingMethod" "ShippingMethod",
    "massoDate" TIMESTAMP(3),
    "billNumber" TEXT,
    "lcNo" TEXT,
    "trackingNo" TEXT,
    "docSentDate" TIMESTAMP(3),
    "docSentComment" TEXT,
    "recycleDate" TIMESTAMP(3),
    "jibaishake" TEXT,
    "rowColourStatusId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemarkEntry" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemarkEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehiclePhoto" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehiclePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleDocument" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusHistory" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "fromStatus" "ShipmentStatus",
    "toStatus" "ShipmentStatus" NOT NULL,
    "trigger" TEXT NOT NULL,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "vehicleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_org_id_userType_idx" ON "User"("org_id", "userType");

-- CreateIndex
CREATE UNIQUE INDEX "User_org_id_email_key" ON "User"("org_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "SerialCounter_org_id_prefix_key" ON "SerialCounter"("org_id", "prefix");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_org_id_name_key" ON "Brand"("org_id", "name");

-- CreateIndex
CREATE INDEX "VehicleModelRef_org_id_idx" ON "VehicleModelRef"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleModelRef_org_id_brand_id_name_key" ON "VehicleModelRef"("org_id", "brand_id", "name");

-- CreateIndex
CREATE INDEX "Grade_org_id_idx" ON "Grade"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "Grade_org_id_model_id_name_key" ON "Grade"("org_id", "model_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionHall_org_id_name_key" ON "AuctionHall"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TransportCompany_org_id_name_key" ON "TransportCompany"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleLocation_org_id_name_key" ON "VehicleLocation"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "FreightAgent_org_id_name_key" ON "FreightAgent"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RowColourStatus_org_id_name_key" ON "RowColourStatus"("org_id", "name");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_serialPrefix_idx" ON "Vehicle"("org_id", "serialPrefix");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_shipmentStatus_idx" ON "Vehicle"("org_id", "shipmentStatus");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_customerId_idx" ON "Vehicle"("org_id", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_org_id_serial_key" ON "Vehicle"("org_id", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_org_id_serialPrefix_serialNumber_key" ON "Vehicle"("org_id", "serialPrefix", "serialNumber");

-- CreateIndex
CREATE INDEX "RemarkEntry_vehicleId_idx" ON "RemarkEntry"("vehicleId");

-- CreateIndex
CREATE INDEX "VehiclePhoto_vehicleId_idx" ON "VehiclePhoto"("vehicleId");

-- CreateIndex
CREATE INDEX "VehicleDocument_vehicleId_idx" ON "VehicleDocument"("vehicleId");

-- CreateIndex
CREATE INDEX "StatusHistory_vehicleId_idx" ON "StatusHistory"("vehicleId");

-- CreateIndex
CREATE INDEX "Notification_org_id_userId_isRead_idx" ON "Notification"("org_id", "userId", "isRead");

-- CreateIndex
CREATE INDEX "ActivityLog_org_id_createdAt_idx" ON "ActivityLog"("org_id", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_org_id_actorId_idx" ON "ActivityLog"("org_id", "actorId");

-- CreateIndex
CREATE INDEX "ActivityLog_org_id_entity_entityId_idx" ON "ActivityLog"("org_id", "entity", "entityId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialCounter" ADD CONSTRAINT "SerialCounter_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleModelRef" ADD CONSTRAINT "VehicleModelRef_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grade" ADD CONSTRAINT "Grade_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "VehicleModelRef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionHall" ADD CONSTRAINT "AuctionHall_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportCompany" ADD CONSTRAINT "TransportCompany_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLocation" ADD CONSTRAINT "VehicleLocation_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreightAgent" ADD CONSTRAINT "FreightAgent_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RowColourStatus" ADD CONSTRAINT "RowColourStatus_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "VehicleModelRef"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_auctionHallId_fkey" FOREIGN KEY ("auctionHallId") REFERENCES "AuctionHall"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_transportById_fkey" FOREIGN KEY ("transportById") REFERENCES "TransportCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_vehicleLocationId_fkey" FOREIGN KEY ("vehicleLocationId") REFERENCES "VehicleLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_freightAgentId_fkey" FOREIGN KEY ("freightAgentId") REFERENCES "FreightAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_rowColourStatusId_fkey" FOREIGN KEY ("rowColourStatusId") REFERENCES "RowColourStatus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemarkEntry" ADD CONSTRAINT "RemarkEntry_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemarkEntry" ADD CONSTRAINT "RemarkEntry_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehiclePhoto" ADD CONSTRAINT "VehiclePhoto_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleDocument" ADD CONSTRAINT "VehicleDocument_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusHistory" ADD CONSTRAINT "StatusHistory_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
