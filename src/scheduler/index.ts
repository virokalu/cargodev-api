// Jobs registered with the scheduler.
//
// EMPTY ON PURPOSE for now. Register the daily job here once reminder.service (and
// vehicle.service's runDailyShipmentStatusTransitions) are ported:
//
//   createDailyChecksJob({ runForOrg: runDailyVehicleChecks })
//
// Registering a stub that "succeeds" without doing the work would silently drop
// reminders, so until then no job exists and the admin trigger answers 404.

import type { ScheduledJob } from "./scheduler.js";

export function defaultJobs(): ScheduledJob[] {
  return [];
}

export { DAILY_CHECKS_JOB, createDailyChecksJob } from "./daily-checks-job.js";
export { Scheduler } from "./scheduler.js";
export type { JobResult, RunOutcome, ScheduledJob } from "./scheduler.js";
