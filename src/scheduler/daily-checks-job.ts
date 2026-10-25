// The daily job's wrapper: runs the per-org checks for EVERY org in the database
// (it deliberately does not use the single-org ORG_ID default), isolates failures per
// org, and yields to the event loop between orgs so a big run never starves requests.
//
// The per-org body (`runForOrg`) is the ported runDailyVehicleChecks: the shipped
// transition first, then payment / rikso / LC / ETD / missing-document reminders,
// de-duplicated per vehicle and event per day. IT OWNS IDEMPOTENCY: running twice in a
// day must create no duplicate StatusHistory or Notification rows.
//
// Wired in ./index.ts to reminder.service's runDailyVehicleChecks.

import { getPrisma } from "../lib/prisma.js";
import type { JobResult, ScheduledJob } from "./scheduler.js";

export const DAILY_CHECKS_JOB = "daily-checks";

/** Plain counts, or counts plus the errors of individual checks that failed (those orgs count as failed). */
export type OrgRunResult = Record<string, number> | { counts: Record<string, number>; errors: string[] };

function isDetailed(result: OrgRunResult): result is { counts: Record<string, number>; errors: string[] } {
  return typeof (result as { counts?: unknown }).counts === "object";
}

export interface DailyChecksDeps {
  /** Runs the checks for one org and returns counts such as { shipped: 3, reminders: 7 }. */
  runForOrg(orgId: string): Promise<OrgRunResult>;
  /** Defaults to every organization in the database. */
  listOrgIds?: () => Promise<string[]>;
  onOrgError?: (orgId: string, error: unknown) => void;
}

async function listAllOrgIds(): Promise<string[]> {
  const orgs = await getPrisma().organization.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  return orgs.map((org) => org.id);
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createDailyChecksJob(deps: DailyChecksDeps): ScheduledJob {
  return {
    name: DAILY_CHECKS_JOB,
    async run(): Promise<JobResult> {
      const orgIds = await (deps.listOrgIds ?? listAllOrgIds)();
      const counts: Record<string, number> = {};
      let failedOrgs = 0;

      for (const orgId of orgIds) {
        try {
          const result = await deps.runForOrg(orgId);
          const orgCounts = isDetailed(result) ? result.counts : result;
          for (const [key, value] of Object.entries(orgCounts)) counts[key] = (counts[key] ?? 0) + value;
          // Some checks failed even though the org ran: report it, but keep what did succeed.
          if (isDetailed(result) && result.errors.length > 0) {
            failedOrgs += 1;
            deps.onOrgError?.(orgId, new Error(result.errors.join("; ")));
          }
        } catch (error) {
          // One org failing must not stop the others.
          failedOrgs += 1;
          deps.onOrgError?.(orgId, error);
        }
        await yieldToEventLoop();
      }

      return { orgs: orgIds.length, failedOrgs, counts };
    },
  };
}
