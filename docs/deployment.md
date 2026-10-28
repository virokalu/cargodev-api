# Deployment

How the API is built, configured and run. No hostnames, project references, account ids or secrets belong in this file: those are kept
privately. Procedures (release, moving host, backups, restore drill, monitoring) are in `docs/runbook.md`.

## What runs

- **One container**, built by the `Dockerfile` (multi-stage; Node on Debian slim; non-root user; no `.env` file, no tests, no
  docs, no TypeScript sources, no dev tools). CI builds it on every change and fails if any `.env*` file is inside it.
- **One process**: `node dist/server.js` (exec form, so Node is PID 1 and receives SIGTERM). It serves HTTP, the Server-Sent Events
  streams, and runs the daily job (the in-process scheduler).
- **Nothing is written to disk.** There is no persistent disk and no local file storage: photos and documents live in object
  storage (R2), everything else in the database. A container can be destroyed and recreated at any moment.
- **All settings are environment variables** set on the host (names in `docs/env.md`). The image reads no file for configuration.

## Single instance rule

Run **exactly one instance** of the API.

Why: the rate limiters (per IP and per customer or email), the event bus behind the live streams, and the customer sign-in
throttles live in the process's memory. With two instances the limits double (a client alternates between them), and an
alert published on one instance does not reach a stream open on the other. The daily job is protected separately (below).

**Overlapping deploys.** Most hosts start the new instance before stopping the old one, so for about 60 seconds two instances run.
That is acceptable because:

- the daily job takes a Postgres **advisory lock** (`pg_try_advisory_xact_lock`), so two instances never run it at once, and the job
  is idempotent (a second run the same day creates no duplicate rows);
- a live stream on the old instance receives `event: shutdown` and the app **reconnects** (to the new instance), then calls the
  list endpoints to catch up (the stream has no replay by design);
- the limits are merely looser for those seconds.

Do not scale to two or more instances without first moving the limiters and the event bus out of memory (a new decision).

## Environment variables (names only)

| Group | Variables |
|---|---|
| Required | `DATABASE_URL`, `MOBILE_JWT_SECRET`, `ORG_ID` |
| Server | `NODE_ENV=production`, `PORT`, `LOG_LEVEL`, `CORS_ALLOWED_ORIGINS` |
| Client address | `CLIENT_IP_SOURCE`, `CLIENT_IP_HEADER`, `TRUST_PROXY_HOPS` |
| Database | `DATABASE_POOL_MAX` |
| Shutdown | `SHUTDOWN_TIMEOUT_MS`, `SCHEDULER_SHUTDOWN_TIMEOUT_MS` |
| Scheduler | `SCHEDULER_ENABLED`, `DAILY_JOB_UTC_HOUR`, `ARRIVAL_REMINDER_DAYS` |
| Live streams | `SSE_MAX_CONNECTIONS` |
| Customer API | `CUSTOMER_JWT_SECRET`, `OTP_PEPPER`, `CUSTOMER_SELF_SIGNUP`, `APP_MIN_VERSION`, `CUSTOMER_FILE_CACHE_SECONDS` |
| Email | `RESEND_API_KEY`, `EMAIL_FROM` |
| Push | `EXPO_ACCESS_TOKEN` (optional) |
| Private files (R2) | `R2_PUBLIC_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` |
| Public website stock | `PUBLIC_STOCK_ENABLED`, `PUBLIC_ALLOWED_ORIGINS`, `PUBLIC_STOCK_IMAGE_BASE_URL`, `R2_PUBLIC_STOCK_BUCKET_NAME`, `TURNSTILE_SECRET` |
| Migrations (laptop only) | `MIGRATION_DATABASE_URL` or `DIRECT_URL` |

**Never set on the API host:** `MIGRATION_DATABASE_URL` and `DIRECT_URL`. Migrations run from the maintainer's laptop (see the
release order). The running service must not be able to run them.

**Unset on staging** (so staging cannot reach production resources or send real mail): `MIGRATION_DATABASE_URL`,
`RESEND_API_KEY`, `EMAIL_FROM`. With the two email variables unset, email is a masked no-op.

## Database

- **Supabase stays the database.** It is a separate failure domain from the API host (ADR 0004 note).
- **Runtime connection:** the **session pooler** address in `DATABASE_URL`. **Migrations:** from the maintainer's laptop, against the
  **direct** (non-pooled) connection, never from the API host.
- **Pool size:** `DATABASE_POOL_MAX` (default 10) connections per instance. With one instance, keep it comfortably below the
  pooler's client limit.
