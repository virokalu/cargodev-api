// Failure counting for emails that have NO eligible account (unknown, disabled,
// a customer row, or another org). Without this, only real accounts ever answer
// "locked", so a caller could tell real emails from fake ones by hammering a
// login. This mirrors the real lockout exactly: 5 failures lock for 15 minutes,
// and the counter is not reset when the lock expires, so one more failure
// relocks immediately (same as the failedLoginAttempts column).
//
// In memory, per process, best effort. With several instances an attacker gets
// 5 attempts per instance per email on non-existent accounts; the per-IP rate
// limit still applies on top. It stores only normalized emails, capped in size.

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 10_000;

interface Entry {
  failures: number;
  lockedUntil: number;
}

const entries = new Map<string, Entry>();

export function isShadowLocked(email: string, now = Date.now()): boolean {
  const entry = entries.get(email);
  return entry !== undefined && entry.lockedUntil > now;
}

export function recordShadowFailure(email: string, now = Date.now()): void {
  const previous = entries.get(email);
  const failures = (previous?.failures ?? 0) + 1;
  // Re-insert so the most recently active emails sit at the end of the Map.
  entries.delete(email);
  entries.set(email, { failures, lockedUntil: failures >= MAX_FAILURES ? now + LOCKOUT_MS : (previous?.lockedUntil ?? 0) });

  if (entries.size > MAX_ENTRIES) {
    // Drop expired entries first, then the oldest, so random-email spam cannot grow memory without bound.
    for (const [key, value] of entries) {
      if (value.lockedUntil <= now) entries.delete(key);
      if (entries.size <= MAX_ENTRIES) return;
    }
    for (const key of entries.keys()) {
      entries.delete(key);
      if (entries.size <= MAX_ENTRIES) return;
    }
  }
}

/** Test helper. */
export function resetShadowLockouts(): void {
  entries.clear();
}
