// Read-only audit before the main bucket is made private.
//
//   npm run r2:audit
//
// Prints COUNTS only:
//   1. objects in the bucket, per top-level folder (the first path segment), never a key or a file name;
//   2. rows in the database whose stored file address starts with the configured public address versus any other address.
// It reads credentials from the environment (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME,
// R2_PUBLIC_URL, DATABASE_URL) and never prints them, an address, a key, a host or an error object. The bucket is only listed
// (ListObjectsV2); the database session is read-only and only counts. Nothing is written anywhere.

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import pg from "pg";
import { createR2Client } from "../src/lib/r2-object-store.js";

export interface ListPage {
  keys: string[];
  next?: string;
}

/** Fetches one page of keys. In production this is ListObjectsV2; the tests use a fake. */
export type ListPageFn = (continuationToken?: string) => Promise<ListPage>;

const ROOT = "(root)";
const MAX_PAGES = 100_000;

/** Counts objects per top-level folder. Only counts leave this function: no key, no file name. */
export async function countObjectsByPrefix(listPage: ListPageFn): Promise<{ byPrefix: Map<string, number>; total: number }> {
  const byPrefix = new Map<string, number>();
  let total = 0;
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { keys, next } = await listPage(token);
    for (const key of keys) {
      const slash = key.indexOf("/");
      const prefix = slash > 0 ? key.slice(0, slash) : ROOT;
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
      total += 1;
    }
    if (!next) break;
    token = next;
  }
  return { byPrefix, total };
}

export interface QueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface UrlColumnCount {
  column: string;
  total: number;
  onPublicHost: number;
  elsewhere: number;
}

const COLUMNS: { label: string; table: string; column: string }[] = [
  { label: "VehiclePhoto.url", table: "VehiclePhoto", column: "url" },
  { label: "VehicleDocument.url", table: "VehicleDocument", column: "url" },
  { label: "Vehicle.auctionSheetUrl", table: "Vehicle", column: "auctionSheetUrl" },
];

/** A LIKE pattern that matches the literal address (the percent sign, underscore and backslash are escaped). */
export function likePrefix(base: string): string {
  return `${base.replace(/\/+$/, "").replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
}

export async function countUrlRows(client: QueryClient, publicBase: string): Promise<UrlColumnCount[]> {
  const pattern = likePrefix(publicBase);
  const out: UrlColumnCount[] = [];
  for (const { label, table, column } of COLUMNS) {
    // identifiers come from the fixed list above, never from input
    const result = await client.query(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE "${column}" LIKE $1))::int AS matching FROM "${table}" WHERE "${column}" IS NOT NULL`,
      [pattern]
    );
    const row = result.rows[0] ?? {};
    const total = Number(row["total"] ?? 0);
    const onPublicHost = Number(row["matching"] ?? 0);
    out.push({ column: label, total, onPublicHost, elsewhere: total - onPublicHost });
  }
  return out;
}

export interface AuditReport {
  objects: { byPrefix: Map<string, number>; total: number };
  urls: UrlColumnCount[];
}

/** Numbers and fixed labels only. */
export function formatAudit(report: AuditReport): string {
  const lines = ["objects in the bucket, per top-level folder (counts only)"];
  for (const [prefix, count] of [...report.objects.byPrefix].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`  ${prefix}: ${count}`);
  lines.push(`  total: ${report.objects.total}`, "", "stored file addresses in the database");
  for (const u of report.urls) lines.push(`  ${u.column}: ${u.total} rows, ${u.onPublicHost} on the configured public address, ${u.elsewhere} elsewhere`);
  return lines.join("\n");
}

const need = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
};

async function main(): Promise<void> {
  const accountId = need("R2_ACCOUNT_ID");
  const accessKeyId = need("R2_ACCESS_KEY_ID");
  const secretAccessKey = need("R2_SECRET_ACCESS_KEY");
  const bucket = need("R2_BUCKET_NAME");
  const publicBase = need("R2_PUBLIC_URL");
  const databaseUrl = need("DATABASE_URL");
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBase || !databaseUrl) {
    console.error("Missing settings: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL and DATABASE_URL must all be set.");
    process.exitCode = 1;
    return;
  }

  const db = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  try {
    const s3 = createR2Client({ accountId, accessKeyId, secretAccessKey, bucket });
    const objects = await countObjectsByPrefix(async (token) => {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }));
      return { keys: (page.Contents ?? []).map((o) => o.Key ?? "").filter(Boolean), ...(page.IsTruncated && page.NextContinuationToken ? { next: page.NextContinuationToken } : {}) };
    });
    await db.connect();
    await db.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const urls = await countUrlRows(db, publicBase);
    console.log(formatAudit({ objects, urls }));
  } catch {
    // Never print the error object: a driver or SDK message can contain an address, a key or an account id.
    console.error("The audit could not finish (a connection or permission problem). Nothing was changed.");
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => undefined);
  }
}

// Run only when started directly, not when imported by the tests.
if (process.argv[1] && /r2-audit\.[cm]?[jt]s$/.test(process.argv[1])) await main();
