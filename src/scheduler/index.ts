// Jobs registered with the scheduler.
//
// One job today: the daily vehicle checks (shipped transition, then payment / rikso / LC / ETD /
// missing-document reminders) for every org. It is idempotent: running it twice in a day creates no
// duplicate StatusHistory or Notification rows (proved against real Postgres in tests/db).

import { safeError } from "../lib/redact.js";
import { runDailyVehicleChecks } from "../services/reminder.service.js";
import { createDailyChecksJob } from "./daily-checks-job.js";
import type { ScheduledJob } from "./scheduler.js";

export function defaultJobs(): ScheduledJob[] {
  return [
    createDailyChecksJob({
      runForOrg: async (orgId) => {
        const { errors, ...counts } = await runDailyVehicleChecks(orgId);
        return { counts, errors };
      },
      onOrgError: (orgId, error) => console.error(`daily checks reported errors for org ${orgId}`, safeError(error)),
    }),
  ];
}

export { DAILY_CHECKS_JOB, createDailyChecksJob } from "./daily-checks-job.js";
export { Scheduler } from "./scheduler.js";
export type { JobResult, RunOutcome, ScheduledJob } from "./scheduler.js";
