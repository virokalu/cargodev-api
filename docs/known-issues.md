# Known issues and open decisions

Things that are true today and are not bugs to fix silently. Each line says what, why it is left, and who decides.

| Item | Detail | Status |
|---|---|---|
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
| Default vehicle list sort | **Decided: keep `serial` descending, track `FC`, page 1, pageSize 50, and the 17 sort keys** (the 14 of `docs/legacy/mobile-api-reference.md` line 134 plus `vesselName`, `deliveryDate`, `sellingPrice`). This equals the original mobile contract. `docs/implementation-plan.md` says the old web code defaulted to `purchaseDate desc`; send `sort=purchaseDate&dir=desc` for that order |

## Rejected

Asked for, considered and **not** done. Each has its reason, so it is not proposed again by accident.

| Request | Decision | Reasons |
|---|---|---|
| A public organization-name endpoint (G1: so a sign-in page can show the company name before anyone signs in) | **Rejected** | The frontend already knows its own organisation: the web app reads the name from an environment variable of its own, so nothing has to ask the API before sign-in. A public endpoint would answer without any token, to anyone on the internet, for no gain. The staff route `GET /organization` (with a token) stays for use after sign-in |
| Extending the refresh grace window so that a repeated refresh with the same token returns the same new token pair (G8: the lost-answer and double-tab cases) | **Rejected** | It would make **replaying a stolen refresh token safe for the thief**: whoever holds the token could keep asking and get a valid pair each time, and the theft signal (the old token coming back later) would disappear. The grace window stays as it is: a repeat inside the window is a plain `403` and the session survives; a repeat after it revokes every session of that person. **Clients use single-flight refresh**: one refresh in flight per app, every other request waits for it and reuses its answer (`docs/staff-frontend-integration.md`, section 2) |
| Image uploads for the Purchase Invoice and Cash Receipt document types (G13: allow `image/jpeg`, `image/png`, `image/webp` there) | **Rejected** | **PDF only, as the old server did.** The upload rules accept only `application/pdf` for every document type (`UPLOAD_LIMITS`, the staff contract), and these two are accounting documents; a photo is an unsigned picture, not the document. Vehicle photos go in the photo list, where images are allowed. If the business wants scans accepted for these two types, that is a separate decision that needs its own review |
