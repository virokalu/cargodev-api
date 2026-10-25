# Runbook

Procedures only. Live hostnames, dashboard links and contacts are kept privately, not in this public repo.

## Before go-live: set the proxy hop count

Rate limiting and the audit trail use the client IP. By default the server trusts no proxy (`TRUST_PROXY_HOPS=0`), so behind a load balancer every request would look like it comes from the balancer and share one rate-limit bucket. Once the hosting setup is chosen, set `TRUST_PROXY_HOPS` to the number of proxies we control in front of the server (usually 1), and check it: send a request with a made-up `X-Forwarded-For` header and confirm the logged IP is the real client, not the made-up value. A value higher than the real hop count lets clients spoof their IP; never use "trust all". This is only safe when the server cannot be reached except through those proxies (firewall the origin), because a direct client could otherwise send its own header.

## Deploy

1. Merge to `main` through a PR with passing CI.
2. Deploy from the host's pipeline (details kept privately).
3. Check `GET /health` returns `{ "data": { "status": "ok" } }`.

## Roll back

1. Redeploy the previous known-good version from the host.
2. If the problem was a bad merge, revert it with a PR (`git revert`), never a force-push.

## A secret leaked

1. Rotate the credential immediately at its provider.
2. Update the value in the host's secret settings and redeploy.
3. Check logs for misuse during the exposure window.
4. If it was committed, treat it as compromised permanently; history rewriting does not make it safe.

## A user is locked out

Lockout is 5 failed logins for 15 minutes (`lockoutUntil`). It clears itself. Do not disable the mechanism.

## The daily job did not run

The daily job runs inside this server (default 02:00 UTC, `DAILY_JOB_UTC_HOUR`). There is no external cron service and no shared secret.

1. Look in the logs for the run: `job starting`, then `job finished` (with duration and counts) or `job failed` / `job finished with failures` (error level). Also look for `job skipped`: another instance held the lock, or a previous run was still going.
2. If the server was down at the scheduled time, restart it: when today's run time has already passed, the job runs once on startup.
3. To run it now, sign in as an **ADMINISTRATOR** and call `POST /api/v1/admin/jobs/daily-checks` with your normal bearer token. The response says `ran`, `skipped_overlap`, `skipped_locked` or `failed`, and the call is recorded in the activity log with who triggered it.
4. Re-running is safe: the job de-duplicates per vehicle and event per day, and the call takes the same lock as the scheduled run.

Notes:
- Run the server with `TZ=UTC`. The checks compare dates at local midnight, so a different server timezone moves "today" and shifts the ETD and reminder day counts.
- Only one process needs `SCHEDULER_ENABLED=true`. If several have it, the database lock still lets only one run at a time. Deploys briefly overlap, so two instances may both try; the second skips, or, if the first has already finished, does harmless idempotent work.
- `SCHEDULER_ENABLED=false` stops an instance running scheduled jobs; the manual endpoint still works on it.
- While the Next.js app still runs the same jobs, do not enable this scheduler (duplicate reminders). Turn the old one off first.

## Database

- Never run migrations from this repo. The only database-changing commands here run against the throwaway test container, through `npm run test:db` (see `docs/testing.md`).
- Restore drills and backup procedures are owned by the CargoDev project.
