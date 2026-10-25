-- Enable Row Level Security on every table (Supabase/Postgres level).
--
-- WHY: defense-in-depth for the multi-tenant "SaaS foundation" (see
-- schema.prisma header) beyond the app-layer org_id checks in lib/services/.
-- No policies are added, so every table becomes default-deny for any
-- Postgres role subject to RLS.
--
-- This is a no-op for the running app: the DATABASE_URL/DIRECT_URL role
-- ("postgres", Supabase's project-owner role) has rolbypassrls = true, so
-- Prisma's queries are completely unaffected. RLS only starts mattering if
-- a future non-bypass role (e.g. Supabase's anon/authenticated keys via
-- supabase-js or PostgREST, which this app does not currently use) ever
-- gets a direct connection to this database.

ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SerialCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Brand" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VehicleModelRef" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Grade" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuctionHall" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransportCompany" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VehicleLocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FreightAgent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PackingAgent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RowColourStatus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Vehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VehiclePhoto" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VehicleDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StatusHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActivityLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefreshToken" ENABLE ROW LEVEL SECURITY;
