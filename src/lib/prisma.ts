// Lazy Prisma client. Nothing connects, and no env is read, until the first
// getPrisma() call, so importing a service in a unit test needs no database.
//
// Prisma 7 needs a driver adapter at runtime; @prisma/adapter-pg wraps `pg`.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadEnv } from "../config/env.js";

let client: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!client) {
    const env = loadEnv();
    const adapter = new PrismaPg({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
      max: env.DATABASE_POOL_MAX,
    });
    client = new PrismaClient({
      adapter,
      log: env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
      transactionOptions: {
        maxWait: 5000, // time to acquire a connection and open the transaction
        timeout: 15000, // time the callback has to run before commit
      },
    });
  }
  return client;
}

/** Closes the connection pool (shutdown). Safe to call when nothing ever connected, and more than once. */
export async function disconnectPrisma(): Promise<void> {
  const current = client;
  client = undefined;
  if (current) await current.$disconnect();
}
