// Jobs registered with the scheduler.
//
// One job today: the daily vehicle checks (shipped transition, then payment / rikso / LC / ETD /
// missing-document reminders) and then the retention clean-up (services/retention.service.ts) for every org. It is idempotent: running it twice in a day creates no
// duplicate StatusHistory or Notification rows (proved against real Postgres in tests/db).

import { safeError } from "../lib/redact.js";
import { runDailyVehicleChecks } from "../services/reminder.service.js";
import { runRetention } from "../services/retention.service.js";
import { createDailyChecksJob } from "./daily-checks-job.js";
import type { ScheduledJob } from "./scheduler.js";

const RETENTION_KEYS = ["otpCodes", "customerSessions", "refreshTokens", "readAlerts", "unverifiedAccounts"] as const;

export function defaultJobs(): ScheduledJob[] {
  // Retention counts for the current run, summed over every org. Reset when the run starts, logged once when it ends.
  const totals: Record<string, number> = {};
  let dryRun = true;
  const checks = [
    createDailyChecksJob({
      runForOrg: async (orgId) => {
        const { errors, ...counts } = await runDailyVehicleChecks(orgId);
        // Retention runs in the same job, under the same advisory lock. A failure here is reported, never fatal to the checks above.
        let retention: Record<string, number> = {};
        try {
          const { skipped, dryRun: wasDryRun, ...removed } = await runRetention(orgId);
          dryRun = wasDryRun;
          retention = { ...removed, retentionSkippedOrgs: skipped };
          for (const [key, value] of Object.entries(retention)) totals[key] = (totals[key] ?? 0) + value;
        } catch (error) {
          errors.push(`retention: ${String(error)}`);
        }
        return { counts: { ...counts, ...retention }, errors };
      },
      onOrgError: (orgId, error) => console.error(`daily checks reported errors for org ${orgId}`, safeError(error)),
    }),
  ];
  return checks.map((job) => ({
    ...job,
    async run() {
      for (const key of Object.keys(totals)) delete totals[key];
      const result = await job.run();
      // ONE masked line per run: counts only (no org id, no id, no name, no email).
      const counts = RETENTION_KEYS.map((key) => `${key}=${totals[key] ?? 0}`).join(" ");
      console.info(`retention ${dryRun ? "DRY RUN, nothing removed, would remove" : "removed"}: ${counts} skippedOrgs=${totals["retentionSkippedOrgs"] ?? 0}`);
      return result;
    },
  }));
}

export { DAILY_CHECKS_JOB, createDailyChecksJob } from "./daily-checks-job.js";
export { Scheduler } from "./scheduler.js";
export type { JobResult, RunOutcome, ScheduledJob } from "./scheduler.js";
