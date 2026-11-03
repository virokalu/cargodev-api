# Known issues and open decisions

Things that are true today and are not bugs to fix silently. Each line says what, why it is left, and who decides.

| Item | Detail | Status |
|---|---|---|
| Default vehicle list sort | The API defaults to `serial` descending, track `FC`, page 1, pageSize 50. **The original mobile contract says the same** (`docs/legacy/mobile-api-reference.md` lines 124-126 and 134-135), so the mobile behaviour is unchanged. `docs/implementation-plan.md` (section 4.3) says the old *web* code defaulted to `purchaseDate desc`; that code is not in this repository. The first version of `docs/api-contract.md` followed that note | **Held, by the maintainer's decision**, until the old route handler's behaviour is sent. Do not change the default before that |
| Sign-in and refresh errors | A wrong password is `400 VALIDATION`; a lockout and every refresh failure are `403 FORBIDDEN`. No old mobile contract is in this repository to compare with | Documented in the staff contract; confirm with the iOS app |
| Personal values in the activity log | A staff edit of a customer stores the before and after name, email, phone and address; they stay after the customer deletes their account (docs/privacy-checklist.md, question 3) | Needs a decision |
| Lookup names that differ only by case | The unique is case-sensitive; the app checks case-insensitively, so two concurrent creates can store "Toyota" and "toyota". A `lower(name)` unique index would fail to build if such rows exist | Separate task; needs a read-only duplicate check on the real data first |
| One instance | Rate limits, the event bus and open streams live in memory | By design (ADR 0003) |
| Client address behind a server-side caller | Without `TRUSTED_FORWARDER_SECRET` a server (for example the Next app) shares one address for all its users | Built and optional (ADR 0008); the operator must set the secret on both sides |
| Serial uniques and soft-deleted vehicles | `(org_id, serial)` and `(org_id, serialPrefix, serialNumber)` are full uniques, so a deleted vehicle's serial is never reusable | Phase 1 report delivered; waiting for approval |
| Vehicle detail naming | The list row calls the stored status `shipmentStatus` and the effective one `effectiveShipmentStatus`; the detail calls the effective one `shipmentStatus` and the stored one `storedShipmentStatus` | By design (the detail was always effective); documented in the staff contract |
| Local test tooling | The shell may pick an old Node by default after an nvm change; the project needs Node 24 or newer (.nvmrc) | Use Node 26.5.0 (or any 22+) |

## Closed

| Item | Outcome |
|---|---|
| Sign-in and refresh errors | **Closed: matches the original contract.** `docs/legacy/mobile-api-reference.md` lines 54-56 (`400 VALIDATION` for bad shape or wrong credentials, `403 FORBIDDEN` for a lockout) and lines 67-69 (`403 FORBIDDEN` "Session expired. Please sign in again." for an unknown, expired, used or revoked token and for a deactivated account). Pinned by `tests/legacy-contract.test.ts` (statuses, codes and the exact message) |
