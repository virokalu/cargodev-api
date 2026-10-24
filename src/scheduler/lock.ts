// Cross-instance job lock using a Postgres advisory lock.
//
// pg_try_advisory_xact_lock inside ONE transaction that wraps the whole run. It is
// released automatically when the transaction ends (commit, rollback, or the
// connection dying), so a crashed instance cannot leave a stuck lock. We deliberately
// do NOT use session-level pg_try_advisory_lock: through a pooled/transaction-mode
// connection the session can be handed to someone else, leaking or losing the lock.
//
// The transaction only holds the lock. The job does its real work in its own short
// transactions (batches), so no giant transaction and no long row locks.

import { createHash } from "node:crypto";
import { getPrisma } from "../lib/prisma.js";

/** How long one run may hold the lock before Prisma ends the transaction (and with it the lock). */
export const JOB_LOCK_TIMEOUT_MS = 30 * 60 * 1000;

export type LockResult<T> = { acquired: false } | { acquired: true; value: T };
export type LockFn = <T>(jobName: string, fn: () => Promise<T>) => Promise<LockResult<T>>;

/** A stable signed 64-bit key per job name, as pg_try_advisory_xact_lock(bigint) expects. */
export function jobLockKey(jobName: string): bigint {
  return createHash("sha256").update(`cargodev-api:job:${jobName}`).digest().readBigInt64BE(0);
}

export const withAdvisoryLock: LockFn = async (jobName, fn) => {
  const key = jobLockKey(jobName);
  return getPrisma().$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${key}::bigint) AS locked`;
      if (rows[0]?.locked !== true) return { acquired: false } as const;
      return { acquired: true, value: await fn() } as const;
    },
    { maxWait: 10_000, timeout: JOB_LOCK_TIMEOUT_MS }
  );
};
