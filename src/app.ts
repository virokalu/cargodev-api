// Builds the Fastify app. Does not listen: server.ts starts it, tests use app.inject().

import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { effectiveClientIpSource, loadEnv } from "./config/env.js";
import { registerClientIpHeader } from "./lib/client-ip.js";
import { errorHandler, notFoundHandler } from "./lib/error-handler.js";
import { registerPostResponse } from "./lib/post-response.js";
import { success } from "./lib/response.js";
import { registerActivityLogRoutes } from "./routes/activity-log.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCustomerAdminRoutes } from "./routes/customer-admin.js";
import { registerCustomerChatRoutes } from "./routes/customer-chat.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerStaffChatRoutes } from "./routes/staff-chat.js";
import { registerStaffStockRoutes } from "./routes/staff-stock.js";
import { registerCustomerAuthRoutes } from "./routes/customer-auth.js";
import { registerCustomerDataRoutes } from "./routes/customer-data.js";
import { registerCustomerFileRoutes } from "./routes/customer-files.js";
import { registerCustomerNotificationRoutes } from "./routes/customer-notifications.js";
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
import { publicStockStoreConfigured, setPublicStockStore } from "./lib/public-stock-storage.js";
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
  /** Overrides CLIENT_IP_SOURCE / CLIENT_IP_HEADER (tests). */
  clientIp?: { source: "socket" | "hops" | "header"; header?: string };
  /** Receives the masked warning when the client address header is missing or invalid (tests). */
  onClientIpWarning?: (message: string) => void;
  /** Overrides PUBLIC_STOCK_ENABLED (the public website API and the staff stock tools). */
  publicStockEnabled?: boolean;
  /** Overrides PUBLIC_ALLOWED_ORIGINS. */
  publicOrigins?: string[];
  /** Called once for every route that gets registered. Tests use it to compare the real routes with an explicit table. */
  onRoute?: (route: { method: string; url: string }) => void;
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

  // Where request.ip comes from (lib/client-ip.ts). An explicit trustProxyHops option (tests) still means "hops".
  const clientIpSource = options.clientIp?.source ?? (options.trustProxyHops !== undefined ? (options.trustProxyHops > 0 ? "hops" : "socket") : effectiveClientIpSource(env));
  const clientIpHeader = options.clientIp?.header ?? env.CLIENT_IP_HEADER;
  const trustProxyHops = clientIpSource === "hops" ? (options.trustProxyHops ?? env.TRUST_PROXY_HOPS) : 0;

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

  // Public stock images go to a SEPARATE public bucket (same account and credentials, different bucket).
  if (!publicStockStoreConfigured() && env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_PUBLIC_STOCK_BUCKET_NAME) {
    setPublicStockStore(
      createR2ObjectStore({
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_PUBLIC_STOCK_BUCKET_NAME,
      })
    );
  }
  const publicStockEnabled = options.publicStockEnabled ?? env.PUBLIC_STOCK_ENABLED;

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

  // A test seam: report every route as it is registered (before any plugin adds one).
  if (options.onRoute) {
    const report = options.onRoute;
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) report({ method: String(method), url: route.url });
    });
  }

  // Every response, success or error, carries no-store: the data is authenticated and org-scoped.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  // Header mode: request.ip becomes the (validated) address in one named header. Registered FIRST, so the rate limiter
  // and the logs see it. In socket and hops modes no forwarding header is read here.
  if (clientIpSource === "header" && clientIpHeader) {
    registerClientIpHeader(app, { header: clientIpHeader, ...(options.onClientIpWarning ? { warn: options.onClientIpWarning } : {}) });
  }
  // Customer email is sent after the response (lib/post-response.ts).
  registerPostResponse(app);
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
      shutdownTimeoutMs: env.SCHEDULER_SHUTDOWN_TIMEOUT_MS,
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
  const publicOrigins =
    options.publicOrigins ??
    env.PUBLIC_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== "" && origin !== "*");
  await app.register(cors, {
    // Two allow-lists, chosen per request: the website origins for /api/public (read and enquire only, no Authorization
    // header, no credentials), the app origins for everything else. An origin is echoed only if it is on the list for
    // THAT route. Never "*".
    delegator: (request, callback) => {
      const isPublic = (request.url ?? "").startsWith("/api/public/");
      const list = isPublic ? publicOrigins : allowedOrigins;
      callback(null, {
        origin: (origin, check) => check(null, origin !== undefined && list.includes(origin)),
        methods: isPublic ? ["GET", "POST", "OPTIONS"] : ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: isPublic ? ["Content-Type"] : ["Authorization", "Content-Type"],
        ...(isPublic ? { maxAge: 600 } : {}),
      });
    },
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
      registerStaffChatRoutes(api);
      if (publicStockEnabled) registerStaffStockRoutes(api);
    },
    { prefix: "/api/v1" }
  );

  // The public website API: no login, its own prefix, its own CORS allow-list. Not mounted unless it is switched on.
  if (publicStockEnabled) {
    await app.register(async (publicApi) => registerPublicRoutes(publicApi), { prefix: "/api/public" });
  }

  // The customer zone: its own prefix, guard, secret and session table. Not mounted unless it is configured.
  if (env.CUSTOMER_JWT_SECRET) {
    await app.register(
      async (customerApi) => {
        registerCustomerAuthRoutes(customerApi);
        registerCustomerFileRoutes(customerApi);
        registerCustomerDataRoutes(customerApi);
        registerCustomerNotificationRoutes(customerApi);
        registerCustomerChatRoutes(customerApi);
      },
      { prefix: "/api/customer/v1" }
    );
  }

  return app;
}
