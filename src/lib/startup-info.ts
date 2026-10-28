// What the server says about itself when it starts: one line of settings (no secrets, no addresses) and the warnings that need
// a human. Nothing here prints a value that came from a secret or a host.

import { effectiveClientIpSource, isR2DevHost, type Env } from "../config/env.js";

/** The build's commit, shortened, when the host provides one. */
export function buildCommit(source: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of ["RENDER_GIT_COMMIT", "GIT_COMMIT", "SOURCE_COMMIT", "VERCEL_GIT_COMMIT_SHA"]) {
    const value = source[name]?.trim();
    if (value && /^[0-9a-f]{7,64}$/i.test(value)) return value.slice(0, 7).toLowerCase();
  }
  return null;
}

/** One line: the settings an operator wants to see at a glance. */
export function startupSummary(env: Env, source: NodeJS.ProcessEnv = process.env): string {
  const commit = buildCommit(source);
  return [
    `APP_ENV=${env.APP_ENV}`,
    `NODE_ENV=${env.NODE_ENV}`,
    `client-ip=${effectiveClientIpSource(env)}`,
    `scheduler=${env.SCHEDULER_ENABLED ? "on" : "off"}`,
    `retention=${env.RETENTION_DRY_RUN ? "dry-run" : "deleting"}`,
    `commit=${commit ?? "unknown"}`,
  ].join(" ");
}

/** Warnings for the log at start-up. Masked: they name the setting, never the value. */
export function startupWarnings(env: Env): string[] {
  const warnings: string[] = [];
  if (env.PUBLIC_STOCK_IMAGE_BASE_URL !== undefined && env.APP_ENV !== "production") {
    try {
      if (isR2DevHost(new URL(env.PUBLIC_STOCK_IMAGE_BASE_URL).hostname)) {
        warnings.push("PUBLIC_STOCK_IMAGE_BASE_URL is an r2.dev address: fine for trying things out, not for production (production needs a custom domain)");
      }
    } catch {
      /* already rejected by the settings check */
    }
  }
  return warnings;
}