- **Latency check:** `npm run db:latency` sends 50 sequential `SELECT 1` on a read-only session and prints only min, p50, p95 and max in
  milliseconds (never the address or credentials). Run it from the API host's network (or compare from the laptop) when choosing a region.

## Health, shutdown and timeouts

- **Health check:** `GET /health` returns `{ "data": { "status": "ok" } }` without touching the database, so a database blip never
  makes the host kill a healthy container. The image's `HEALTHCHECK` uses it. Point the host's health check at the same path.
- **Graceful shutdown on SIGTERM**, within `SHUTDOWN_TIMEOUT_MS` (default 30 s): stop accepting requests, send `event: shutdown`
  to every open stream, wait for a running scheduled job for at most `SCHEDULER_SHUTDOWN_TIMEOUT_MS` (default 20 s), close the
  database pool, exit 0. If anything hangs the process exits 1 at the deadline. Set the host's termination grace period to at least
  `SHUTDOWN_TIMEOUT_MS` plus a few seconds (for example 35 s), otherwise the host's SIGKILL arrives first.

## Client address (rate limits and logs)

`CLIENT_IP_SOURCE` decides where `request.ip` comes from:

| Value | Meaning | When |
|---|---|---|
| `socket` (default) | the TCP peer; every forwarding header is ignored | the API is reachable directly, or you have not verified the host's headers |
| `hops` | `X-Forwarded-For`, trusting exactly `TRUST_PROXY_HOPS` proxies | you know the exact number of proxies in front, and the API is reachable ONLY through them |
| `header` | the one header named by `CLIENT_IP_HEADER` (for example the host's "true client IP" header) | the host's edge **overwrites** that header on every request |

**Header mode is safe only when the edge overwrites the header.** If a client can send its own copy and the edge passes it
through, anyone can pick their own address and escape every rate limit. If the header is missing or is not an IP address, the
socket address is used and a masked warning is logged (the header name only, at most once a minute). Run the self-test in the
runbook after every host or setting change. Behind a load balancer with `socket`, every request shares the balancer's address and one
rate-limit bucket: set the mode before go-live.

**Production refuses to start without `CLIENT_IP_SOURCE`** (any of the three values is accepted; the choice must be deliberate). In `socket` mode, if requests arrive carrying `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `True-Client-IP`, `CF-Connecting-IP` or `X-Client-IP`, the API logs one warning a minute naming the header names (never a value or an address): that usually means a proxy is in front and the mode should be `hops` or `header`.

## Request logs

A request log line carries the method, the route PATTERN (for example `/api/v1/vehicles/:serial/files`; `(no matching route)` for an unknown URL), the status, the duration and the request id. It never carries the raw URL, the query string, a path parameter, a header or the client address, so search text, serials and tokens in a URL cannot reach a log. Authorization and cookie headers and token, hash and signed-URL parameters are redacted wherever they could still appear.

## Portability checklist

The service must be movable to another host in an afternoon. It is, as long as these stay true:

- [ ] Everything is configured by environment variables; no host-specific file, path, or API is read.
- [ ] No persistent disk, no local uploads, no local database. (A container's disk is thrown away.)
- [ ] The image is built from this repo alone (`docker build .`), with no host-specific build step.
- [ ] Health check is a plain `GET /health`; termination is a plain SIGTERM.
- [ ] Outbound dependencies are all by address and key, never by host: database, object storage (R2), email (Resend), push (Expo),
      the bot check (Turnstile).
- [ ] The only inbound dependency on the host is: HTTPS in, one port, forwarding headers as configured above.
- [ ] No cron on the host: the daily job runs inside the process.
- [ ] Logs go to standard output (the host collects them); nothing is written to a file.
- [ ] `render.yaml.example` shows the whole service definition; keep it equivalent to what is actually deployed.

## Consumers of the database

Before changing anything on the database (a migration, a pooler setting, a password, a region, a backup window), check every
consumer:

- [ ] this API (runtime, session pooler address)
- [ ] the old CargoDev application, while it is still running (it shares the schema; hence additive-first migrations, ADR 0004)
- [ ] the maintainer's laptop (migrations, direct address; `npm run migrate`)
- [ ] the weekly dump job and the restore-drill machine
- [ ] any read-only report, BI or admin tool pointed at the database
- [ ] the database provider's own dashboard users and any API keys it holds

A new consumer is added to this list before it is given access.

## Example service definition

`docs/render.yaml.example` is a minimal, secret-free definition for a Docker host (names of variables, no values).
