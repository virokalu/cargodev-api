-- Renames the VehicleDocumentType enum value CUSTOMER_SHAKEN_SHO to
-- MEGI_HENKO. Postgres enum values are stored internally by OID, not by
-- their text label, so RENAME VALUE only updates the catalog's label — every
-- existing VehicleDocument row that already has this type keeps pointing at
-- the same enum member and reads as MEGI_HENKO immediately, with no table
-- rewrite and no data migration needed.
ALTER TYPE "VehicleDocumentType" RENAME VALUE 'CUSTOMER_SHAKEN_SHO' TO 'MEGI_HENKO';
