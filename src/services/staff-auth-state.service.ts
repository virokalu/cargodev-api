// The one place that answers "is this staff user still allowed in, and with which role, RIGHT NOW?".
//
// An access token lives up to 20 minutes and carries a role claim. The claim is only a hint to who signed in: every staff
// route and every staff stream asks this function, which reads the DATABASE (loginEnabled, role, name), through a small
// in-process cache so a busy app does not read the user row on every request.
//
// Cache rules:
//  - STAFF_AUTH_CACHE_SECONDS (0 to 300, default 30; 0 turns the cache off). Entries are keyed by org AND user.
//  - Anything in THIS process that creates, edits, deactivates or changes the role of a staff account calls
//    invalidateStaffAuth(), so the change applies on the very next request here. Another instance sees it within the
//    cache time (the cache is per process, like the rate limiters).
//  - An invalidation that lands while a read is in flight also stops that read from being cached (generation counter), so
//    an old answer can never be stored after the change.
//  - Streams ask with bypassCache: they re-check every 60 seconds against the database itself.
//  - "Not allowed" (no such user in this org, a customer row, a disabled account, no role) is one answer, null. It is
//    cached too, so probing with made-up ids costs the database one read per cache time, not one per request.

import type { StaffRole } from "@prisma/client";
import { loadEnv } from "../config/env.js";
import { getPrisma } from "../lib/prisma.js";

export interface FreshStaffAuth {
  id: string;
  orgId: string;
  role: StaffRole;
  name: string;
  email: string | null;
}

interface Entry {
  value: FreshStaffAuth | null;
  expiresAt: number;
}

const MAX_ENTRIES = 5_000;
const cache = new Map<string, Entry>();
let generation = 0;

const keyFor = (orgId: string, userId: string) => `${orgId}\u0000${userId}`;

/** The staff user's current authorization, or null when they may not use the API (missing, other org, disabled, not staff). */
export async function getFreshStaffAuth(userId: string, orgId: string, options: { bypassCache?: boolean } = {}): Promise<FreshStaffAuth | null> {
  const ttlMs = loadEnv().STAFF_AUTH_CACHE_SECONDS * 1000;
  const key = keyFor(orgId, userId);

  if (ttlMs > 0 && !options.bypassCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const startedAt = generation;
  const row = await getPrisma().user.findFirst({
    where: { id: userId, org_id: orgId, userType: "STAFF", loginEnabled: true },
    select: { role: true, name: true, email: true },
  });
  const value: FreshStaffAuth | null = row && row.role ? { id: userId, orgId, role: row.role, name: row.name, email: row.email } : null;

  if (ttlMs > 0 && generation === startedAt) {
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
  return value;
}

/** Call after a staff account is created, edited, deactivated, reactivated or has its role changed (after the commit). */
export function invalidateStaffAuth(orgId: string, userId: string): void {
  generation += 1;
  cache.delete(keyFor(orgId, userId));
}

/** Forgets everything (tests, and a safe reset). */
export function clearStaffAuthCache(): void {
  generation += 1;
  cache.clear();
}
