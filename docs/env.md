# Environment variables

Names and purposes only. Never commit values. Real values live in the host's secret settings and each developer's local `.env`.

Variables are validated at startup in `src/config/env.ts`. The app refuses to start if one is invalid.

| Variable | Purpose | Required now |
|---|---|---|
| NODE_ENV | development / test / production | yes (default development) |
| PORT | Listen port | yes (default 4000) |
| LOG_LEVEL | Logger verbosity | no |
| TRUST_PROXY_HOPS | Number of reverse proxies we control in front of the server (default 0 = trust none). Decides which X-Forwarded-For entry is the client IP for rate limiting | no (set before go-live) |
| SSE_MAX_CONNECTIONS | Cap on simultaneous notification streams on this instance (default 500) | no |
| DAILY_JOB_UTC_HOUR | UTC hour 0-23 the daily job runs (default 2) | no |
| SCHEDULER_ENABLED | true/false (default true). Set false on instances and in tests that must not run scheduled jobs | no |
| CORS_ALLOWED_ORIGINS | Comma-separated browser origins allowed | no |
| DATABASE_URL | Runtime DB connection. Local dev DB only, never a shared or production one | yes |
| MOBILE_JWT_SECRET | Signs access tokens (long, random) | with auth |
| ORG_ID | Default org for login lookup and cron only | with auth |
| R2_PUBLIC_URL | Public base URL files are served from. Required to attach any file: every file URL is checked against it and the caller's own org folder | with files |
| R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME | Cloudflare R2: signing staff uploads, reading files for customers, deleting objects. **All four or none** (a partial set fails startup). `R2_ACCOUNT_ID` is the 32-character Cloudflare account id; the client always talks to `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. Same names as CargoDev | with files |
| EXPO_ACCESS_TOKEN | Expo push (optional) | no |
| CUSTOMER_FILE_CACHE_SECONDS | How long a customer's app may cache a photo or document the API serves (`Cache-Control: private, max-age=N`), 0 to 86400, default 300 | no |
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
