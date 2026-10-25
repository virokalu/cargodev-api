import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { jobLockKey, withAdvisoryLock, type LockFn } from "../src/scheduler/lock.js";
import { createDailyChecksJob } from "../src/scheduler/daily-checks-job.js";
import {
  Scheduler,
  type JobResult,
  type ScheduledJob,
  type SchedulerLogger,
} from "../src/scheduler/scheduler.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const OK: JobResult = { orgs: 1, failedOrgs: 0, counts: { reminders: 3 } };

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies SchedulerLogger;
}

/** One lock shared by every scheduler in a test = one database. */
function sharedLock() {
  const held = new Set<string>();
  const fn: LockFn = async (name, work) => {
    if (held.has(name)) return { acquired: false };
    held.add(name);
    try {
      return { acquired: true, value: await work() };
    } finally {
      held.delete(name);
    }
  };
  return { fn, held };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const job = (run: () => Promise<JobResult>, name = "daily-checks"): ScheduledJob => ({ name, run });
const make = (over: Partial<ConstructorParameters<typeof Scheduler>[0]> & { jobs: ScheduledJob[] }) => {
  const log = logger();
  const lock = sharedLock();
  const scheduler = new Scheduler({ utcHour: 2, enabled: true, logger: log, lock: lock.fn, ...over });
  return { scheduler, log, lock };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T01:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scheduling", () => {
  it("runs at the scheduled UTC time, then again every day", async () => {
    const run = vi.fn(async () => OK);
    const { scheduler } = make({ jobs: [job(run)] });
    scheduler.start();
    expect(scheduler.nextRunAt?.toISOString()).toBe("2026-03-10T02:00:00.000Z");

    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.nextRunAt?.toISOString()).toBe("2026-03-11T02:00:00.000Z");

    await vi.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(3);
    await scheduler.stop();
  });

  it("honours a different configured hour", async () => {
    const run = vi.fn(async () => OK);
    const { scheduler } = make({ jobs: [job(run)], utcHour: 5 });
    scheduler.start();
    expect(scheduler.nextRunAt?.toISOString()).toBe("2026-03-10T05:00:00.000Z");
    await scheduler.stop();
  });

  it("re-arms with setTimeout (never setInterval), so a long run cannot drift the schedule", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { scheduler } = make({ jobs: [job(async () => OK)] });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("its timers are unref()'d so they never keep the process alive", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const { scheduler } = make({ jobs: [job(async () => OK)] });
    scheduler.start();
    const handles = spy.mock.results.map((r) => r.value as { hasRef?: () => boolean });
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) expect(handle.hasRef?.()).toBe(false);
    await scheduler.stop();
  });

  it("a timer that fires while the clock still reads a few ms early cannot loop on the same boundary", async () => {
    const run = vi.fn(async () => OK);
    // Correct when the timer is armed, then 5 ms behind when it fires (a clock adjustment).
    let skewMs = 0;
    const { scheduler } = make({ jobs: [job(run)], now: () => new Date(Date.now() - skewMs) });
    scheduler.start();
    skewMs = 5;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.nextRunAt?.toISOString()).toBe("2026-03-11T02:00:00.000Z");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });
});

