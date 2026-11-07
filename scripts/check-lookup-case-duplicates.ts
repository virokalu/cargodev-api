// Read-only check: do any lookup names (brands, models, grades, halls, suppliers, ...) differ only by case or by surrounding spaces?
// A unique index on (org_id, lower(btrim(name))) cannot be built while they do. Run it yourself before that migration:
//
//   npm run check:lookup-case
//
// It reads MIGRATION_DATABASE_URL and nothing else (never DATABASE_URL or DIRECT_URL), opens a READ ONLY session, runs SELECTs, prints
// the target as host:port/database (never the URL, never a password), the groups with the spelling variants and row ids, and COUNTS of
// vehicles. No person, e-mail or credential is read or printed.
//
// Exit code: 0 = no duplicates, 2 = duplicates found (the report says which), 1 = it could not run.

import pg from "pg";
import { resolveMigrationTarget, redactConnectionStrings } from "./migrate-tools.js";
import { runLookupCaseCheck } from "./lookup-case-report.js";

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
    await client.query("BEGIN READ ONLY");
    const result = await runLookupCaseCheck(client);
    await client.query("ROLLBACK");
    for (const line of result.lines) console.log(line);
    return result.groups === 0 ? 0 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // An error from the driver can contain the connection string: it goes through the redactor.
    console.error(redactConnectionStrings(String(error instanceof Error ? error.message : error)));
    process.exit(1);
  }
);
