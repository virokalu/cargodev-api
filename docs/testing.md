# Testing

Tools: Vitest, supertest / `app.inject()`, a throwaway Postgres for DB tests.

## Per-route checklist

- [ ] 401 without a token
- [ ] 403 for each disallowed role
- [ ] 404 for an id belonging to another org (seed two orgs, call with org A token on org B ids)
- [ ] 400 with `fieldErrors` for invalid input
- [ ] Response matches the envelope and sends `Cache-Control: no-store`

## Service tests

- Serial concurrency: parallel creates yield distinct serials
- Legacy serial bump: `lastNumber = max(lastNumber, entered)`
- ETD set/cleared produces the right status transition and a `StatusHistory` row
- Tri-state `null` survives an update (not coerced to `false`)
- FL vehicles strip shipping fields
- FC freight-agent capability (RORO/Container) is rejected when wrong
- A staff id is rejected as `customerId`
- An `ActivityLog` row exists after each mutation

## Contract tests

- Envelope shape and error codes match `docs/api-contract.md`
- Unexpected errors never leak their message

## Rules

- Test data is fake. No real names, org ids, hostnames or customer data.
- Tests must not touch a shared or production database.
- Fix a bug by first writing the test that reproduces it.