describe("missed runs are recovered on startup", () => {
  it("runs once immediately when today's time has already passed", async () => {
    vi.setSystemTime(new Date("2026-03-10T09:00:00Z"));
    const run = vi.fn(async () => OK);
    const { scheduler } = make({ jobs: [job(run)] });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.nextRunAt?.toISOString()).toBe("2026-03-11T02:00:00.000Z");
    await scheduler.stop();
  });

  it("does not run on startup before today's time", async () => {
    const run = vi.fn(async () => OK);
    const { scheduler } = make({ jobs: [job(run)] });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("startup is not blocked by a slow catch-up run", async () => {
    vi.setSystemTime(new Date("2026-03-10T09:00:00Z"));
    const slow = deferred<JobResult>();
    const { scheduler } = make({ jobs: [job(() => slow.promise)] });
    expect(() => scheduler.start()).not.toThrow(); // returns while the job is still running
    slow.resolve(OK);
    await scheduler.stop();
  });
});

describe("enabled / disabled", () => {
  it("SCHEDULER_ENABLED=false arms no timers and does no catch-up", async () => {
    vi.setSystemTime(new Date("2026-03-10T09:00:00Z"));
    const run = vi.fn(async () => OK);
    const { scheduler, log } = make({ jobs: [job(run)], enabled: false });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler.nextRunAt).toBeNull();
    expect(log.info).toHaveBeenCalledWith({}, expect.stringContaining("disabled"));
  });

  it("a disabled scheduler can still be triggered by hand", async () => {
    const run = vi.fn(async () => OK);
    const { scheduler } = make({ jobs: [job(run)], enabled: false });
    scheduler.start();
    expect((await scheduler.trigger("daily-checks")).status).toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("with no jobs registered it idles and says so", async () => {
    const { scheduler, log } = make({ jobs: [] });
    scheduler.start();
    expect(vi.getTimerCount()).toBe(0);
    expect(log.warn).toHaveBeenCalledWith({}, expect.stringContaining("no jobs"));
  });

  it("start() twice arms only one timer", async () => {
    const run = vi.fn(async () => OK);
    const { scheduler } = make({ jobs: [job(run)] });
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(run).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });
});

describe("single-run guarantees", () => {
  it("when the lock is held elsewhere the run is skipped silently (info, not error)", async () => {
    const run = vi.fn(async () => OK);
    const { scheduler, log, lock } = make({ jobs: [job(run)] });
    lock.held.add("daily-checks"); // another instance is running it
    const outcome = await scheduler.trigger("daily-checks");
    expect(outcome.status).toBe("skipped_locked");
    expect(run).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ job: "daily-checks" }, expect.stringContaining("another instance"));
  });

  it("skips an overlapping run in the same process", async () => {
    const gate = deferred<JobResult>();
    const run = vi.fn(() => gate.promise);
    const { scheduler } = make({ jobs: [job(run)] });

    const first = scheduler.trigger("daily-checks");
    await vi.advanceTimersByTimeAsync(0);
    const second = await scheduler.trigger("daily-checks");
    expect(second.status).toBe("skipped_overlap");
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve(OK);
    expect((await first).status).toBe("ran");
    // Once the first has finished, a new run is allowed again.
    expect((await scheduler.trigger("daily-checks")).status).toBe("ran");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a scheduled tick that lands while a run is still going is skipped", async () => {
    const gate = deferred<JobResult>();
    const run = vi.fn(() => gate.promise);
    const { scheduler } = make({ jobs: [job(run)] });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(HOUR); // day 1 tick starts the (never-finishing) run
    await vi.advanceTimersByTimeAsync(DAY); // day 2 tick arrives mid-run
    expect(run).toHaveBeenCalledTimes(1);
    gate.resolve(OK);
    await scheduler.stop();
  });

  it("two instances sharing one database run the job once at a time", async () => {
    const gate = deferred<JobResult>();
    const run = vi.fn(() => gate.promise);
    const lock = sharedLock();
    const a = new Scheduler({ jobs: [job(run)], utcHour: 2, enabled: true, logger: logger(), lock: lock.fn });
    const b = new Scheduler({ jobs: [job(run)], utcHour: 2, enabled: true, logger: logger(), lock: lock.fn });

    const first = a.trigger("daily-checks");
    await vi.advanceTimersByTimeAsync(0);
    const second = await b.trigger("daily-checks");
    expect(second.status).toBe("skipped_locked");
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve(OK);
    await first;
    expect(lock.held.size).toBe(0); // released afterwards
  });

  it("an unknown job name is NOT_FOUND", async () => {
    const { scheduler } = make({ jobs: [job(async () => OK)] });
    await expect(scheduler.trigger("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("failures never take the scheduler down", () => {
  it("a failing run is logged at error level (redacted) and the next day still runs", async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("db exploded for ExponentPushToken[abc123def456]");
      return OK;
    });
    const { scheduler, log } = make({ jobs: [job(run)] });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("abc123def456");
    expect(log.error.mock.calls[0]?.[1]).toBe("job failed");

    await vi.advanceTimersByTimeAsync(DAY);
    expect(run).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ job: "daily-checks", orgs: 1 }), "job finished");
    await scheduler.stop();
  });

  it("returns a failed outcome (no throw) so the admin endpoint can report it", async () => {
    const { scheduler } = make({ jobs: [job(async () => Promise.reject(new Error("nope")))] });
    const outcome = await scheduler.trigger("daily-checks");
    expect(outcome).toMatchObject({ status: "failed", error: "nope" });
  });

  it("a lock error (database down) is a failed run, not a crash", async () => {
    const lock: LockFn = async () => {
      throw new Error("connection refused");
    };
    const { scheduler, log } = make({ jobs: [job(async () => OK)], lock });
    expect((await scheduler.trigger("daily-checks")).status).toBe("failed");
    expect(log.error).toHaveBeenCalled();
  });

  it("an overall run that finished with failed orgs is logged at error level", async () => {
    const { scheduler, log } = make({ jobs: [job(async () => ({ orgs: 2, failedOrgs: 1, counts: {} }))] });
    await scheduler.trigger("daily-checks");
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ failedOrgs: 1 }), "job finished with failures");
  });

  it("logs start, finish, duration and counts", async () => {
    const run = async () => {
      await new Promise((r) => setTimeout(r, 250));
      return { orgs: 2, failedOrgs: 0, counts: { shipped: 4, reminders: 9 } };
    };
    const { scheduler, log } = make({ jobs: [job(run)] });
    const pending = scheduler.trigger("daily-checks");
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(log.info).toHaveBeenCalledWith({ job: "daily-checks" }, "job starting");
    expect(log.info).toHaveBeenCalledWith(
      { job: "daily-checks", durationMs: 250, orgs: 2, failedOrgs: 0, counts: { shipped: 4, reminders: 9 } },
      "job finished"
    );
  });
});

