// How far away is the database? Sends 50 sequential `SELECT 1` and prints ONLY min, p50, p95 and max in milliseconds.
//
//   npm run db:latency
//
// Read-only: the session is set read-only before anything runs, and the only statement is SELECT 1. It uses DATABASE_URL (the
// runtime connection, the session pooler), never MIGRATION_DATABASE_URL. It prints no URL, host, user or password, and an error
// is reported as a short generic line. Nothing is written anywhere.

import pg from "pg";

export const SAMPLES = 50;

export interface QueryClient {
  query(sql: string): Promise<unknown>;
}

export interface LatencyReport {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** The value at percentile p (0 to 100) of an ascending list, nearest-rank. */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length, Math.max(1, rank)) - 1]!;
}

/** Runs the statements one after another and times each SELECT 1. `now` is injected so tests need no clock. */
export async function measureLatency(client: QueryClient, samples = SAMPLES, now: () => number = () => performance.now()): Promise<LatencyReport> {
  await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const timings: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = now();
    await client.query("SELECT 1");
    timings.push(now() - started);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  return { samples, minMs: sorted[0] ?? 0, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95), maxMs: sorted[sorted.length - 1] ?? 0 };
}

const fixed = (value: number) => value.toFixed(1);

/** Four lines of numbers and nothing else. */
export function formatReport(report: LatencyReport): string {
  return [`samples ${report.samples}`, `min ${fixed(report.minMs)} ms`, `p50 ${fixed(report.p50Ms)} ms`, `p95 ${fixed(report.p95Ms)} ms`, `max ${fixed(report.maxMs)} ms`].join("\n");
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exitCode = 1;
    return;
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    console.log(formatReport(await measureLatency(client)));
  } catch {
    // Never print the error object: a driver message can contain the host or user name.
    console.error("Could not measure the database latency (connection or query failed).");
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

// Run only when started directly, not when imported by the tests.
if (process.argv[1] && /db-latency\.[cm]?[jt]s$/.test(process.argv[1])) await main();
