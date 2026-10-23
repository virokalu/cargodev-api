# Runbook

Procedures only. Live hostnames, dashboard links and contacts are kept privately, not in this public repo.

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

## Cron did not run

The daily job runs at 02:00 UTC through the protected cron route. Check the scheduler's run log, then call the route manually with the `CRON_SECRET` bearer token. Jobs are de-duplicated per vehicle and event per day, so a re-run is safe.

## Database

- Never run migrations from this repo.
- Restore drills and backup procedures are owned by the CargoDev project.
