-- CreateIndex
CREATE INDEX "Vehicle_org_id_auctionHallId_idx" ON "Vehicle"("org_id", "auctionHallId");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_freightAgentId_idx" ON "Vehicle"("org_id", "freightAgentId");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_vehicleLocationId_idx" ON "Vehicle"("org_id", "vehicleLocationId");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_modelId_idx" ON "Vehicle"("org_id", "modelId");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_gradeId_idx" ON "Vehicle"("org_id", "gradeId");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_destination_idx" ON "Vehicle"("org_id", "destination");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_rowColourStatusId_idx" ON "Vehicle"("org_id", "rowColourStatusId");

-- CreateIndex
CREATE INDEX "Vehicle_org_id_shippingMethod_idx" ON "Vehicle"("org_id", "shippingMethod");
