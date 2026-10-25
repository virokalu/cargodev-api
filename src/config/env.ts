// Validated environment. Fails fast with a clear message instead of failing
// mid-request. Variable names are documented in docs/env.md; update that file,
// .env.example and the CI dummy env in the same change as this one.

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Comma-separated browser origins allowed by CORS. Empty means none. Never "*".
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  // How many reverse proxies in front of this server we control and trust to set
  // X-Forwarded-For. 0 (default) trusts none: the client IP is the socket address
  // and the header is ignored, so it cannot be spoofed to dodge rate limits.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  // Most simultaneous GET /notifications/stream connections on this instance.
  SSE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100000).default(500),
  // UTC hour (0-23) the daily job runs at.
  DAILY_JOB_UTC_HOUR: z.coerce.number().int().min(0).max(23).default(2),
  // false on instances (and in tests) that must not run scheduled jobs.
  SCHEDULER_ENABLED: z
    .enum(["true", "false"], { error: "SCHEDULER_ENABLED must be true or false" })
    .default("true")
    .transform((value) => value === "true"),
  // Public base URL that uploaded files are served from (for example https://files.example.test).
  // Every file URL a client sends is checked against it AND against the caller's own org folder, so
  // it must be set before files can be attached. Unset means "storage not configured": file URLs are
  // refused (fail closed) rather than accepted unchecked.
  R2_PUBLIC_URL: z.string().url().optional(),
  // Optional. Only raises Expo push rate limits; push works without it.
  EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
  // Signs access tokens. Long and random, unique per environment.
  MOBILE_JWT_SECRET: z.string().min(32, "MOBILE_JWT_SECRET must be at least 32 characters"),
  // Default org for login lookup and cron only. See config/default-org.ts.
  ORG_ID: z.string().min(1, "ORG_ID is required"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parses process.env once. Throws listing the invalid variable names (never values). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  // A variable that is present but EMPTY (for example `EXPO_ACCESS_TOKEN=` copied from
  // .env.example) means "not set". Without this an empty optional value fails validation, and an
  // empty required one would be accepted by a bare z.string(). Names only, never values, are reported.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment variables: ${names.join(", ")}. See docs/env.md.`);
  }
  cached = parsed.data;
  return cached;
}
