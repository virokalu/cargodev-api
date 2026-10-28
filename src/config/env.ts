// Validated environment. Fails fast with a clear message instead of failing
// mid-request. Variable names are documented in docs/env.md; update that file,
// .env.example and the CI dummy env in the same change as this one.

import { z } from "zod";

// Not addresses: a client address is never read from these.
const FORBIDDEN_IP_HEADERS = new Set(["authorization", "cookie", "set-cookie", "host", "content-type", "content-length", "user-agent", "origin", "referer", "accept"]);

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
  // Where the client address (request.ip, rate-limit keys, logs) comes from.
  //   socket (default): the TCP peer. Every forwarding header is ignored, so none can be spoofed.
  //   hops: X-Forwarded-For, trusting exactly TRUST_PROXY_HOPS proxies you control (needs TRUST_PROXY_HOPS > 0).
  //   header: the single header named by CLIENT_IP_HEADER. Safe ONLY when the host's edge overwrites that header on every
  //           request (a client-supplied copy must never reach this server). A missing or invalid value falls back to the socket.
  // Unset means: hops when TRUST_PROXY_HOPS > 0 (the old behaviour), otherwise socket.
  CLIENT_IP_SOURCE: z.enum(["socket", "hops", "header"], { error: "CLIENT_IP_SOURCE must be socket, hops or header" }).optional(),
  CLIENT_IP_HEADER: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "CLIENT_IP_HEADER must be a plain header name such as true-client-ip")
    .max(64)
    .refine((name) => !FORBIDDEN_IP_HEADERS.has(name), "CLIENT_IP_HEADER cannot be a header that is not an address")
    .optional(),
  // Database connections this instance may hold open (the pool size). Keep it below the database pooler's limit divided by instances.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // After SIGTERM the whole shutdown (stop accepting, close streams, wait for a running job, disconnect) must finish within
  // this many milliseconds, or the process exits anyway.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  // Of that, how long a running scheduled job may take to finish. Must be shorter than SHUTDOWN_TIMEOUT_MS.
  SCHEDULER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(110_000).default(20_000),
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
  // How long a link the API gives STAFF for viewing a stored file stays valid, in seconds (60 to 900, default 600). The
  // links are signed, point at the storage API (not a public address) and are never stored: a client asks again.
  // Retention (the daily job). Days after which expired one-time codes, expired or revoked sessions (customer and staff), READ
  // customer alerts, and never-verified self-registered customers (with nothing linked to them) are removed. Chats and
  // enquiries are not touched: their retention is an open business question (docs/privacy-checklist.md).
  // Dry run is the DEFAULT, in every environment: the job only counts what it WOULD remove and logs the counts. Set this to
  // false, on purpose, to let it delete. Must be exactly "true" or "false".
  RETENTION_DRY_RUN: z
    .enum(["true", "false"], { error: "RETENTION_DRY_RUN must be true or false" })
    .default("true")
    .transform((value) => value === "true"),
  RETENTION_OTP_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  RETENTION_SESSION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  RETENTION_ALERT_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  UNVERIFIED_ACCOUNT_DAYS: z.coerce.number().int().min(1).max(3650).default(14),
  // How long (seconds) the API remembers that a staff user is still active and which role they hold, before it reads the
  // database again. Changes made in this process apply at once; another instance sees them within this time. 0 turns it off.
  STAFF_AUTH_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
  STAFF_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
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
  // Keys the HMAC that protects one-time codes at rest (a 6-digit code has only a million values, so an unkeyed hash
  // could be reversed instantly). At least 32 bytes, random, unique per environment, and different from both JWT
  // secrets. Required whenever the customer API is configured (CUSTOMER_JWT_SECRET is set).
  OTP_PEPPER: z
    .string()
    .refine((value) => Buffer.byteLength(value, "utf8") >= 32, "OTP_PEPPER must be at least 32 bytes")
    .optional(),
  // true: anyone can register a customer account (it still needs a verified email). false: register
  // does nothing; staff create customers and enable their login.
  CUSTOMER_SELF_SIGNUP: z
    .enum(["true", "false"], { error: "CUSTOMER_SELF_SIGNUP must be true or false" })
    .default("true")
    .transform((value) => value === "true"),
  // The public website API (/api/public). Off by default: with it off none of those routes exist.
  PUBLIC_STOCK_ENABLED: z
    .enum(["true", "false"], { error: "PUBLIC_STOCK_ENABLED must be true or false" })
    .default("false")
    .transform((value) => value === "true"),
  // Comma-separated website origins allowed to call /api/public from a browser. Empty means none. Never "*".
  // Separate from CORS_ALLOWED_ORIGINS (the staff and customer apps).
  PUBLIC_ALLOWED_ORIGINS: z.string().default(""),
  // The public base URL (a custom domain on the PUBLIC stock bucket) that stock images are served from.
  // Unset means stock images are not shown. Never the private bucket's address.
  PUBLIC_STOCK_IMAGE_BASE_URL: z.string().url().optional(),
  // The PUBLIC bucket stock images are uploaded to (same R2 account and credentials as the private one, a different
  // bucket). Unset means stock image uploads are refused.
  R2_PUBLIC_STOCK_BUCKET_NAME: z.string().min(1).optional(),
  // Cloudflare Turnstile secret for the enquiry form. Unset means the check is skipped.
  TURNSTILE_SECRET: z.string().min(1).optional(),
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
  // No silent default in production: behind a load balancer the default (socket) makes every visitor share one rate-limit
  // bucket, and a wrong "trust" guess lets clients pick their own address. The operator must choose, on purpose.
  if (env.NODE_ENV === "production" && env.CLIENT_IP_SOURCE === undefined) {
    ctx.addIssue({ code: "custom", path: ["CLIENT_IP_SOURCE"], message: "CLIENT_IP_SOURCE must be set explicitly in production (socket, hops or header)" });
  }
  if (env.CLIENT_IP_SOURCE === "header" && env.CLIENT_IP_HEADER === undefined) {
    ctx.addIssue({ code: "custom", path: ["CLIENT_IP_HEADER"], message: "CLIENT_IP_HEADER is required when CLIENT_IP_SOURCE is header" });
  }
  if (env.CLIENT_IP_SOURCE === "hops" && env.TRUST_PROXY_HOPS === 0) {
    ctx.addIssue({ code: "custom", path: ["TRUST_PROXY_HOPS"], message: "TRUST_PROXY_HOPS must be above 0 when CLIENT_IP_SOURCE is hops" });
  }
  if (env.SCHEDULER_SHUTDOWN_TIMEOUT_MS >= env.SHUTDOWN_TIMEOUT_MS) {
    ctx.addIssue({ code: "custom", path: ["SCHEDULER_SHUTDOWN_TIMEOUT_MS"], message: "SCHEDULER_SHUTDOWN_TIMEOUT_MS must be shorter than SHUTDOWN_TIMEOUT_MS" });
  }
  if (env.PUBLIC_ALLOWED_ORIGINS.split(",").some((origin) => origin.trim() === "*")) {
    ctx.addIssue({ code: "custom", path: ["PUBLIC_ALLOWED_ORIGINS"], message: "PUBLIC_ALLOWED_ORIGINS must list origins, never *" });
  }
  if (env.R2_PUBLIC_STOCK_BUCKET_NAME !== undefined && env.R2_ACCOUNT_ID === undefined) {
    ctx.addIssue({ code: "custom", path: ["R2_PUBLIC_STOCK_BUCKET_NAME"], message: "R2_PUBLIC_STOCK_BUCKET_NAME needs the R2 credentials" });
  }
  if (env.CUSTOMER_JWT_SECRET !== undefined && env.OTP_PEPPER === undefined) {
    ctx.addIssue({ code: "custom", path: ["OTP_PEPPER"], message: "OTP_PEPPER is required when CUSTOMER_JWT_SECRET is set" });
  }
  if (env.OTP_PEPPER !== undefined && (env.OTP_PEPPER === env.MOBILE_JWT_SECRET || env.OTP_PEPPER === env.CUSTOMER_JWT_SECRET)) {
    ctx.addIssue({ code: "custom", path: ["OTP_PEPPER"], message: "OTP_PEPPER must differ from the JWT secrets" });
  }
  if (env.CUSTOMER_JWT_SECRET !== undefined && env.CUSTOMER_JWT_SECRET === env.MOBILE_JWT_SECRET) {
    ctx.addIssue({ code: "custom", path: ["CUSTOMER_JWT_SECRET"], message: "CUSTOMER_JWT_SECRET must differ from MOBILE_JWT_SECRET" });
  }
});

export type Env = z.infer<typeof envSchema>;

/** The client address source in effect: the explicit setting, or (unset) hops when TRUST_PROXY_HOPS > 0, otherwise socket. */
export function effectiveClientIpSource(env: Pick<Env, "CLIENT_IP_SOURCE" | "TRUST_PROXY_HOPS">): "socket" | "hops" | "header" {
  return env.CLIENT_IP_SOURCE ?? (env.TRUST_PROXY_HOPS > 0 ? "hops" : "socket");
}

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
