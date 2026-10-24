// In-process scheduler for the daily job. Replaces an external cron service.
//
// Design:
//  - One setTimeout per day, re-armed after every firing (no setInterval drift), and
//    unref()'d so a pending timer never keeps the process alive during shutdown.
//  - Jobs must be idempotent. They are guarded twice against running concurrently:
//    an in-process flag (this process) and a Postgres advisory lock (other instances).
//  - On startup, if today's run time has already passed, the job runs once. That is
//    safe because it is idempotent and lock-guarded, and it is how a missed run (the
//    server was down at the scheduled time) is recovered WITHOUT a bookkeeping table.
//  - A failing run is logged at error level and never crashes the process or stops
//    later runs.
//  - ONE instance is assumed today. With several, the lock still prevents duplicate
//    work; set SCHEDULER_ENABLED=false on the extra ones if you do not want them trying.

import { ServiceError } from "../lib/errors.js";
import { safeError } from "../lib/redact.js";
import { withAdvisoryLock, type LockFn } from "./lock.js";
import { nextRunAfter, shouldCatchUp } from "./time.js";

export interface SchedulerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface JobResult {
  orgs: number;
  failedOrgs: number;
  counts: Record<string, number>;
}

export interface ScheduledJob {
  name: string;
  /** Must be idempotent: running it twice in a day creates no duplicate rows. */
  run(): Promise<JobResult>;
}

export type RunStatus = "ran" | "skipped_overlap" | "skipped_locked" | "failed";

export interface RunOutcome {
  status: RunStatus;
  durationMs: number;
  result?: JobResult;
  /** Redacted message when status is "failed". */
  error?: string;
}

export interface SchedulerOptions {
  jobs: ScheduledJob[];
  /** UTC hour (0-23) of the daily run. */
  utcHour: number;
  /** false: never arms timers or catches up (manual trigger still works). */
  enabled: boolean;
  logger: SchedulerLogger;
  lock?: LockFn;
  now?: () => Date;
  /** How long stop() waits for a running job. */
  shutdownTimeoutMs?: number;
}

export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly lock: LockFn;
  private readonly now: () => Date;
  private readonly shutdownTimeoutMs: number;

  private timer: NodeJS.Timeout | undefined;
  private nextAt: Date | null = null;
  private stopping = false;
  private started = false;
  private readonly running = new Set<string>();
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly options: SchedulerOptions) {
    for (const job of options.jobs) this.jobs.set(job.name, job);
    this.lock = options.lock ?? withAdvisoryLock;
    this.now = options.now ?? (() => new Date());
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 60_000;
  }

  /** When the next scheduled run will fire, or null if timers are not armed. */
  get nextRunAt(): Date | null {
    return this.nextAt;
  }

  has(jobName: string): boolean {
    return this.jobs.has(jobName);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { enabled, utcHour, logger } = this.options;

    if (!enabled) {
      logger.info({}, "scheduler disabled (SCHEDULER_ENABLED=false): no scheduled jobs on this instance");
      return;
    }
    if (this.jobs.size === 0) {
      logger.warn({}, "scheduler enabled but no jobs are registered");
      return;
    }

    // A missed run (server down at the scheduled time): run once now. Not awaited, so
    // startup is never blocked by a long job.
    if (shouldCatchUp(this.now(), utcHour)) {
      logger.info({ utcHour }, "today's scheduled time has passed: running jobs once on startup");
      for (const job of this.jobs.values()) void this.runGuarded(job);
    }
    this.arm(this.now());
  }

  /** Stops arming timers and waits (up to the timeout) for a running job to finish. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextAt = null;

    if (this.inflight.size === 0) return;
    this.options.logger.info({ running: [...this.running] }, "waiting for running job(s) to finish");

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), this.shutdownTimeoutMs);
      timeoutHandle.unref();
    });
    const finished = Promise.allSettled([...this.inflight]).then(() => "done" as const);
    const outcome = await Promise.race([finished, timedOut]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (outcome === "timeout") {
      this.options.logger.warn({ running: [...this.running] }, "job still running at shutdown timeout; exiting anyway");
    }
  }

  /** Run a job now (the admin endpoint). Same overlap and lock protection as a scheduled run. */
  async trigger(jobName: string): Promise<RunOutcome> {
    const job = this.jobs.get(jobName);
    if (!job) throw new ServiceError("NOT_FOUND", "That job is not available.");
    return this.runGuarded(job);
  }

  private arm(from: Date): void {
    if (this.stopping) return;
    const next = nextRunAfter(from, this.options.utcHour);
    this.nextAt = next;
    const delay = Math.max(0, next.getTime() - this.now().getTime());
    this.timer = setTimeout(() => this.onTimer(next), delay);
    this.timer.unref();
  }

  private onTimer(scheduledFor: Date): void {
    if (this.stopping) return;
    for (const job of this.jobs.values()) void this.runGuarded(job);
    // Re-arm from the instant we were scheduled for, not from "now": a timer that fires a
    // millisecond early must not compute the same boundary again and loop.
    this.arm(scheduledFor);
  }

  private runGuarded(job: ScheduledJob): Promise<RunOutcome> {
    const run = this.runGuardedInner(job);
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
    return run;
  }

  private async runGuardedInner(job: ScheduledJob): Promise<RunOutcome> {
    const { logger } = this.options;
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;

    if (this.stopping) {
      return { status: "failed", durationMs: 0, error: "The server is shutting down." };
    }
    // In-process overlap: the previous run has not finished.
    if (this.running.has(job.name)) {
      logger.info({ job: job.name }, "job skipped: a previous run is still in progress");
      return { status: "skipped_overlap", durationMs: 0 };
    }

    this.running.add(job.name);
    logger.info({ job: job.name }, "job starting");
    try {
      const locked = await this.lock(job.name, () => job.run());
      if (!locked.acquired) {
        // Another instance holds the lock and is doing the work. Not an error.
        logger.info({ job: job.name }, "job skipped: another instance holds the lock");
        return { status: "skipped_locked", durationMs: elapsed() };
      }

      const result = locked.value;
      const fields = { job: job.name, durationMs: elapsed(), ...result };
      if (result.failedOrgs > 0) logger.error(fields, "job finished with failures");
      else logger.info(fields, "job finished");
      return { status: "ran", durationMs: elapsed(), result };
    } catch (error) {
      const safe = safeError(error);
      logger.error({ job: job.name, durationMs: elapsed(), err: safe }, "job failed");
      return { status: "failed", durationMs: elapsed(), error: safe.message };
    } finally {
      this.running.delete(job.name);
    }
  }
}
