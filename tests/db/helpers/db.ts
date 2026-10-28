// Real-database test client and helpers. Every connection goes through the safety guard.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertSafeTestDatabaseUrl } from "../guard.js";

let client: PrismaClient | undefined;

/** Connection pool size. Concurrency tests need several connections. */
const poolMax = () => Number(process.env["TEST_DATABASE_POOL_MAX"] ?? 10);

export function getTestPrisma(): PrismaClient {
  if (!client) {
    // Re-checked here as well as in global setup: defence in depth.
    const db = assertSafeTestDatabaseUrl(process.env["TEST_DATABASE_URL"]);
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: db.url, max: poolMax() }),
      log: ["error"],
    });
  }
  return client;
}

export async function closeTestPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

/** Empties every table, keeping the schema. Run before each test for isolation. */
export async function resetDb(prisma: PrismaClient = getTestPrisma()): Promise<void> {
  assertSafeTestDatabaseUrl(process.env["TEST_DATABASE_URL"]);
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
