# Runbook

Procedures only. Live hostnames, dashboard links and contacts are kept privately, not in this public repo.

## Before go-live: set the proxy hop count

Rate limiting and the audit trail use the client IP. By default the server trusts no proxy (`TRUST_PROXY_HOPS=0`), so behind a load balancer every request would look like it comes from the balancer and share one rate-limit bucket. Once the hosting setup is chosen, set `TRUST_PROXY_HOPS` to the number of proxies we control in front of the server (usually 1), and check it: send a request with a made-up `X-Forwarded-For` header and confirm the logged IP is the real client, not the made-up value. A value higher than the real hop count lets clients spoof their IP; never use "trust all". This is only safe when the server cannot be reached except through those proxies (firewall the origin), because a direct client could otherwise send its own header.

## Deploy

1. Merge to `main` through a PR with passing CI.
2. Deploy from the host's pipeline (details kept privately).
3. Check `GET /health` returns `{ "data": { "status": "ok" } }`.

## Run a migration

Migrations are additive-first (ADR 0004) and run only through `npm run migrate -- <command>`. The tool does not know which environment a database is, so you do:

1. Run `npm run migrate -- status` (read-only). It prints the target host, port and database name, what `_prisma_migrations` holds, the pending migrations and the scan result.
2. **Compare the printed project ref** with the test project's ref (kept in the private notes, not in this repo). The host alone is not enough: pooler hosts are shared by every project in a region. For a pooler URL the ref is the part of the user name after `postgres.`; for a direct URL it is the middle of `db.<ref>.supabase.co`. It is printed to the terminal only. If it is not the project you intend, stop.
3. Before any `deploy` against a database that holds real data, **take a backup or snapshot and confirm it with a teammate**.
4. Read the printed SQL. A flagged migration (DROP, RENAME, type change, NOT NULL without default, a new table missing org_id/index/RLS) stays blocked until a maintainer adds its name to `prisma/migrations/scan-approved.txt`.
5. Run `deploy` only with the maintainer's approval for that run. Coding agents never run `deploy` on their own.
6. If the tables exist but `_prisma_migrations` is empty or missing, `deploy` stops. The maintainer baselines the history by hand; this tool never runs `migrate resolve`.

## Customer API

- **Forcing an app update:** set `APP_MIN_VERSION` (for example `2.0.0`) and restart. The app checks `GET /api/customer/v1/app/min-version` at start and shows an update screen to older builds. It takes no token, so it also reaches users who are signed out.
- **Releasing a vehicle to its customer:** vehicles, photos and documents are all private by default. Review with `npm run photos:release-report`, then release in the app (slice 4). A vehicle is shown to its customer only when it is theirs, an export vehicle, released, and not cancelled.

- It is mounted only when `CUSTOMER_JWT_SECRET` is set. To switch it off, unset it and restart; customers lose access immediately (their tokens cannot be verified).
- Rotating `CUSTOMER_JWT_SECRET` signs every customer out (access tokens stop verifying and the one-time codes in flight stop matching); sessions can start again by logging in. It must never equal `MOBILE_JWT_SECRET`.
- Email is sent only if both `RESEND_API_KEY` and `EMAIL_FROM` are set. Keep them unset in development.
- A customer locked out after 5 failed sign-ins waits 15 minutes; staff can clear it by resetting the customer's password through "forgot password".

## Review photos before releasing a vehicle to its customer

New photos are private. `npm run photos:release-report` is read only: it lists each vehicle that has photos with how many exist, how many are released and how many are hidden (serials and counts, never a URL). Staff review the photos in the app and release the reviewed ones with the staff endpoint (slice 4). It targets `MIGRATION_DATABASE_URL` only; compare the printed project ref with your private notes.

## Object storage (Cloudflare R2)

- The API reaches R2 at `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` with the four `R2_*` credentials. Use an API token limited to the one bucket (object read, write, delete), not an account-wide key.
- Staff uploads work by a presigned link, so the bucket needs a CORS rule allowing PUT with the `Content-Type` header from the app's origin.
- Customer photos and documents are streamed by the API, so the API needs outbound access to R2 and the customer app never talks to R2.
- Public stock images (slice 7) will use a separate public bucket and domain. Do not put private files there.

## Personal data kept in the database: retention

`Enquiry` (name, email, phone, message from the public website) and `Message` (customer chat) hold personal data. **There is no automatic deletion yet** (planned, after the retention periods are decided). Until then: decide the periods with the business (a common starting point is to delete handled enquiries after 12 months and chat after 24 months, or on a customer's account deletion request), record them in the privacy policy, and delete by hand when a person asks. Deleting a customer account already removes their personal data from `User` but leaves their `Message` rows; delete those too on request. Never copy these tables into logs, tickets or screenshots.

## Backfill milestones (once, after the slice 2 migration is applied)

`npm run backfill:milestones` is a **dry run**: it prints the target, the project ref and counts, and writes nothing. It targets `MIGRATION_DATABASE_URL` only. Run it, compare the ref with your private notes, read the counts. `npm run backfill:milestones -- --apply` writes; run it only with the maintainer's approval for that run, after a snapshot. It is idempotent (existing milestones are skipped). It plans only milestones with a known date: BOUGHT from the purchase date, BOOKING_RECEIVED and SHIPPED from the first time the status was entered.

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

- This repo owns the schema. Migrations run only through `npm run migrate` (see "Run a migration" above): a maintainer approves every `deploy`, compares the printed host first, and takes a backup before touching a database that holds real data. The tool does not identify the environment from the database name.
- Run the test-harness commands only against the throwaway container, through `npm run test:db` (see `docs/testing.md`).
- Restore drills and backup procedures are owned by the CargoDev project until that backend is retired.
