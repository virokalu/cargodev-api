# Render environment checklist

Every environment variable the API reads, taken from `src/config/env.ts` (not from memory), with how to get each value. **Names only: no value belongs in this file, in the repository, or in a chat.** All values are set in the host's dashboard (`sync: false` entries in `docs/render.yaml.example`). A test (`tests/render-env-checklist.test.ts`) fails if a variable in `env.ts` is missing here.

How to read the columns:

- **Needed**: `always` (startup fails without it), `production` (startup fails when `NODE_ENV=production`, which a Render service sets), `with X` (needed only together with X), or `optional`.
- **Where from**: `fixed` (a value you type, given in Notes), `generate` (a new random secret, snippet below), `password manager` (a value you copy from the provider and keep there), `default` (leave unset, the code default is right), `leave unset` (do not set it on staging).
- **Sensitive**: `yes` means treat the value as a secret everywhere (dashboard only, never a ticket, a log, or a chat).

## Generating a secret (PowerShell, Windows PowerShell 5 or PowerShell 7)

Run it once **per secret** and paste each result straight into the host's dashboard and your password manager. Never reuse one value for two settings: the API refuses to start when some of them are equal.

```powershell
# 48 random bytes from the operating system's generator, written as 64 URL-safe characters
$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
[Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
```

Every generated secret below must be **at least 32 bytes** (this gives 64 characters) and **different from every other secret**.

## 1. Must set for the first staging deploy

| Name | Needed | What it is | Where from | Sensitive | Notes |
|---|---|---|---|---|---|
| `NODE_ENV` | always (default `development`) | Run mode of the process | fixed | no | Set `production`, also on staging: it switches on the production checks (for example `CLIENT_IP_SOURCE` and the file-link settings become required) |
| `APP_ENV` | optional (default `development`) | Which deployment this is: `production`, `staging` or `development` | fixed | no | Set `staging` on the staging service. It relaxes nothing about secrets; it only changes the stock-image address rule and turns on the email safety rule |
| `DATABASE_URL` | always | The database connection the API uses | password manager | yes | The **session pooler** address from the database provider. Never the migration address |
| `MOBILE_JWT_SECRET` | always | Signs staff access tokens | generate | yes | At least 32 characters. Must differ from every other secret |
| `ORG_ID` | always | The default organisation id for login lookup and the daily job | password manager | no | The id of the one organisation row in this database. Not a secret, but never put a real id in the repository |
| `CLIENT_IP_SOURCE` | production | Where the client address comes from: `socket`, `hops` or `header` | fixed | no | Choose on purpose after the self-test in `docs/runbook.md`; start with `socket` |
| `FILE_LINK_SECRET` | production | Signs the temporary file links (`/f/v1/...`) | generate | yes | At least 32 bytes. Must differ from every other secret |
| `FILE_LINK_BASE_URL` | production | This service's own public https address, used to build file links | fixed | no | The service's own origin with no path, query or fragment. Only after Render shows it |
| `CORS_ALLOWED_ORIGINS` | optional (default none) | Browser origins allowed to call the staff and customer API | fixed | no | Comma-separated origins, never `*`. Needed as soon as a browser app calls the API directly |
| `CUSTOMER_JWT_SECRET` | optional | Signs customer access tokens. Unset means the customer API is not mounted | generate | yes | At least 32 characters. Must differ from `MOBILE_JWT_SECRET`. Set it together with `OTP_PEPPER` |
| `OTP_PEPPER` | with `CUSTOMER_JWT_SECRET` | Keys the protection of one-time codes at rest | generate | yes | At least 32 bytes. Must differ from both JWT secrets |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | all four or none | Private object storage for photos and documents | password manager | `R2_SECRET_ACCESS_KEY` and `R2_ACCESS_KEY_ID`: yes; the other two: no | A half-set group stops startup. Use a **staging** bucket and a token limited to it. Without them file features report "storage not configured" |
| `R2_PUBLIC_URL` | optional, but file uploads need it | The public base address that file addresses are checked against; unset means "storage not configured" and file addresses are refused | fixed | no | Set with the four R2 values above; the staging bucket's address, never a production one |

