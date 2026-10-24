# Branch protection for `main`

These settings are configured in GitHub (Settings, then Rules, then Rulesets), not by a file in this repo. This page is the source of truth for what they should be.

## Required status checks

A pull request cannot merge unless **both** of these jobs from `.github/workflows/ci.yml` pass:

| Check name | What it does | Why it is required |
|---|---|---|
| `ci` | Typecheck, unit tests, the real-Postgres tests (`npm run test:db`), and `npm audit --omit=dev --audit-level=high` | The core quality gate |
| `secret-scan` | `scripts/secret-scan.sh` over every tracked file | `git commit --no-verify` skips the local hook, so this is the check that cannot be skipped |

`audit-report` (the full `npm audit`, including dev tools) is **not** required. It is informational and marked non-blocking.

When configuring the rule, pick the checks by these exact names, `ci` and `secret-scan`. A check only appears in the list after it has run once on the repository.

## Other settings

- Require a pull request before merging, with at least 1 approval and no self-approval.
- Require review from code owners (`.github/CODEOWNERS`) for sensitive paths.
- Require conversation resolution before merging.
- Require branches to be up to date before merging.
- Block force pushes and deletion of `main`.
- Squash merge only.

## If a required check is renamed

Renaming a job in the workflow makes the old required check "never run", which blocks every PR until the rule is updated. Change the rule and the workflow in the same sitting, and keep the job names `ci` and `secret-scan` unless there is a reason.
