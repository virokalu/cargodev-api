# Environment variables

Names and purposes only. Never commit values. Real values live in the host's secret settings and each developer's local `.env`.

Variables are validated at startup in `src/config/env.ts`. The app refuses to start if one is invalid.

| Variable | Purpose | Required now |
|---|---|---|
| NODE_ENV | development / test / production | yes (default development) |
| PORT | Listen port | yes (default 4000) |
| LOG_LEVEL | Logger verbosity | no |
| TRUST_PROXY_HOPS | Number of reverse proxies we control in front of the server (default 0 = trust none). Decides which X-Forwarded-For entry is the client IP for rate limiting | no (set before go-live) |
| APP_ENV | Which deployment this is: `production`, `staging` or `development` (default `development`; anything else stops the start). Logged at start-up with the client-IP mode, scheduler and retention state and the build commit. It tightens the public stock image address rule (above) | set on every deployment |
| CLIENT_IP_SOURCE | Where the client address (rate limits, logs) comes from: `socket` (default: the TCP peer, every forwarding header ignored), `hops` (X-Forwarded-For through exactly TRUST_PROXY_HOPS proxies) or `header` (the single header in CLIENT_IP_HEADER; safe only when the host's edge overwrites it). **Required when NODE_ENV=production: startup fails if it is unset** (no silent default behind a load balancer). Outside production, unset means `hops` if TRUST_PROXY_HOPS > 0, otherwise `socket`. In `socket` mode the API logs one masked warning a minute (header NAMES only) when it sees X-Forwarded-For, Forwarded, X-Real-IP, True-Client-IP, CF-Connecting-IP or X-Client-IP, because it probably sits behind a proxy. See docs/deployment.md | set before go-live |
| CLIENT_IP_HEADER | The header name for `header` mode (for example `true-client-ip`); required then, ignored otherwise. A plain header name; not `authorization`, `cookie`, `host` and similar. A missing or non-IP value falls back to the socket address with a masked warning | with header mode |
| DATABASE_POOL_MAX | Database connections this instance may hold (default 10, 1 to 100) | no |
| SHUTDOWN_TIMEOUT_MS | Deadline for the whole graceful shutdown after SIGTERM (default 30000, 1000 to 120000). The host's termination grace should be a few seconds longer | no |
| SCHEDULER_SHUTDOWN_TIMEOUT_MS | Of that, how long a running scheduled job may take to finish (default 20000). Must be shorter than SHUTDOWN_TIMEOUT_MS | no |
| SSE_MAX_CONNECTIONS | Cap on simultaneous notification streams on this instance (default 500) | no |
| DAILY_JOB_UTC_HOUR | UTC hour 0-23 the daily job runs (default 2) | no |
| SCHEDULER_ENABLED | true/false (default true). Set false on instances and in tests that must not run scheduled jobs | no |
| CORS_ALLOWED_ORIGINS | Comma-separated browser origins allowed | no |
| DATABASE_URL | Runtime DB connection. Local dev DB only, never a shared or production one | yes |
| MOBILE_JWT_SECRET | Signs access tokens (long, random) | with auth |
| ORG_ID | Default org for login lookup and cron only | with auth |
| PUBLIC_STOCK_ENABLED | `true` turns on the public website API (`/api/public`), the staff stock tools and the enquiries inbox; default `false` (none of them exist) | no |
| PUBLIC_ALLOWED_ORIGINS | Comma-separated website origins allowed to call `/api/public` from a browser. Empty means none. Never `*` (startup fails). Separate from CORS_ALLOWED_ORIGINS | with the website |
| PUBLIC_STOCK_IMAGE_BASE_URL | Public base URL (a custom domain on the PUBLIC bucket) stock images are served from. Unset means stock images are not shown. **Always an https address with no credentials, query or fragment** (the start stops otherwise). With `APP_ENV=production` an `r2.dev` address is refused with a clear message (production needs a custom domain); in staging and development it is allowed with one masked start-up warning | with the website |
| R2_PUBLIC_STOCK_BUCKET_NAME | The PUBLIC R2 bucket stock images are uploaded to (same account and credentials as the private bucket, which must be configured). Unset means stock image uploads are refused | with the website |
| TURNSTILE_SECRET | Cloudflare Turnstile secret for the enquiry form. Unset skips the check; set, a missing or invalid token is refused | no |
| R2_PUBLIC_URL | Public base URL files are served from. Required to attach any file: every file URL is checked against it and the caller's own org folder | with files |
| R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME | Cloudflare R2: signing staff uploads, reading files for customers, deleting objects. **All four or none** (a partial set fails startup). `R2_ACCOUNT_ID` is the 32-character Cloudflare account id; the client always talks to `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. Same names as CargoDev | with files |
| EXPO_ACCESS_TOKEN | Expo push (optional) | no |
| APP_MIN_VERSION | The oldest customer app build the API still serves, like `1.2.3` (default `1.0.0`). Returned by `GET /api/customer/v1/app/min-version`, which needs no token. Raise it to make old app builds ask the user to update | no |
| ARRIVAL_REMINDER_DAYS | Days after a vehicle ships before staff are reminded that no arrival is recorded (then weekly), 1 to 365, default 45 | no |
| RETENTION_DRY_RUN | **Default `true`, in every environment.** While `true` the daily job only counts what it WOULD remove and logs one masked line (`retention DRY RUN, nothing removed, would remove: otpCodes=… customerSessions=… refreshTokens=… readAlerts=… unverifiedAccounts=… skippedOrgs=…`); nothing is deleted and no summary row is written. Set `false`, on purpose, to let it delete. Exactly `true` or `false`; anything else stops the start | optional |
| RETENTION_OTP_DAYS | The daily job deletes one-time codes that expired more than this many days ago. 1 to 3650, default 30 | optional |
| RETENTION_SESSION_DAYS | The daily job deletes sign-in sessions (customer `CustomerSession` and staff `RefreshToken`) that expired, or were revoked, more than this many days ago. 1 to 3650, default 30 | optional |
| RETENTION_ALERT_DAYS | The daily job deletes customers' READ alerts older than this many days (unread alerts and staff notifications are kept). 1 to 3650, default 180 | optional |
| UNVERIFIED_ACCOUNT_DAYS | The daily job anonymises self-registered customers who never verified their email within this many days, and have no vehicle, chat or link request (the account is treated like one the customer deleted). 1 to 3650, default 14 | optional |
| STAFF_AUTH_CACHE_SECONDS | How long (0 to 300 seconds, default 30) the API remembers, per process, that a staff user is still active and which role the DATABASE gives them, before it reads the user row again. Creating, editing, deactivating or changing the role of a staff account in this process clears the entry at once; another instance sees it within this time. `0` turns the cache off. Open staff streams ignore the cache and re-check every 60 seconds. See docs/security-model.md | optional |
| STAFF_SIGNED_URL_TTL_SECONDS | How long a signed link for viewing a stored file, given to STAFF, stays valid, in seconds (60 to 900, default 600). Links point at the storage API host and are never stored or logged | no |
| CUSTOMER_FILE_CACHE_SECONDS | How long a customer's app may cache a photo or document the API serves (`Cache-Control: private, max-age=N`), 0 to 86400, default 300 | no |
| OTP_PEPPER | Keys the HMAC that protects one-time codes at rest (32+ **bytes**, random, unique per environment, **different from MOBILE_JWT_SECRET and CUSTOMER_JWT_SECRET**: startup fails otherwise). Required whenever CUSTOMER_JWT_SECRET is set. Rotating it makes outstanding codes invalid (they live 10 minutes) | with the customer API |
| CUSTOMER_JWT_SECRET | Signs customer access tokens (32+ characters, unique per environment, **different from MOBILE_JWT_SECRET**: startup fails if equal). Unset means the customer API is not mounted | for the customer app |
| CUSTOMER_SELF_SIGNUP | true (default) or false. false: register does nothing, only customers staff created and enabled can sign in | no |
| RESEND_API_KEY | Resend API key for transactional email (same name as CargoDev). **Unset means nothing is ever sent**: `src/lib/email.ts` only logs a masked notice. Tests delete it | no |
| EMAIL_FROM | Sender address for outgoing email, for example `Name <no-reply@your-domain>`. Required together with `RESEND_API_KEY` | no |

## Test-only variable

| Variable | Purpose |
|---|---|
| TEST_DATABASE_URL | The throwaway database for `npm run test:db`. Read only by the test harness, never by the app. Must point at localhost (or the CI service container) and a database named `cargodev_test...`; the harness refuses anything else. Never set this to a real database. |

## Migration-only variables

Read only by `npm run migrate` (`scripts/migrate.ts`), never by the app. See `docs/testing.md`.

| Variable | Purpose |
|---|---|
| MIGRATION_DATABASE_URL | Optional. The database migrations run against, **direct (non-pooled)** connection. If unset, `DIRECT_URL` is used |
| DIRECT_URL | Same name as in CargoDev: the direct connection used for migrations when `MIGRATION_DATABASE_URL` is not set. The app itself never reads it |

Migrations never use `DATABASE_URL` (the pooled runtime connection). Nothing checks which database `DIRECT_URL` points at, so follow the runbook before every `deploy`.

## Rules

- Adding a variable: update `env.ts`, `.env.example`, this file and the CI dummy env in the same PR.
- Secrets must be unique per environment (local, staging, production). Never reuse production secrets locally.
- If a secret leaks: rotate it immediately, then investigate.
