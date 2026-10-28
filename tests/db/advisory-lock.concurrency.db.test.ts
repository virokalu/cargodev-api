// Lock contention between separate database sessions: the part a fake cannot prove.
//
// Needs REAL concurrent connections (a Postgres container locally, a service container in CI).
// A single-session engine would let every "second session" re-enter the first one's lock and
// pass for the wrong reason, so these must not be run against one. Pool size must be >= 2.

import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma } from "./helpers/db.js";
import { assertSafeTestDatabaseUrl } from "./guard.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { jobLockKey, withAdvisoryLock } from "../../src/scheduler/lock.js";
import { Scheduler, type JobResult, type ScheduledJob } from "../../src/scheduler/scheduler.js";

const prisma = getTestPrisma();
const OK: JobResult = { orgs: 1, failedOrgs: 0, counts: {} };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Holds the lock inside withAdvisoryLock until released. Resolves once the lock is actually held. */
async function holdLock(name: string) {
  const held = deferred();
  const release = deferred();
  const run = withAdvisoryLock(name, async () => {
    held.resolve();
    await release.promise;
    return "released";
  });
  await held.promise;
  return { release: release.resolve, done: run };
}

beforeEach(() => {
  expect(Number(process.env["TEST_DATABASE_POOL_MAX"] ?? 10)).toBeGreaterThanOrEqual(2);
});
afterAll(closeTestPrisma);

describe("only one session holds a job's lock at a time", () => {
  it("a second attempt is refused while the first is running, and succeeds after it finishes", async () => {
    const first = await holdLock("contended-job");

    expect(await withAdvisoryLock("contended-job", async () => "second")).toEqual({ acquired: false });

    first.release();
    expect(await first.done).toEqual({ acquired: true, value: "released" });
    expect(await withAdvisoryLock("contended-job", async () => "third")).toEqual({ acquired: true, value: "third" });
  });

  it("the refused attempt never runs its work", async () => {
    const first = await holdLock("contended-job");
    const work = vi.fn(async () => "should not run");
    expect(await withAdvisoryLock("contended-job", work)).toEqual({ acquired: false });
    expect(work).not.toHaveBeenCalled();
    first.release();
    await first.done;
  });

  it("many simultaneous attempts: exactly one runs", async () => {
    const gate = deferred();
    setTimeout(() => gate.resolve(), 400); // the winner finishes after every other attempt was refused
    let running = 0;
    let maxRunning = 0;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        withAdvisoryLock("contended-job", async () => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await gate.promise;
          running -= 1;
          return "ran";
        })
      )
    );
    expect(attempts.filter((a) => a.acquired)).toHaveLength(1);
    expect(attempts.filter((a) => !a.acquired)).toHaveLength(7);
    expect(maxRunning).toBe(1);
  });

  it("different jobs do not block each other", async () => {
    const first = await holdLock("job-one");
    expect(await withAdvisoryLock("job-two", async () => "ok")).toEqual({ acquired: true, value: "ok" });
    first.release();
    await first.done;
  });

  it("a failed run releases the lock for the next one", async () => {
    await expect(
      withAdvisoryLock("contended-job", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await withAdvisoryLock("contended-job", async () => "recovered")).toEqual({ acquired: true, value: "recovered" });
  });
});

describe("the lock is visible to other database sessions, not just this process", () => {
  it("exactly one advisory lock is held, as seen from another session, while the work runs", async () => {
    const count = async () =>
      Number((await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'`)[0]?.n ?? -1);
    expect(await count()).toBe(0);
    const first = await holdLock("observed-job");
    expect(await count()).toBe(1);
    first.release();
    await first.done;
    expect(await count()).toBe(0);
  });

  it("a lock held by an unrelated session (another instance) blocks us", async () => {
    const db = assertSafeTestDatabaseUrl(process.env["TEST_DATABASE_URL"]);
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    try {
      const key = jobLockKey("held-elsewhere");
      await other.query("SELECT pg_advisory_lock($1::bigint)", [key.toString()]);

      expect(await withAdvisoryLock("held-elsewhere", async () => "ours")).toEqual({ acquired: false });

      await other.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
      expect(await withAdvisoryLock("held-elsewhere", async () => "ours")).toEqual({ acquired: true, value: "ours" });
    } finally {
      await other.end();
    }
  });

  it("a lock disappears with the session that held it (a crashed instance leaves nothing stuck)", async () => {
    const db = assertSafeTestDatabaseUrl(process.env["TEST_DATABASE_URL"]);
    const dying = new pg.Client({ connectionString: db.url });
    await dying.connect();
    await dying.query("SELECT pg_advisory_lock($1::bigint)", [jobLockKey("crashed-instance").toString()]);
    expect(await withAdvisoryLock("crashed-instance", async () => "x")).toEqual({ acquired: false });

    await dying.end(); // the process died
    await vi.waitFor(async () => {
      expect(await withAdvisoryLock("crashed-instance", async () => "x")).toEqual({ acquired: true, value: "x" });
    });
  });
});

describe("two scheduler instances sharing one database", () => {
  const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  it("only one runs the job at a time; the other reports skipped_locked", async () => {
    const started = deferred();
    const finish = deferred();
    let runs = 0;
    const job: ScheduledJob = {
      name: "shared-job",
      async run() {
        runs += 1;
        started.resolve();
        await finish.promise;
        return OK;
      },
    };
    // Two schedulers = two app instances. Each has its own in-process overlap flag, so only
    // the database lock can stop the second one.
    const a = new Scheduler({ jobs: [job], utcHour: 2, enabled: false, logger: silent });
    const b = new Scheduler({ jobs: [job], utcHour: 2, enabled: false, logger: silent });

    const first = a.trigger("shared-job");
    await started.promise;
    const second = await b.trigger("shared-job");

    expect(second.status).toBe("skipped_locked");
    expect(runs).toBe(1);

    finish.resolve();
    expect((await first).status).toBe("ran");

    // Once the first has finished, the other instance can run it (sequential reruns rely on the
    // job itself being idempotent, which the lock does not guarantee).
    expect((await b.trigger("shared-job")).status).toBe("ran");
    expect(runs).toBe(2);
  });
});