## 2. Set later (when the feature is switched on)

| Name | Needed | What it is | Where from | Sensitive | Notes |
|---|---|---|---|---|---|
| `TRUSTED_FORWARDER_SECRET` | optional | Lets a server-side caller (the Next app) pass the real visitor address (ADR 0008). Unset means off | generate | yes | At least 32 bytes, different from every other secret. The same value is set on the caller's server, and nowhere else |
| `TRUSTED_FORWARDER_SECRET_PREVIOUS` | with `TRUSTED_FORWARDER_SECRET` | The old forwarder secret, accepted only during a rotation | password manager | yes | Remove it once the caller has switched |
| `FILE_LINK_SECRET_PREVIOUS` | with `FILE_LINK_SECRET` | The old link secret, accepted only during a rotation | password manager | yes | Remove it after about a day |
| `FILE_LINK_TTL_SECONDS` | optional (default 300) | Life of a file link, in seconds | default | no | 30 to 900. Must not exceed `FILE_LINK_MAX_TTL_SECONDS` |
| `FILE_LINK_MAX_TTL_SECONDS` | optional (default 900) | The longest a link is ever accepted | default | no | 30 to 900 |
| `RETENTION_DRY_RUN` | optional (default `true`) | `true`: the cleanup job only counts. `false`: it deletes | default | no | Switch to `false` only on purpose (`docs/runbook.md`) |
| `RETENTION_OTP_DAYS`, `RETENTION_SESSION_DAYS`, `RETENTION_ALERT_DAYS`, `UNVERIFIED_ACCOUNT_DAYS` | optional (defaults 30, 30, 180, 14) | Cleanup ages in days | default | no | Change only after a privacy decision |
| `PUBLIC_STOCK_ENABLED` | optional (default `false`) | Mounts the public website API (`/api/public`) and the staff stock routes | default | no | Turn on at the website launch (`docs/launch-checklist-stock.md`) |
| `PUBLIC_ALLOWED_ORIGINS` | optional (default none) | Website origins allowed to call `/api/public` | fixed | no | Comma-separated, never `*` |
| `PUBLIC_STOCK_IMAGE_BASE_URL` | optional | The address stock images are served from | fixed | no | A custom domain on the public bucket in production (an `r2.dev` address is refused there); https, no credentials, query or fragment |
| `R2_PUBLIC_STOCK_BUCKET_NAME` | optional, needs the R2 credentials | The public bucket for stock images | password manager | no | A different bucket from `R2_BUCKET_NAME` |
| `TURNSTILE_SECRET` | optional | Cloudflare Turnstile check on the enquiry form | password manager | yes | Unset means the check is skipped |
| `EMAIL_FROM` | optional | The sender address of outgoing email | fixed | no | Only together with `RESEND_API_KEY` |
| `EMAIL_ALLOWED_RECIPIENTS` | required on staging with `RESEND_API_KEY` | Addresses and whole domains that may receive email | fixed | no | Comma-separated, for example `a@example.test,@example.test`. Anything else is dropped. Required whenever `APP_ENV=staging` and a mail key is set |
| `EXPO_ACCESS_TOKEN` | optional | Raises Expo push limits; push works without it | password manager | yes | Optional |
| `CUSTOMER_SELF_SIGNUP` | optional (default `true`) | Whether anyone can register a customer account | default | no | `false` means staff create customers |
| `APP_MIN_VERSION` | optional (default `1.0.0`) | The oldest customer app build still served | default | no | Raise it to force an update |
| `CUSTOMER_FILE_CACHE_SECONDS` | optional (default 300) | How long a customer's app may cache a served file | default | no | 0 to 86400 |
| `ARRIVAL_REMINDER_DAYS` | optional (default 45) | Days after shipping before staff are reminded about arrival | default | no | 1 to 365 |
| `STAFF_AUTH_CACHE_SECONDS` | optional (default 30) | How long staff role checks are cached | default | no | 0 turns the cache off |
| `DAILY_JOB_UTC_HOUR` | optional (default 2) | UTC hour of the daily job | default | no | 0 to 23 |
| `SCHEDULER_ENABLED` | optional (default `true`) | Whether this instance runs scheduled jobs | default | no | Keep `true` on exactly one instance |
| `CLIENT_IP_HEADER` | with `CLIENT_IP_SOURCE=header` | The one header that holds the client address | fixed | no | Only if the host's edge overwrites that header on every request |
| `TRUST_PROXY_HOPS` | with `CLIENT_IP_SOURCE=hops` | How many trusted proxies sit in front | fixed | no | Must be above 0 in `hops` mode |

