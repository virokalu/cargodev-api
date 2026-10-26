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
import { registerCustomerAdminRoutes } from "./routes/customer-admin.js";
import { registerCustomerAuthRoutes } from "./routes/customer-auth.js";
import { registerCustomerDataRoutes } from "./routes/customer-data.js";
import { registerCustomerFileRoutes } from "./routes/customer-files.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerLookupRoutes } from "./routes/lookups.js";
import { registerMilestoneRoutes } from "./routes/milestones.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerVehicleReleaseRoutes } from "./routes/vehicle-release.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { SseHub } from "./lib/sse-hub.js";
import { objectStoreConfigured, setObjectStore } from "./lib/object-storage.js";
import { createR2ObjectStore } from "./lib/r2-object-store.js";
import { registerAdminJobRoutes } from "./routes/admin-jobs.js";
import { Scheduler, defaultJobs, type ScheduledJob } from "./scheduler/index.js";
import { registerOrganizationRoutes } from "./routes/organization.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerStaffRoutes } from "./routes/staff.js";
import { registerVehicleRoutes } from "./routes/vehicles.js";

declare module "fastify" {
  interface FastifyInstance {
    sseHub: SseHub;
    scheduler: Scheduler;
  }
}

export interface BuildAppOptions {
  /** Pino logging. Off in tests. Authorization and cookie headers are always redacted. */
  logger?: boolean;
  /** Where logs go when logger is on. Tests capture it to prove secrets never reach logs. */
  logStream?: NodeJS.WritableStream;
  /** Per-IP limits. Tests that hammer one route turn this off. */
  rateLimit?: boolean;
  /** Overrides CORS_ALLOWED_ORIGINS. */
  corsOrigins?: string[];
  /** Jobs to register. Defaults to the production set (see scheduler/index.ts). */
  jobs?: ScheduledJob[];
  /** Replace the scheduler entirely (tests). */
  scheduler?: Scheduler;
  /** Overrides TRUST_PROXY_HOPS. */
  trustProxyHops?: number;
}

/** Trust exactly the first `hops` addresses in the chain (the socket peer is hop 0),
 * never "all". Fastify no longer accepts a bare hop count because it cannot check
 * who the immediate peer is: this is only safe when the server is reachable ONLY
 * through the proxy(ies) we control. See docs/runbook.md. */
function trustHops(hops: number) {
  return (_address: string, hop: number): boolean => hop < hops;
}

export const GLOBAL_RATE_LIMIT = { max: 300, timeWindow: "1 minute" } as const;

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = loadEnv();

  const trustProxyHops = options.trustProxyHops ?? env.TRUST_PROXY_HOPS;

  // Object storage (R2): installed when all four credentials are set (env validation guarantees all or none).
  // Tests install their own recorder first, which is left alone.
  if (!objectStoreConfigured() && env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET_NAME) {
    setObjectStore(
      createR2ObjectStore({
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET_NAME,
      })
    );
  }

  const app = Fastify({
    trustProxy: trustProxyHops > 0 ? trustHops(trustProxyHops) : false,
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
  app.decorateRequest("tokenExpiresAt", null);
  app.decorateRequest("customer", null);
  app.decorateRequest("customerTokenExpiresAt", null);

  // Open notification streams on this instance.
  const sseHub = new SseHub({ maxConnections: env.SSE_MAX_CONNECTIONS });
  app.decorate("sseHub", sseHub);
  // Long-lived streams would otherwise hold app.close() open forever. preClose runs
  // before the server stops accepting, and tells every client to reconnect elsewhere.
  app.addHook("preClose", async () => {
    sseHub.closeAll();
  });

  // The scheduler is created here but started by server.ts, so building an app (tests,
  // tooling) never arms a timer. app.close() stops it and waits for a running job.
  const scheduler =
    options.scheduler ??
    new Scheduler({
      jobs: options.jobs ?? defaultJobs(),
      utcHour: env.DAILY_JOB_UTC_HOUR,
      enabled: env.SCHEDULER_ENABLED,
      logger: app.log,
    });
  app.decorate("scheduler", scheduler);
  app.addHook("onClose", async () => {
    await scheduler.stop();
  });

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
      registerNotificationRoutes(api, { sseHub });
      registerAdminJobRoutes(api, { scheduler });
      registerVehicleRoutes(api);
      registerMilestoneRoutes(api);
      registerUploadRoutes(api);
      registerCustomerAdminRoutes(api);
      registerVehicleReleaseRoutes(api);
    },
    { prefix: "/api/v1" }
  );

  // The customer zone: its own prefix, guard, secret and session table. Not mounted unless it is configured.
  if (env.CUSTOMER_JWT_SECRET) {
    await app.register(
      async (customerApi) => {
        registerCustomerAuthRoutes(customerApi);
        registerCustomerFileRoutes(customerApi);
        registerCustomerDataRoutes(customerApi);
      },
      { prefix: "/api/customer/v1" }
    );
  }

  return app;
}
