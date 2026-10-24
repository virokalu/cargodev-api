# Environment variables

Names and purposes only. Never commit values. Real values live in the host's secret settings and each developer's local `.env`.

Variables are validated at startup in `src/config/env.ts`. The app refuses to start if one is invalid.

| Variable | Purpose | Required now |
|---|---|---|
| NODE_ENV | development / test / production | yes (default development) |
| PORT | Listen port | yes (default 4000) |
| LOG_LEVEL | Logger verbosity | no |
| CORS_ALLOWED_ORIGINS | Comma-separated browser origins allowed | no |
| DATABASE_URL | Runtime DB connection. Local dev DB only, never a shared or production one | yes |
| MOBILE_JWT_SECRET | Signs access tokens (long, random) | with auth |
| ORG_ID | Default org for login lookup and cron only | with auth |
| CRON_SECRET | Protects the cron route | with cron |
| R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL | File storage | with files |
| EXPO_ACCESS_TOKEN | Expo push (optional) | no |

## Rules

- Adding a variable: update `env.ts`, `.env.example`, this file and the CI dummy env in the same PR.
- Secrets must be unique per environment (local, staging, production). Never reuse production secrets locally.
- If a secret leaks: rotate it immediately, then investigate.
