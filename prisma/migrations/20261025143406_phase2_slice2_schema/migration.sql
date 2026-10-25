-- CreateEnum
CREATE TYPE "MilestoneType" AS ENUM ('BOUGHT', 'AUCTION_BILL_PAID', 'AT_EXPORT_YARD', 'EXPORT_CERT_ISSUED', 'BOOKING_RECEIVED', 'SHIPPED', 'BL_ISSUED', 'ARRIVED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "LinkRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MessageSender" AS ENUM ('CUSTOMER', 'STAFF');

-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SOLD');

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "customerAmount" DECIMAL(14,2),
ADD COLUMN     "customerAmountCurrency" TEXT,
ADD COLUMN     "customerVisible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "portOfDischarge" TEXT,
ADD COLUMN     "portOfLoading" TEXT,
ADD COLUMN     "voyageNo" TEXT;

-- AlterTable
ALTER TABLE "VehicleDocument" ADD COLUMN     "visibleToCustomer" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "VehiclePhoto" ADD COLUMN     "visibleToCustomer" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "VehicleMilestone" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "type" "MilestoneType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleLinkRequest" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "serialEntered" TEXT NOT NULL,
    "vehicleId" TEXT,
    "status" "LinkRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleLinkRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '{}',
    "departureLeadDays" INTEGER NOT NULL DEFAULT 7,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt" TIMESTAMP(3),
    "handledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderType" "MessageSender" NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Faq" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Faq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enquiry" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "message" TEXT NOT NULL,
    "stockSlug" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Enquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockVehicle" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER,
    "priceFob" DECIMAL(14,2),
    "mileageKm" INTEGER,
    "bodyType" TEXT,
    "fuel" TEXT,
    "transmission" TEXT,
    "colour" TEXT,
    "description" TEXT,
    "status" "StockStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockImage" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "stockVehicleId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "altText" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VehicleMilestone_org_id_vehicleId_idx" ON "VehicleMilestone"("org_id", "vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleMilestone_vehicleId_type_key" ON "VehicleMilestone"("vehicleId", "type");

-- CreateIndex
CREATE INDEX "VehicleLinkRequest_org_id_status_createdAt_idx" ON "VehicleLinkRequest"("org_id", "status", "createdAt");

-- CreateIndex
CREATE INDEX "VehicleLinkRequest_org_id_customerId_idx" ON "VehicleLinkRequest"("org_id", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE INDEX "NotificationPreference_org_id_userId_idx" ON "NotificationPreference"("org_id", "userId");

-- CreateIndex
CREATE INDEX "Conversation_org_id_customerId_idx" ON "Conversation"("org_id", "customerId");

-- CreateIndex
CREATE INDEX "Conversation_org_id_lastMessageAt_idx" ON "Conversation"("org_id", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Message_org_id_conversationId_createdAt_idx" ON "Message"("org_id", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Faq_org_id_published_sortOrder_idx" ON "Faq"("org_id", "published", "sortOrder");

-- CreateIndex
CREATE INDEX "Enquiry_org_id_createdAt_idx" ON "Enquiry"("org_id", "createdAt");

-- CreateIndex
CREATE INDEX "StockVehicle_org_id_status_publishedAt_idx" ON "StockVehicle"("org_id", "status", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockVehicle_org_id_slug_key" ON "StockVehicle"("org_id", "slug");

-- CreateIndex
CREATE INDEX "StockImage_org_id_stockVehicleId_sortOrder_idx" ON "StockImage"("org_id", "stockVehicleId", "sortOrder");

-- AddForeignKey
ALTER TABLE "VehicleMilestone" ADD CONSTRAINT "VehicleMilestone_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleMilestone" ADD CONSTRAINT "VehicleMilestone_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleMilestone" ADD CONSTRAINT "VehicleMilestone_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLinkRequest" ADD CONSTRAINT "VehicleLinkRequest_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLinkRequest" ADD CONSTRAINT "VehicleLinkRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLinkRequest" ADD CONSTRAINT "VehicleLinkRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleLinkRequest" ADD CONSTRAINT "VehicleLinkRequest_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Faq" ADD CONSTRAINT "Faq_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockVehicle" ADD CONSTRAINT "StockVehicle_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockImage" ADD CONSTRAINT "StockImage_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockImage" ADD CONSTRAINT "StockImage_stockVehicleId_fkey" FOREIGN KEY ("stockVehicleId") REFERENCES "StockVehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row level security, enabled with NO policies (default-deny for any role that does not bypass RLS).
ALTER TABLE "VehicleMilestone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VehicleLinkRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Faq" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Enquiry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockVehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockImage" ENABLE ROW LEVEL SECURITY;
