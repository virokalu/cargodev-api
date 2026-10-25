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
| R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME | Upload signing and deleting objects. Not used yet (needs the object-storage SDK) | later |
| EXPO_ACCESS_TOKEN | Expo push (optional) | no |

## Test-only variable

| Variable | Purpose |
|---|---|
| TEST_DATABASE_URL | The throwaway database for `npm run test:db`. Read only by the test harness, never by the app. Must point at localhost (or the CI service container) and a database named `cargodev_test...`; the harness refuses anything else. Never set this to a real database. |

## Rules

- Adding a variable: update `env.ts`, `.env.example`, this file and the CI dummy env in the same PR.
- Secrets must be unique per environment (local, staging, production). Never reuse production secrets locally.
- If a secret leaks: rotate it immediately, then investigate.
