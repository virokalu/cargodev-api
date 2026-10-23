<!-- Place this file at .github/pull_request_template.md -->

## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] Every query filters by `orgId` taken from the verified token
- [ ] Input validated with zod (server side)
- [ ] Role allow-list enforced on every new route
- [ ] Mutations write an `ActivityLog` row in the same transaction
- [ ] Tri-state `Boolean?` fields are not coerced to `false`
- [ ] Tests added: 401, 403 per disallowed role, 404 for another org's id
- [ ] No secrets, real hostnames or customer data added
- [ ] Docs updated if behaviour or the API contract changed
- [ ] No `prisma migrate` run against a shared database

## Notes for the reviewer

<!-- Anything risky, anything you are unsure about. -->
