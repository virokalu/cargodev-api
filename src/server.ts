// Loads env, builds the app, listens, starts the scheduler, and shuts down cleanly.

import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const app = await buildApp({ logger: true });

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.scheduler.start();
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// Graceful shutdown: close notification streams (clients get `event: shutdown`), stop arming
// timers, and let a running job finish (up to its timeout) before the process exits.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error, "error during shutdown");
    process.exit(1);
  }
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
