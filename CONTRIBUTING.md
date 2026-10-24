# Contributing

## Setup

See `README.md`. Use your own dev database. Never use production credentials.

## Workflow

1. Create a branch from `main`: `feat/<short-name>`, `fix/<short-name>` or `docs/<short-name>`.
2. Make small, focused commits. Use clear messages, e.g. `feat(auth): add refresh token rotation`.
3. Before pushing run:
   ```powershell
   npm run typecheck
   npm test
   npm run db:test:up        # once; needs Docker. Prints the TEST_DATABASE_URL to set
   npm run test:db
   ```
4. Open a pull request and fill in the checklist.
5. Address review comments, resolve every thread, then squash merge.

`main` is protected: no direct pushes, 1 approval, code-owner review for sensitive paths, and two required status checks that must pass: **`ci`** (typecheck, unit tests, real-Postgres tests, runtime audit) and **`secret-scan`**. See `docs/branch-protection.md`. `git commit --no-verify` skips the local secret scan but not the `secret-scan` job.

## Review expectations

- Reviewers check the PR template checklist, not just whether it works.
- No self-approval. Ask a teammate.
- Be kind and specific. Explain the why behind a requested change.

## Tests

Every new route needs: 401 without a token, 403 for each disallowed role, 404 for another org's id. See `docs/testing.md`.

## Decisions

Significant choices get an ADR in `docs/adr/` (copy the previous one as a template).

## Dependencies

Adding a package needs a reason in the PR. Check its license, maintenance and install scripts first.
