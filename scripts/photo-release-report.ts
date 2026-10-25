// Lists, per vehicle, how many photos exist and how many are released to the customer, so staff can review and release
// them. READ ONLY: it changes nothing, and prints counts only (a serial and numbers), never a photo URL or content.
// Releasing photos is done in the app (staff endpoint, slice 4, with an ActivityLog row); this script only shows what
// there is to review.
//
//   npm run photos:release-report
//
// It targets MIGRATION_DATABASE_URL and nothing else: it never reads DATABASE_URL or DIRECT_URL. The connection is
// set read-only.

import pg from "pg";
import { formatPhotoReport, type PhotoCountRow } from "./photo-report-format.js";
import { resolveMigrationTarget } from "./migrate-tools.js";

async function main(): Promise<number> {
  const url = process.env["MIGRATION_DATABASE_URL"];
  if (!url) {
    console.error("Set MIGRATION_DATABASE_URL. This script never uses DATABASE_URL or DIRECT_URL.");
    return 1;
  }
  const target = resolveMigrationTarget({ MIGRATION_DATABASE_URL: url });
  console.log(`Target: ${target.host}:${target.port}/${target.database}`);
  console.log(`Project ref: ${target.projectRef ?? "(not a Supabase URL)"}  <- compare with your private notes`);
  console.log("Mode: READ ONLY");

  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    const column = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'VehiclePhoto' AND column_name = 'visibleToCustomer'`
    );
    const hasColumn = (column.rowCount ?? 0) > 0;
    const result = await client.query(
      `SELECT v.serial AS serial, count(p.id)::int AS total${hasColumn ? `, count(*) FILTER (WHERE p."visibleToCustomer")::int AS released` : ""}
         FROM "Vehicle" v JOIN "VehiclePhoto" p ON p."vehicleId" = v.id
        WHERE v."deletedAt" IS NULL
        GROUP BY v.id, v.serial
        ORDER BY v.serial`
    );
    const rows: PhotoCountRow[] = result.rows.map((r: { serial: string; total: number; released?: number }) => ({
      serial: String(r.serial),
      total: r.total,
      released: hasColumn ? (r.released ?? 0) : null,
    }));
    for (const line of formatPhotoReport(rows)) console.log(line);
    return 0;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    // Driver errors can contain the connection string, so nothing from them is printed.
    console.error("Report failed.");
    process.exit(1);
  }
);