## 3. Tuning knobs: leave at the default unless you have a reason

| Name | Needed | What it is | Where from | Sensitive | Notes |
|---|---|---|---|---|---|
| `PORT` | optional (default 4000) | Port the process listens on | default | no | The host passes the port it expects; match it |
| `LOG_LEVEL` | optional (default `info`) | Logging detail | default | no | `fatal` to `silent` |
| `DATABASE_POOL_MAX` | optional (default 10) | Database connections this instance may hold | default | no | Keep below the pooler's limit |
| `SHUTDOWN_TIMEOUT_MS` | optional (default 30000) | Total time allowed to shut down after SIGTERM | default | no | The host's shutdown delay must be longer |
| `SCHEDULER_SHUTDOWN_TIMEOUT_MS` | optional (default 20000) | Of that, time a running job may take to finish | default | no | Must be shorter than `SHUTDOWN_TIMEOUT_MS` |
| `SSE_MAX_CONNECTIONS` | optional (default 500) | Most simultaneous notification streams on this instance | default | no | |

## 4. Leave unset on staging

| Name | Why |
|---|---|
| `RESEND_API_KEY` | Staging must not send email until the allow-list is in place. With it set, `EMAIL_ALLOWED_RECIPIENTS` becomes mandatory. With it unset nothing is ever sent (the message is only noted in the log, masked) |
| `TURNSTILE_SECRET` | No public enquiry form on staging |
| `EXPO_ACCESS_TOKEN` | Optional and not needed |
| `PUBLIC_STOCK_ENABLED`, `PUBLIC_ALLOWED_ORIGINS`, `PUBLIC_STOCK_IMAGE_BASE_URL`, `R2_PUBLIC_STOCK_BUCKET_NAME` | The public website API stays off until its launch checklist |
| `TRUSTED_FORWARDER_SECRET`, `TRUSTED_FORWARDER_SECRET_PREVIOUS`, `FILE_LINK_SECRET_PREVIOUS` | Only used for the first rollout of the forwarder and for rotations |
| `CLIENT_IP_HEADER`, `TRUST_PROXY_HOPS` | Only with `CLIENT_IP_SOURCE` set to `header` or `hops` |

## 5. Never on the API host (they exist only on the maintainer's laptop)

| Name | Where it is used |
|---|---|
| `MIGRATION_DATABASE_URL`, `DIRECT_URL` | `npm run migrate` (`scripts/migrate.ts`), the **direct** database connection. Never set on Render |
| `TEST_DATABASE_URL`, `TEST_DATABASE_POOL_MAX` | The real-database tests, a local throwaway database only |

## After setting them

1. Start the service. If a value is missing or wrong, startup stops and names the variable (never the value).
2. Check the start-up log line (it shows `APP_ENV`, the client-address source and which optional features are on, with no secrets).
3. Run the smoke test and the first-deploy checklist in `docs/deployment.md`.
4. Keep this file and `docs/env.md` in step with `src/config/env.ts` (the test enforces the names).
