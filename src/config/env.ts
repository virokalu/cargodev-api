// Validated environment. Fails fast with a clear message instead of failing
// mid-request. Variable names are documented in docs/env.md; update that file,
// .env.example and the CI dummy env in the same change as this one.

import { z } from "zod";

const baseSchema = z.object({
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
  // Object storage (Cloudflare R2). All four or none: a half-configured store is refused at startup.
  // Used to sign uploads and downloads and to delete files. R2_PUBLIC_URL above is separate (the public base).
  // The Cloudflare account id: 32 hex characters. It becomes part of the R2 hostname, so anything else is refused.
  R2_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/i, "R2_ACCOUNT_ID must be the 32-character Cloudflare account id").optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET_NAME: z.string().min(1).optional(),
  // How long a customer's browser or app may cache a file served by the API, in seconds (Cache-Control: private).
  CUSTOMER_FILE_CACHE_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
  // Days after a vehicle's SHIPPED milestone before staff are reminded that no arrival has been recorded (then weekly).
  ARRIVAL_REMINDER_DAYS: z.coerce.number().int().min(1).max(365).default(45),
  // The oldest customer app build the API still serves (GET /api/customer/v1/app/min-version). Raise it to force an update.
  APP_MIN_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/, "APP_MIN_VERSION must look like 1.2.3").default("1.0.0"),
  // Optional. Only raises Expo push rate limits; push works without it.
  EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
  // Transactional email through the Resend HTTP API (src/lib/email.ts). Both optional: with no
  // RESEND_API_KEY nothing is ever sent, the message is only noted in the log (masked).
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).optional(),
  // Signs CUSTOMER access tokens (a separate zone from staff). Long and random, unique per environment and
  // different from MOBILE_JWT_SECRET (startup fails if they are equal). Unset means the customer API is
  // not mounted at all.
  CUSTOMER_JWT_SECRET: z.string().min(32, "CUSTOMER_JWT_SECRET must be at least 32 characters").optional(),
  // true: anyone can register a customer account (it still needs a verified email). false: register
  // does nothing; staff create customers and enable their login.
  CUSTOMER_SELF_SIGNUP: z
    .enum(["true", "false"], { error: "CUSTOMER_SELF_SIGNUP must be true or false" })
    .default("true")
    .transform((value) => value === "true"),
  // Signs access tokens. Long and random, unique per environment.
  MOBILE_JWT_SECRET: z.string().min(32, "MOBILE_JWT_SECRET must be at least 32 characters"),
  // Default org for login lookup and cron only. See config/default-org.ts.
  ORG_ID: z.string().min(1, "ORG_ID is required"),
});

const R2_CREDENTIALS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"] as const;

const envSchema = baseSchema.superRefine((env, ctx) => {
  const set = R2_CREDENTIALS.filter((name) => env[name] !== undefined);
  if (set.length > 0 && set.length < R2_CREDENTIALS.length) {
    for (const name of R2_CREDENTIALS) {
      if (env[name] === undefined) ctx.addIssue({ code: "custom", path: [name], message: `${name} is required when any R2 credential is set` });
    }
  }
  if (env.CUSTOMER_JWT_SECRET !== undefined && env.CUSTOMER_JWT_SECRET === env.MOBILE_JWT_SECRET) {
    ctx.addIssue({ code: "custom", path: ["CUSTOMER_JWT_SECRET"], message: "CUSTOMER_JWT_SECRET must differ from MOBILE_JWT_SECRET" });
  }
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
