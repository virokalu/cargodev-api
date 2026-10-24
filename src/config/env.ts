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
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment variables: ${names.join(", ")}. See docs/env.md.`);
  }
  cached = parsed.data;
  return cached;
}
