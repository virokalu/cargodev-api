# Runbook

Procedures only. Live hostnames, dashboard links and contacts are kept privately, not in this public repo.

## Before go-live: decide where the client address comes from

The daily job also runs retention (docs/architecture.md), **in dry run until you set `RETENTION_DRY_RUN=false`**: first read the daily `retention DRY RUN … would remove: …` line in the log for a few days, and only when the counts are what you expect switch it on. Rollback is setting it back to `true` (data already removed stays removed). To see what it removed, look for `RETENTION_CLEANUP` rows in the activity log (counts only); a run that removed nothing writes no row. To keep data longer or shorter, change `RETENTION_*_DAYS` / `UNVERIFIED_ACCOUNT_DAYS` and restart; the next daily run applies the new value. An org with no administrator account is skipped (`retentionSkippedOrgs` in the job result).

Rate limiting and the audit trail use the client IP, chosen by `CLIENT_IP_SOURCE` (`hops`, `header` or `socket`; REQUIRED in production, docs/deployment.md; in socket mode a masked warning appears in the log if forwarding headers are seen). Behind a load balancer `socket` makes every request look like it comes from the balancer and share one rate-limit bucket, so decide the mode and run the self-test below before go-live. The notes under "set the proxy hop count" still apply to `hops`.

## Before go-live: set the proxy hop count

Rate limiting and the audit trail use the client IP. By default the server trusts no proxy (`TRUST_PROXY_HOPS=0`), so behind a load balancer every request would look like it comes from the balancer and share one rate-limit bucket. Once the hosting setup is chosen, set `TRUST_PROXY_HOPS` to the number of proxies we control in front of the server (usually 1), and check it: send a request with a made-up `X-Forwarded-For` header and confirm the logged IP is the real client, not the made-up value. A value higher than the real hop count lets clients spoof their IP; never use "trust all". This is only safe when the server cannot be reached except through those proxies (firewall the origin), because a direct client could otherwise send its own header.

## Release order

1. **Additive migration first, from the maintainer's laptop**, against the direct (non-pooled) connection: `npm run migrate -- status` (compare the printed project reference with the private notes), read the SQL and the scan result, back up if the database holds real data, then `deploy` only with the maintainer's approval for that run. Additive migrations are safe while the old code is still running.
2. **Then deploy the code** (the image built from the same commit). Never the other way round: new code that expects a column the database does not have has no safe rollback.
3. Check `GET /health`, then the smoke tests that apply (docs/launch-checklist-stock.md for stock).
4. A non-additive ("contract") migration is a separate, explicitly approved release, after the code that needed the old shape is gone.

The API host never holds `MIGRATION_DATABASE_URL` or `DIRECT_URL`. On staging also leave `RESEND_API_KEY` and `EMAIL_FROM` unset.

## Deploy

1. Merge to `main` through a PR with passing CI.
2. Deploy from the host's pipeline (details kept privately).
3. Check `GET /health` returns `{ "data": { "status": "ok" } }`.

## Client address self-test (after every host or setting change)

Goal: prove a client cannot choose its own address. Use a throwaway address and the sign-in route (it is rate limited per address, 10 a minute).

1. From one machine send 12 sign-in requests quickly with different **fake** forwarding headers each time:
   `curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" -H "X-Forwarded-For: 198.51.100.$i" -H "True-Client-IP: 198.51.100.$i" -d '{}'` for i in 1..12.
2. **Expected in `socket` and `hops` mode:** requests 11 and 12 are `429` (the fake headers did not give a fresh bucket). In `hops` mode also try one request with a single fake X-Forwarded-For: if you pass through exactly the proxies you counted, the address is the one your outermost proxy saw, not your fake.
3. **Expected in `header` mode:** send 12 requests with the SAME fake value in the configured header, then one with a different fake value. If the edge overwrites the header, all 13 are counted against your real address (the fake values never matter) and request 11 onward is `429`. **If the different fake value gets through (not 429), the edge is passing client headers: switch back to `socket` at once.**
4. Look at the log line for these requests: the address shown must be your real one in every mode, never a fake value.
5. Send one request with the configured header removed: it must still work (socket address used) and a masked warning appears in the log (the header name only, never a value).

## Run a migration

Migrations are additive-first (ADR 0004) and run only through `npm run migrate -- <command>`. The tool does not know which environment a database is, so you do:

