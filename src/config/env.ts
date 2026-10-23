// Validated environment. Fails fast with a clear message instead of failing
// mid-request. Variable names are documented in docs/env.md; update that file,
// .env.example and the CI dummy env in the same change as this one.

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
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
