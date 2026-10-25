# ADR 0006: Signed file access and add-only milestones

- Status: **Accepted**
- Date: 2026-10-25

## Context

Customers must see documents and photos of their own vehicles without ever getting a permanent public link, and see a
timeline of their vehicle. Staff upload files directly to storage. Files and milestones are written by several actors
(staff, the daily job, a backfill) that can overlap.

## Decision

1. **Private by default for customers.** A customer never receives a stored URL. They receive a signed download link,
   valid 5 to 15 minutes (`SIGNED_URL_TTL_SECONDS`), and only after the server has checked, in order: the account (from
   the token), the vehicle (theirs, same org, not deleted, export track, released with `customerVisible`), then the file
   (`visibleToCustomer`: photos default to yes, documents to no). Every failure is the same 404.
2. **One signing function.** `presignUpload` and `signedDownloadUrl` in `src/lib/object-storage.ts` are the only code that
   turns a key into a link, behind an `ObjectStore` interface. The key is always inside the org's folder; the server
   builds upload keys itself.
3. **Uploads go straight to storage** with a 300-second link that pins the exact size and content type.
4. **Milestones are add-only for automation.** One row per (vehicle, type), inserted with ON CONFLICT DO NOTHING inside the
   status-change transaction. Only a staff member's explicit undo removes one. Clearing an ETD or reverting a status
   removes nothing until the maintainer decides the rule (see the slice 2 report).
5. **New columns are invisible to the old app**: `VehiclePhoto.visibleToCustomer` (default true) and
   `VehicleDocument.visibleToCustomer` (default false) are additive columns with defaults, so rows written by the old app
   are valid and nothing it reads changes.
6. **Backfill** is a dry run unless `--apply`, targets `MIGRATION_DATABASE_URL` only, prints counts only, and plans only
   milestones with a recorded date.

## Consequences

- Until the S3 client is installed the store is not configured: presign answers "File storage is not configured." and
  customer links cannot be produced. Everything else is built and tested against the interface.
- Existing photos become visible to a customer as soon as staff release their vehicle (slice 4); staff can hide them per photo.
