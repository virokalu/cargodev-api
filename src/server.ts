// Loads env, builds the app, listens, starts the scheduler, and shuts down cleanly.

import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { disconnectPrisma } from "./lib/prisma.js";
import { startupSummary, startupWarnings } from "./lib/startup-info.js";
import { createShutdown } from "./lib/shutdown.js";

const env = loadEnv();
const app = await buildApp({ logger: true });

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.scheduler.start();
  app.log.info(startupSummary(env));
  for (const warning of startupWarnings(env)) app.log.warn(warning);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// Graceful shutdown (src/lib/shutdown.ts): stop accepting requests, close streams (clients get `event: shutdown`), wait for
// a running job (up to SCHEDULER_SHUTDOWN_TIMEOUT_MS), close the database pool, all within SHUTDOWN_TIMEOUT_MS.
const shutdown = createShutdown({
  close: () => app.close(),
  disconnect: disconnectPrisma,
  exit: (code) => process.exit(code),
  log: { info: (obj, msg) => app.log.info(obj, msg), error: (obj, msg) => app.log.error(obj, msg) },
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
});
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
