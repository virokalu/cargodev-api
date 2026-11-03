# Known issues and open decisions

Things that are true today and are not bugs to fix silently. Each line says what, why it is left, and who decides.

| Item | Detail | Status |
|---|---|---|
| Default vehicle list sort | The API defaults to `serial` descending, track `FC`. The first contract said `purchaseDate desc` ("follow the code"). No document explains the departure | Needs a maintainer decision (keep or switch) |
| Sign-in and refresh errors | A wrong password is `400 VALIDATION`; a lockout and every refresh failure are `403 FORBIDDEN`. No old mobile contract is in this repository to compare with | Documented in the staff contract; confirm with the iOS app |
| Personal values in the activity log | A staff edit of a customer stores the before and after name, email, phone and address; they stay after the customer deletes their account (docs/privacy-checklist.md, question 3) | Needs a decision |
| Lookup names that differ only by case | The unique is case-sensitive; the app checks case-insensitively, so two concurrent creates can store "Toyota" and "toyota". A `lower(name)` unique index would fail to build if such rows exist | Separate task; needs a read-only duplicate check on the real data first |
| One instance | Rate limits, the event bus and open streams live in memory | By design (ADR 0003) |
| Client address behind a server-side caller | Without `TRUSTED_FORWARDER_SECRET` a server (for example the Next app) shares one address for all its users | Built and optional (ADR 0008); the operator must set the secret on both sides |
| Serial uniques and soft-deleted vehicles | `(org_id, serial)` and `(org_id, serialPrefix, serialNumber)` are full uniques, so a deleted vehicle's serial is never reusable | Phase 1 report delivered; waiting for approval |
| Vehicle detail naming | The list row calls the stored status `shipmentStatus` and the effective one `effectiveShipmentStatus`; the detail calls the effective one `shipmentStatus` and the stored one `storedShipmentStatus` | By design (the detail was always effective); documented in the staff contract |
| Local test tooling | The shell may pick an old Node by default after an nvm change; the project needs Node 22 or newer | Use Node 26.5.0 (or any 22+) |
