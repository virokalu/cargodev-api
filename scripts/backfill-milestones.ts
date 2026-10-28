// Backfill vehicle milestones for vehicles that existed before milestones did.
//
//   npm run backfill:milestones            DRY RUN (the default): prints counts only, writes nothing
//   npm run backfill:milestones -- --apply writes (only after the maintainer approves that run)
//
// It targets MIGRATION_DATABASE_URL and NOTHING else: it never reads DATABASE_URL or DIRECT_URL. It prints the host and
// Supabase project ref (terminal only) and COUNTS. It never prints a row, a name, a serial or a date. Idempotent: rows
// that already exist are skipped (INSERT ... ON CONFLICT DO NOTHING), so running it twice changes nothing.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { planMilestoneBackfill, countByType, type BackfillHistory } from "../src/services/milestone-backfill.js";
import { resolveMigrationTarget } from "./migrate-tools.js";

const BATCH = 500;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--apply");
  if (unknown.length > 0) {
    console.error("Only --apply is accepted.");
    return 1;
  }
  const apply = args.includes("--apply");

  const url = process.env["MIGRATION_DATABASE_URL"];
  if (!url) {
    console.error("Set MIGRATION_DATABASE_URL. This script never uses DATABASE_URL or DIRECT_URL.");
    return 1;
  }
  const target = resolveMigrationTarget({ MIGRATION_DATABASE_URL: url });
  console.log(`Target: ${target.host}:${target.port}/${target.database}`);
  console.log(`Project ref: ${target.projectRef ?? "(not a Supabase URL)"}  <- compare with your private notes`);
  console.log(apply ? "Mode: APPLY (writes)" : "Mode: DRY RUN (writes nothing)");

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.url, max: 2 }), log: ["error"] });
  try {
    const exists = await prisma.$queryRaw<Array<{ t: string | null }>>`SELECT to_regclass('public."VehicleMilestone"')::text AS t`;
    if (!exists[0]?.t) {
      console.log('The "VehicleMilestone" table does not exist yet: apply the slice 2 migration first. Nothing to do.');
      return apply ? 1 : 0;
    }

    const vehicles = await prisma.vehicle.findMany({ where: { deletedAt: null }, select: { id: true, org_id: true, purchaseDate: true } });
    const ids = vehicles.map((v) => v.id);
    const histories: BackfillHistory[] = (
      await prisma.statusHistory.findMany({ where: { vehicleId: { in: ids } }, select: { vehicleId: true, toStatus: true, createdAt: true } })
    ).map((h) => ({ vehicleId: h.vehicleId, toStatus: h.toStatus, createdAt: h.createdAt }));
    const existingRows = await prisma.vehicleMilestone.findMany({ where: { vehicleId: { in: ids } }, select: { vehicleId: true, type: true } });
    const existing = new Set(existingRows.map((m) => `${m.vehicleId}:${m.type}`));

    const planned = planMilestoneBackfill(vehicles, histories, existing);
    console.log(`Vehicles considered: ${vehicles.length}`);
    console.log(`Milestones already present: ${existingRows.length}`);
    console.log(`Milestones to add: ${planned.length}`, JSON.stringify(countByType(planned)));

    if (!apply) {
      console.log("Dry run: nothing was written. Re-run with --apply after approval.");
      return 0;
    }

    let written = 0;
    for (let i = 0; i < planned.length; i += BATCH) {
      const result = await prisma.vehicleMilestone.createMany({ data: planned.slice(i, i + BATCH).map((p) => ({ ...p, recordedById: null })), skipDuplicates: true });
      written += result.count;
    }
    console.log(`Written: ${written}`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    // Driver errors can contain the connection string, so nothing from them is printed.
    console.error("Backfill failed.");
    process.exit(1);
  }
);
