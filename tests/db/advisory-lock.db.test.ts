// The job lock's SQL against real Postgres: the bigint key binds, the lock is taken, and it is
// released when the transaction ends (commit OR rollback), so a crashed or failed run can never
// leave a stuck lock. Contention between two sessions is in advisory-lock.concurrency.db.test.ts.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma } from "./helpers/db.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { JOB_LOCK_TIMEOUT_MS, jobLockKey, withAdvisoryLock } from "../../src/scheduler/lock.js";

const prisma = getTestPrisma();

/** Advisory locks currently held by any session on this database. */
const heldAdvisoryLocks = async () =>
  Number((await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'`)[0]?.n ?? -1);

beforeEach(async () => {
  expect(await heldAdvisoryLocks()).toBe(0); // nothing left over from an earlier test
});
afterAll(closeTestPrisma);

describe("withAdvisoryLock: the SQL", () => {
  it("takes the lock, runs the work, and returns its value", async () => {
    // (That exactly one advisory lock is HELD while the work runs is checked from a second
    // session in advisory-lock.concurrency.db.test.ts: observing it needs a second connection.)
    expect(await withAdvisoryLock("job-db-test", async () => "done")).toEqual({ acquired: true, value: "done" });
  });

  it("releases the lock when the run finishes", async () => {
    await withAdvisoryLock("job-db-test", async () => undefined);
    expect(await heldAdvisoryLocks()).toBe(0);
  });

  it("releases the lock when the work throws (the transaction rolls back), and the error propagates", async () => {
    await expect(
      withAdvisoryLock("job-db-test", async () => {
        throw new Error("job blew up");
      })
    ).rejects.toThrow("job blew up");
    expect(await heldAdvisoryLocks()).toBe(0);
    // ...and the very next run is not blocked by the failed one.
    expect(await withAdvisoryLock("job-db-test", async () => "next")).toEqual({ acquired: true, value: "next" });
  });

  it("can be taken again and again, back to back", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await withAdvisoryLock("job-db-test", async () => i)).toEqual({ acquired: true, value: i });
    }
    expect(await heldAdvisoryLocks()).toBe(0);
  });

  it("different jobs derive different lock keys (contention between them is tested with real sessions)", async () => {
    expect(jobLockKey("job-a")).not.toBe(jobLockKey("job-b"));
    expect(await withAdvisoryLock("job-a", async () => "a")).toEqual({ acquired: true, value: "a" });
    expect(await withAdvisoryLock("job-b", async () => "b")).toEqual({ acquired: true, value: "b" });
  });

  it("the work may run longer than the default 15 s transaction timeout (the lock transaction is given 30 minutes)", async () => {
    expect(JOB_LOCK_TIMEOUT_MS).toBe(30 * 60 * 1000);
    await expect(withAdvisoryLock("job-db-test", async () => new Promise((r) => setTimeout(() => r("late"), 300)))).resolves.toEqual({
      acquired: true,
      value: "late",
    });
  });

  it("the key is a valid signed 64-bit value Postgres accepts", async () => {
    const key = jobLockKey("daily-checks");
    const rows = await prisma.$queryRaw<Array<{ k: bigint }>>`SELECT ${key}::bigint AS k`;
    expect(rows[0]?.k).toBe(key);
  });
});
