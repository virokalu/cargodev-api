# Known issues and open decisions

Things that are true today and are not bugs to fix silently. Each line says what, why it is left, and who decides.

| Item | Detail | Status |
|---|---|---|
| Sign-in and refresh errors | A wrong password is `400 VALIDATION`; a lockout and every refresh failure are `403 FORBIDDEN`. No old mobile contract is in this repository to compare with | Documented in the staff contract; confirm with the iOS app |
| Personal values in the activity log | A staff edit of a customer stores the before and after name, email, phone and address; they stay after the customer deletes their account (docs/privacy-checklist.md, question 3) | Needs a decision |
| Lookup names that differ only by case | The unique is case-sensitive; the app checks case-insensitively, so two concurrent creates can store "Toyota" and "toyota". A `lower(name)` unique index would fail to build if such rows exist | Separate task; needs a read-only duplicate check on the real data first |
| One instance | Rate limits, the event bus and open streams live in memory | By design (ADR 0003) |
| Client address behind a server-side caller | Without `TRUSTED_FORWARDER_SECRET` a server (for example the Next app) shares one address for all its users | Built and optional (ADR 0008); the operator must set the secret on both sides |
| Serial uniqueness among non-deleted vehicles | **Decided (ADR 0009): free reuse.** The code and migration 1 (partial unique indexes next to the old ones) are ready. **Migration 2** (drops the old full uniques; `prisma/pending-migrations/`) is written, scanned and NOT enabled: it waits for the maintainer's approval and the checklist in `docs/runbook.md` ("Before migration 2"). Until it runs, a deleted vehicle's serial is still blocked by the old index (the API answers `409` with `fieldErrors.serial`). After it runs, the same serial can exist on a deleted and an active vehicle; rollback is impossible after the first reuse | Waiting for migration approval |
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
| Restoring a deleted vehicle | There is no restore route. When one is added it must answer `409` if an active vehicle now holds the serial (documented, skipped test in `tests/serial-reuse.test.ts`) | Not built |
| Serial text that can become ambiguous | After migration 2 a serial printed on old paperwork, in a customer message, in a notification body or in a pending link request (`serialEntered`) may mean the earlier, deleted vehicle. Rows carry the vehicle id; the text does not | Documented in ADR 0009; clients must use ids |

## Not building (decided, 2026-11-07)

Considered for the chat and the vehicle stack and **deliberately left out** for now. Raise an issue before proposing any of them again.

| Feature | Decision | Reason |
|---|---|---|
| Staff-initiated chat (staff start a conversation with a customer) | Not building | Chat is customer-started support. A staff-started message would be an unsolicited contact and needs a consent and notification decision first |
| Chat attachments | Not building | Every file path is a separate exposure (type checks, storage, scanning, retention). The customer file rules (jpeg, png, webp, pdf only) are not extended to chat |
| Typing indicators | Not building | Needs a live channel per conversation for no business value; the notification stream is for events, not presence |
| Read receipts shown to the other side | Not building | The unread counts and mark-read (per side) are enough. Telling a customer or a colleague exactly when a message was read is a privacy and expectation change |
| Restoring or listing deleted vehicles | Not building | There is no restore route and no deleted list (rule 10). If added later, restore must answer `409` when an active vehicle holds the serial (ADR 0009) |
| Bulk import of vehicles | Not building | Serials, counters and the activity log make a bulk path a risk to the serial rules; staff create vehicles one at a time |
| CSV or Excel export | Not building | Exports move personal and money data out of the access rules (roles, customer visibility, no amounts to customers). Needs its own review |
| Photo reorder | Not building | The photo list keeps its creation order |
| Renaming uploaded files | Not building | File names are stored as uploaded; the object key is never shown to clients |
