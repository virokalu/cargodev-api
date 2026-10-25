// Fixed-window counter keyed by a string (an email, a user id). In memory, per process, capped in size.
// Used for per-identifier limits next to the per-IP limits. The key is counted whether or not the
// account exists, so being limited never tells a caller anything about the account.

import type { Limit } from "../config/customer-rate-limits.js";

const MAX_KEYS = 50_000;

interface Window {
  count: number;
  resetAt: number;
}

export class IdentifierLimiter {
  private windows = new Map<string, Window>();

  /** Counts one hit. Returns true if the caller is within the limit, false if it must be refused. */
  hit(scope: string, identifier: string, limit: Limit, now = Date.now()): boolean {
    const key = `${scope}:${identifier}`;
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.delete(key);
      this.windows.set(key, { count: 1, resetAt: now + limit.windowMs });
      this.trim(now);
      return true;
    }
    current.count += 1;
    return current.count <= limit.max;
  }

  /** Test helper. */
  reset(): void {
    this.windows.clear();
  }

  private trim(now: number): void {
    if (this.windows.size <= MAX_KEYS) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
      if (this.windows.size <= MAX_KEYS) return;
    }
    for (const key of this.windows.keys()) {
      this.windows.delete(key);
      if (this.windows.size <= MAX_KEYS) return;
    }
  }
}

/** The one limiter the customer routes share. */
export const identifierLimiter = new IdentifierLimiter();