describe("graceful shutdown", () => {
  it("stop() clears the timer, so nothing is armed and nothing runs afterwards", async () => {
    const run = vi.fn(async () => OK);
    const { scheduler } = make({ jobs: [job(run)] });
    scheduler.start();
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(run).not.toHaveBeenCalled();
  });

  it("stop() waits for a running job to finish", async () => {
    const gate = deferred<JobResult>();
    const { scheduler } = make({ jobs: [job(() => gate.promise)] });
    const pending = scheduler.trigger("daily-checks");
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(false); // still waiting on the job

    gate.resolve(OK);
    await stopping;
    expect(stopped).toBe(true);
    expect((await pending).status).toBe("ran");
  });

  it("stop() gives up after the timeout if the job hangs, and says so", async () => {
    const { scheduler, log } = make({ jobs: [job(() => new Promise<JobResult>(() => undefined))], shutdownTimeoutMs: 5000 });
    void scheduler.trigger("daily-checks");
    await vi.advanceTimersByTimeAsync(0);
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("shutdown timeout"));
  });

  it("refuses new runs once stopping", async () => {
    const run = vi.fn(async () => OK);
    const { scheduler } = make({ jobs: [job(run)] });
    await scheduler.stop();
    const outcome = await scheduler.trigger("daily-checks");
    expect(outcome.status).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the daily job wrapper", () => {
  // The wrapper yields with setImmediate, which fake timers would freeze.
  beforeEach(() => {
    vi.useRealTimers();
  });

  const orgOutcome = (counts: Record<string, number>) => async () => counts;

  it("runs every org in the database, not just the default ORG_ID", async () => {
    const seen: string[] = [];
    const wrapped = createDailyChecksJob({
      listOrgIds: async () => [ORG_A, ORG_B, "org_test_c"],
      runForOrg: async (orgId) => {
        seen.push(orgId);
        return { reminders: 1 };
      },
    });
    const result = await wrapped.run();
    expect(seen).toEqual([ORG_A, ORG_B, "org_test_c"]);
    expect(result).toEqual({ orgs: 3, failedOrgs: 0, counts: { reminders: 3 } });
  });

  it("reads the org list from the database by default", async () => {
    state.fake = createFakePrisma();
    (state.fake as FakePrisma).seed("organization", { id: ORG_A, name: "A" }, { id: ORG_B, name: "B" });
    const seen: string[] = [];
    const wrapped = createDailyChecksJob({ runForOrg: async (id) => (seen.push(id), {}) });
    await wrapped.run();
    expect(seen.sort()).toEqual([ORG_A, ORG_B]);
  });

  it("one org failing does not stop the others, and is counted and reported", async () => {
    const reported: string[] = [];
    const wrapped = createDailyChecksJob({
      listOrgIds: async () => [ORG_A, ORG_B, "org_test_c"],
      runForOrg: async (orgId) => {
        if (orgId === ORG_B) throw new Error("boom");
        return { shipped: 2 };
      },
      onOrgError: (orgId) => reported.push(orgId),
    });
    expect(await wrapped.run()).toEqual({ orgs: 3, failedOrgs: 1, counts: { shipped: 4 } });
    expect(reported).toEqual([ORG_B]);
  });

  it("sums counts across orgs and handles an empty database", async () => {
    const wrapped = createDailyChecksJob({
      listOrgIds: async () => [ORG_A, ORG_B],
      runForOrg: orgOutcome({ shipped: 1, reminders: 2 }),
    });
    expect((await wrapped.run()).counts).toEqual({ shipped: 2, reminders: 4 });
    const none = createDailyChecksJob({ listOrgIds: async () => [], runForOrg: orgOutcome({}) });
    expect(await none.run()).toEqual({ orgs: 0, failedOrgs: 0, counts: {} });
  });

  it("yields to the event loop between orgs", async () => {
    const order: string[] = [];
    const wrapped = createDailyChecksJob({
      listOrgIds: async () => [ORG_A, ORG_B],
      runForOrg: async (orgId) => {
        order.push(`run ${orgId}`);
        return {};
      },
    });
    const running = wrapped.run();
    setImmediate(() => order.push("other work"));
    await running;
    expect(order).toEqual([`run ${ORG_A}`, "other work", `run ${ORG_B}`]);
  });

  // Idempotency of the real body is proved against Postgres in tests/db/daily-checks.db.test.ts.

  it("an org whose checks reported errors counts as failed, but its successful counts are kept", async () => {
    const reported: string[] = [];
    const wrapped = createDailyChecksJob({
      listOrgIds: async () => [ORG_A, ORG_B],
      runForOrg: async (orgId) =>
        orgId === ORG_A
          ? { counts: { shipped: 1, reminders: 2 }, errors: ["lcReminders: boom"] }
          : { counts: { shipped: 1, reminders: 1 }, errors: [] },
      onOrgError: (orgId, error) => reported.push(`${orgId}: ${(error as Error).message}`),
    });
    expect(await wrapped.run()).toEqual({ orgs: 2, failedOrgs: 1, counts: { shipped: 2, reminders: 3 } });
    expect(reported).toEqual([`${ORG_A}: lcReminders: boom`]);
  });

  it("running the wrapper twice calls the body once per org per run (the body must be idempotent)", async () => {
    const calls: string[] = [];
    const wrapped = createDailyChecksJob({
      listOrgIds: async () => [ORG_A],
      runForOrg: async (orgId) => (calls.push(orgId), {}),
    });
    await wrapped.run();
    await wrapped.run();
    expect(calls).toEqual([ORG_A, ORG_A]);
  });
});

describe("advisory lock", () => {
  function lockFake(locked: boolean) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const transactionOptions: unknown[] = [];
    const client = {
      async $transaction(fn: (tx: unknown) => Promise<unknown>, options: unknown) {
        transactionOptions.push(options);
        const tx = {
          $queryRaw: async (strings: TemplateStringsArray, ...params: unknown[]) => {
            calls.push({ sql: strings.join("?"), params });
            return [{ locked }];
          },
        };
        return fn(tx);
      },
    };
    state.fake = { client } as unknown as FakePrisma;
    return { calls, transactionOptions };
  }

  it("runs the work inside one transaction when the lock is acquired", async () => {
    const { calls, transactionOptions } = lockFake(true);
    const work = vi.fn(async () => "done");
    const result = await withAdvisoryLock("daily-checks", work);
    expect(result).toEqual({ acquired: true, value: "done" });
    expect(work).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("pg_try_advisory_xact_lock");
    expect(calls[0]?.sql).not.toContain("pg_try_advisory_lock("); // never the session-level lock
    expect(transactionOptions[0]).toMatchObject({ timeout: expect.any(Number) });
    expect((transactionOptions[0] as { timeout: number }).timeout).toBeGreaterThan(15_000);
  });

  it("does not run the work when the lock is not acquired", async () => {
    lockFake(false);
    const work = vi.fn(async () => "done");
    expect(await withAdvisoryLock("daily-checks", work)).toEqual({ acquired: false });
    expect(work).not.toHaveBeenCalled();
  });

  it("propagates a failure from the work (so the transaction rolls back and the lock is released)", async () => {
    lockFake(true);
    await expect(withAdvisoryLock("daily-checks", async () => Promise.reject(new Error("work failed")))).rejects.toThrow("work failed");
  });

  it("derives a stable, distinct, 64-bit key per job name", () => {
    expect(jobLockKey("daily-checks")).toBe(jobLockKey("daily-checks"));
    expect(jobLockKey("daily-checks")).not.toBe(jobLockKey("other-job"));
    const key = jobLockKey("daily-checks");
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
  });
});
