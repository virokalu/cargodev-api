-- Bill Number was consistently used to record the shipment tracking
-- number in practice, so the field is renamed to match what it actually
-- holds. RENAME COLUMN (not DROP+ADD) preserves every existing value.
ALTER TABLE "Vehicle" RENAME COLUMN "billNumber" TO "trackingNumber";

-- The separate, FC-only Tracking No field is dropped as unused/redundant
-- now that Tracking Number covers this on both tracks.
ALTER TABLE "Vehicle" DROP COLUMN "trackingNo";