1. Run `npm run migrate -- status` (read-only). It prints the target host, port and database name, what `_prisma_migrations` holds, the pending migrations and the scan result.
2. **Compare the printed project ref** with the test project's ref (kept in the private notes, not in this repo). The host alone is not enough: pooler hosts are shared by every project in a region. For a pooler URL the ref is the part of the user name after `postgres.`; for a direct URL it is the middle of `db.<ref>.supabase.co`. It is printed to the terminal only. If it is not the project you intend, stop.
3. Before any `deploy` against a database that holds real data, **take a backup or snapshot and confirm it with a teammate**.
4. Read the printed SQL. A flagged migration (DROP, RENAME, type change, NOT NULL without default, a new table missing org_id/index/RLS) stays blocked until a maintainer adds its name to `prisma/migrations/scan-approved.txt`.
5. Run `deploy` only with the maintainer's approval for that run. Coding agents never run `deploy` on their own.
6. If the tables exist but `_prisma_migrations` is empty or missing, `deploy` stops. The maintainer baselines the history by hand; this tool never runs `migrate resolve`.

## Move to another host

The service is portable on purpose (docs/deployment.md: portability checklist). An afternoon, in this order:

1. Build the image from the current commit (`docker build .`) and run it locally with the environment variable names from docs/deployment.md and fake values, to confirm it starts and `/health` answers.
2. Create the service on the new host from `docs/render.yaml.example` (or the host's equivalent): one instance, the health check path, a termination grace of at least `SHUTDOWN_TIMEOUT_MS` plus a few seconds, and the variable **names** from the table in docs/deployment.md. Set the values in the host's dashboard from the private notes. Do not set `MIGRATION_DATABASE_URL` or `DIRECT_URL`.
3. Check the database allows connections from the new host (the provider's network rules), and run `npm run db:latency` from the new host to see the distance.
4. Decide `CLIENT_IP_SOURCE` for the NEW host's edge and run the self-test above before sending real traffic.
5. Start with `SCHEDULER_ENABLED=false` on the new service while the old one still runs, to avoid two daily jobs racing (the advisory lock makes it safe, but be tidy).
6. Test through the new address: sign-in, a customer file through the gateway, a staff upload (the storage CORS rule is on the bucket, not the host), a push, an email on a test account.
7. Switch DNS (or the app's API address) to the new service. Watch the logs and the uptime monitor.
8. Set `SCHEDULER_ENABLED=true` on the new service and `false` on the old, then stop the old one once nothing reaches it. Remove its secrets from the old host.
9. Rotate the secrets that were on the old host if it is not under your control any more.

## Backups and the restore drill

- **Weekly encrypted dump, off-platform.** Once a week a scheduled job (outside the API host and outside the database provider) dumps the database with the provider's own tools, encrypts the file (a passphrase or key kept in the private password manager, not on the machine doing the dumping), and stores it in a different provider's storage. Keep the last several weeks. The database provider's own backups are in addition, never instead.
- **Restore drill, every quarter and after any major change:** restore the latest dump into a **throwaway** database (never into a live one), start the API against it with fake secrets, and check: the migration history table matches the repository, row counts for the main tables look right, a customer can sign in on a test account, a vehicle opens, `npm run migrate -- status` shows nothing pending. Record the date, the dump's age and how long it took. Delete the throwaway database afterwards.
- **What a dump does not contain:** the files in object storage (photos, documents, stock images). Those need their own copy plan (versioning or a replicated bucket); see docs/storage-migration.md for the private bucket.
- A dump contains personal data: encrypt it, restrict who can read it, and delete old ones on the retention schedule (docs/privacy-checklist.md).

## Uptime monitoring

Use an **external** monitor (not on the API host, not on the database provider): request `GET /health` every minute from outside, alert after two failures in a row by email and phone push to at least two people, and also alert when the response is not the expected `{ "data": { "status": "ok" } }`. `/health` does not touch the database, so also run a second, slower check that proves the database path (for example, a customer-facing read on a test account every five minutes). Page on the host's own status as well. After any host change, confirm the monitor still points at the right address.

## Customer API

- **Forcing an app update:** set `APP_MIN_VERSION` (for example `2.0.0`) and restart. The app checks `GET /api/customer/v1/app/min-version` at start and shows an update screen to older builds. It takes no token, so it also reaches users who are signed out.
- **Releasing a vehicle to its customer:** vehicles, photos and documents are all private by default. Review with `npm run photos:release-report`, then release with the staff endpoints (`PATCH /vehicles/:id/customer-visibility`, `/photos`, `/documents/:docId`). A vehicle is shown to its customer only when it is theirs, an export vehicle, released, and not cancelled.

- It is mounted only when `CUSTOMER_JWT_SECRET` is set. To switch it off, unset it and restart; customers lose access immediately (their tokens cannot be verified).
- Rotating `CUSTOMER_JWT_SECRET` signs every customer out (access tokens stop verifying and the one-time codes in flight stop matching); sessions can start again by logging in. It must never equal `MOBILE_JWT_SECRET`.
- Email is sent only if both `RESEND_API_KEY` and `EMAIL_FROM` are set. Keep them unset in development.
- A customer locked out after 5 failed sign-ins waits 15 minutes; staff can clear it by resetting the customer's password through "forgot password".

## Public stock and enquiries

- **Switching it on:** set `PUBLIC_STOCK_ENABLED=true`, `PUBLIC_ALLOWED_ORIGINS` (the website origin), `PUBLIC_STOCK_IMAGE_BASE_URL` and `R2_PUBLIC_STOCK_BUCKET_NAME`, and restart. With it off none of the public routes or the staff stock tools exist.
- **Adding a listing:** create it (a draft), upload images (presign, upload, register), then publish (an explicit step). "Sold" and "unpublish" take it off the site at once; the site may cache a listing for up to 60 seconds.
- **Enquiries:** read them in the enquiries inbox and mark them handled. Staff are alerted that one arrived, never what it says.
- **Spam:** set `TURNSTILE_SECRET` and have the form send `turnstileToken`; the hidden `website` field must stay empty for real visitors.

## Chat

- **Answering customers:** open `GET /chat/conversations` (open conversations first), read, reply, then `POST /chat/conversations/:id/handled`. A new customer message reopens the conversation and alerts the administrators, managers and the customer's agent.
- **Telling a customer why a link request failed:** reject it with a `reason`; they see it as a chat message from the team. Without a reason they only see that it could not be approved.
- Administrators and managers see every conversation; an operator sees only the conversations of customers assigned to them (reassigning a customer moves the access at once); viewers see none. A customer deleting their account removes their conversations.

## Customer notifications

- **A customer says they get no alerts:** check their notification settings (event, push and email switches), that the vehicle is released to them, and that they have a registered device. Email needs a verified address and `RESEND_API_KEY` + `EMAIL_FROM` on the server; without them nothing is sent (a masked note is logged).
- **Rotating `OTP_PEPPER`:** outstanding codes (10 minutes) stop working; customers simply ask for a new one. Never reuse a JWT secret as the pepper (startup refuses).

## Staff tools for customers

- **A customer cannot sign in or has lost access:** `PATCH /customers/:id/login-access` with `{ "loginEnabled": false }` ends every session at once and removes their push tokens; `true` lets them sign in again (they may need "forgot password").
- **Link requests:** review `GET /link-requests`, then approve (`{ "vehicleId" }` only when the typed serial matches nothing) or reject. Approval links the vehicle but does not release it; release it, its photos and its documents separately.
- **Vehicles stuck in transit:** the daily job sends an "Arrival not recorded" notification after `ARRIVAL_REMINDER_DAYS` days, then weekly. Mark the vehicle arrived with `POST /vehicles/:id/mark-arrived`; that ends the reminders.

## Review photos before releasing a vehicle to its customer

New photos are private. `npm run photos:release-report` is read only: it lists each vehicle that has photos with how many exist, how many are released and how many are hidden (serials and counts, never a URL). Staff review the photos in the app and release the reviewed ones with the staff endpoint (slice 4). It targets `MIGRATION_DATABASE_URL` only; compare the printed project ref with your private notes.

## Object storage (Cloudflare R2)

- The API reaches R2 at `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` with the four `R2_*` credentials. Use an API token limited to the one bucket (object read, write, delete), not an account-wide key.
- Staff uploads work by a presigned link, so the bucket needs a CORS rule allowing PUT with the `Content-Type` header from the app's origin.
- Customer photos and documents are streamed by the API, so the API needs outbound access to R2 and the customer app never talks to R2.
- Public stock images use a separate public bucket and domain (`R2_PUBLIC_STOCK_BUCKET_NAME`, `PUBLIC_STOCK_IMAGE_BASE_URL`). Do not put private files there. The bucket needs a CORS rule allowing PUT with `Content-Type` from the staff app's origin, like the private one.

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
