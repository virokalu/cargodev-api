import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import { getPrisma } from "../lib/prisma.js";
import { success } from "../lib/response.js";
import * as activityLog from "../services/activity-log.service.js";
import { DAILY_CHECKS_JOB } from "../scheduler/daily-checks-job.js";
import type { Scheduler } from "../scheduler/scheduler.js";

const ADMIN_ONLY = ["ADMINISTRATOR"] as const;

export interface AdminJobRouteDeps {
  scheduler: Scheduler;
}

export function registerAdminJobRoutes(app: FastifyInstance, deps: AdminJobRouteDeps) {
  // Manual trigger for the daily job. Replaces a shared-secret cron endpoint: it uses the
  // normal Bearer auth, so every run is attributable to a person. It takes the same
  // overlap guard and database lock as the scheduled run, and the job is idempotent, so
  // triggering it twice (or while the scheduler runs it) creates no duplicates.
  app.post("/admin/jobs/daily-checks", { preHandler: authenticate(ADMIN_ONLY) }, async (request) => {
    const user = currentUser(request);

    // NOT_FOUND if the job is not registered on this build.
    const outcome = await deps.scheduler.trigger(DAILY_CHECKS_JOB);

    // Record who triggered it and what happened, even when the run was skipped.
    await getPrisma().$transaction(async (tx) => {
      await activityLog.record(tx, {
        orgId: user.orgId,
        actorId: user.id,
        action: "TRIGGER_JOB",
        entity: "Job",
        entityId: DAILY_CHECKS_JOB,
        after: {
          status: outcome.status,
          durationMs: outcome.durationMs,
          ...(outcome.result ? { orgs: outcome.result.orgs, failedOrgs: outcome.result.failedOrgs, counts: outcome.result.counts } : {}),
        },
      });
    });

    // The failure detail stays in the server log: internal error text is never returned.
    const { error: _error, ...publicOutcome } = outcome;
    return success(publicOutcome);
  });
}
