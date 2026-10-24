// The single default org. Phase 1 has one org, so the login lookup (no token
// exists yet) and the daily cron (no user at all) need a default. This is the
// ONLY place that reads ORG_ID. Everything else takes orgId from the verified
// token (CLAUDE.md rule 1).

import { loadEnv } from "./env.js";

export function getDefaultOrgId(): string {
  return loadEnv().ORG_ID;
}
