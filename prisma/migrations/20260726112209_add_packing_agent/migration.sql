-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "packingAgentId" TEXT;

-- CreateTable
CREATE TABLE "PackingAgent" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "PackingAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PackingAgent_org_id_name_key" ON "PackingAgent"("org_id", "name");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_packingAgentId_idx" ON "Vehicle"("org_id", "packingAgentId");

-- AddForeignKey
ALTER TABLE "PackingAgent" ADD CONSTRAINT "PackingAgent_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_packingAgentId_fkey" FOREIGN KEY ("packingAgentId") REFERENCES "PackingAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
