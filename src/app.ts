// Builds the Fastify app. Does not listen: server.ts starts it, tests use app.inject().

import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { loadEnv } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./lib/error-handler.js";
import { success } from "./lib/response.js";
import { registerActivityLogRoutes } from "./routes/activity-log.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerLookupRoutes } from "./routes/lookups.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerOrganizationRoutes } from "./routes/organization.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerStaffRoutes } from "./routes/staff.js";

export interface BuildAppOptions {
  /** Pino logging. Off in tests. Authorization and cookie headers are always redacted. */
  logger?: boolean;
  /** Where logs go when logger is on. Tests capture it to prove secrets never reach logs. */
  logStream?: NodeJS.WritableStream;
  /** Per-IP limits. Tests that hammer one route turn this off. */
  rateLimit?: boolean;
  /** Overrides CORS_ALLOWED_ORIGINS. */
  corsOrigins?: string[];
}

export const GLOBAL_RATE_LIMIT = { max: 300, timeWindow: "1 minute" } as const;

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = loadEnv();

  const app = Fastify({
    logger: options.logger
      ? {
          level: env.LOG_LEVEL,
          redact: ["req.headers.authorization", "req.headers.cookie"],
          ...(options.logStream ? { stream: options.logStream } : {}),
        }
      : false,
  });

  // Every response, success or error, carries no-store: the data is authenticated and org-scoped.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.decorateRequest("user", null);

  await app.register(helmet);

  const allowedOrigins =
    options.corsOrigins ??
    env.CORS_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== "" && origin !== "*");
  await app.register(cors, {
    // Echo the origin only if it is on the allow-list. Never "*".
    origin: (origin, callback) => callback(null, origin !== undefined && allowedOrigins.includes(origin)),
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  if (options.rateLimit !== false) {
    await app.register(rateLimit, { global: true, ...GLOBAL_RATE_LIMIT });
  }

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  app.get("/health", async () => success({ status: "ok" }));

  await app.register(
    async (api) => {
      registerAuthRoutes(api);
      registerCustomerRoutes(api);
      registerStaffRoutes(api);
      registerProfileRoutes(api);
      registerOrganizationRoutes(api);
      registerDashboardRoutes(api);
      registerReportRoutes(api);
      registerActivityLogRoutes(api);
      registerLookupRoutes(api);
      registerNotificationRoutes(api);
    },
    { prefix: "/api/v1" }
  );

  return app;
}
