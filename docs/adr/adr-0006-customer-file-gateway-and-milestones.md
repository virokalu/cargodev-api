# ADR 0006: The customer file gateway and add-only milestones

- Status: **Accepted**
- Date: 2026-10-25

## Context

Customers must see documents and photos of their own vehicles, and a timeline of their vehicle, without ever being given a
way to reach the storage directly. Files and milestones are written by several actors (staff, the daily job, a backfill) that
can overlap. Existing files are stored as full public URLs (see Consequences).

## Decision

1. **Customers get files from the API, not from R2.** `GET /photos/:photoId/image` and `GET /documents/:documentId/file` run
   `requireCustomer`, then authorise in a fixed order (the account from the token; the vehicle: theirs, same org, not deleted,
   export track, `customerVisible`; the file: `visibleToCustomer`), and only then read the object from R2 with the API's own
   credentials and stream it. Any failure is the same 404 and nothing is read. No redirect, no signed link. DTOs, errors and
   logs never contain an object key, an R2 host or the account id (the redactor scrubs them from logged errors).
2. **Safe headers:** `Content-Type` from the key's allowlisted extension, `X-Content-Type-Options: nosniff`, a sandboxing
   `Content-Security-Policy`, `Cache-Control: private, max-age=CUSTOMER_FILE_CACHE_SECONDS`, `ETag` with `If-None-Match` / 304, `inline`
   for images and `attachment` for documents. Limits per IP and per customer.
3. **Presigned URLs only for staff uploads:** 300 seconds, the exact size and content type signed, no checksum headers
   (R2 does not take the SDK's default CRC32; both checksum settings are `WHEN_REQUIRED`). The key is built by the server and its
   extension comes from the signed type.
4. **Allowlist:** jpeg, png, webp and pdf, matched exactly, at upload and again at serve time. No svg, no html.
5. **Cloudflare R2** is the object store, reached with the endpoint derived from a validated
   32-hex account id and region `auto`; it never defaults to an AWS endpoint. It lives behind an `ObjectStore` interface
   (`r2-object-store.ts`), so tests use a recorder and a later Cloudflare Worker gateway can replace the API proxy.
6. **Options.** API proxy now. A Cloudflare Worker gateway later (same checks at the edge in front of a private bucket,
   bytes off the API) once traffic justifies it. Presigned GETs for customers were rejected: a link is a bearer secret.
7. **Thumbnails.** After a photo is added (or staged during vehicle creation) the API reads the original from R2, makes a small
   version with `sharp` (approved, 0.35.5, Apache-2.0; its libvips binaries are LGPL-3.0 optional platform packages) and writes
   it next to the photos folder (`photos-thumb/<same name>`, or `uploads/staging-thumb/` for staged photos). Uploaded bytes are
   never trusted: the real format is read from the bytes and must be jpeg, png or webp (an SVG, GIF or anything else renamed to
   .jpg is refused), the pixel count is capped before decoding (50 million), EXIF orientation is applied and then all metadata
   (GPS, camera) is dropped. It is best effort: a photo without a thumbnail is served in full. The original is the "full" version.
8. **Public stock images (slice 7)** go in a separate public bucket on a custom domain with long-cache headers and random ids;
   nothing private is ever put there. Behind `PUBLIC_STOCK_ENABLED`.
9. **Milestones are add-only for automation, with one narrow removal rule.** One row per (vehicle, type), inserted with
   ON CONFLICT DO NOTHING in the status-change transaction. Automation records them with no person attached
   (`recordedById` empty). When the status goes **down** (the ETD is cleared, or shipped is reverted) the same transaction
   removes ONLY the automatic milestones for the statuses left (BOOKING_RECEIVED, SHIPPED) that are still untouched
   (`recordedById` empty), and writes an ActivityLog row for each removal. A milestone a staff member recorded, or whose
   date a staff member moved, is never removed; later milestones (B/L, arrived, delivered) are never touched. Edits lock the
   vehicle row (`SELECT ... FOR UPDATE`) and decide from a fresh read, so a concurrent set and clear of the ETD cannot
   leave the status and its milestone disagreeing.
10. **Everything customer-facing is private by default:** `Vehicle.customerVisible`, `VehiclePhoto.visibleToCustomer` and
    `VehicleDocument.visibleToCustomer` are all `false` for new rows. They are additive columns with defaults, invisible to the old app.
11. **Backfill and reports** are dry-run or read-only, target `MIGRATION_DATABASE_URL` only, and print counts only.

## Consequences

- **Existing file references** (checked read-only on staging: 52 photos, 24 documents, 2 auction sheets) are all full public
  URLs under the configured public base, inside `org/<orgId>/`. The gateway derives the key from the URL, so no data change is
  needed. Staff clients keep using the stored public URLs; the bucket stays as it is.
- **Making the bucket private later** (a decision for the maintainer, not part of this change) needs, in order: (a) a way for
  staff clients to read files without the public URL (a staff gateway like the customer one, or presigned GETs for staff);
  (b) optionally, converting stored URLs to keys with an idempotent, dry-run-first backfill; (c) switching the bucket;
  (d) removing the public base from the staff clients. Step (a) must exist before (c).
- Customer downloads use API bandwidth and one open connection each until a Worker gateway exists.
- Enquiry and Message rows hold personal data; see the retention note in `docs/runbook.md` and `docs/privacy-checklist.md`.

## Decisions recorded later

- **Cancelled vehicles** (row colour "Unit Canceled" / "Resold in Auction") are never shown to customers and there is no placeholder card; the cancellation reason and the row colour name stay hidden everywhere. Closed by FTJ.
- **No amount of any kind** is shown to customers (no price, no per-vehicle amount, no total purchase value). The unused columns are listed in `docs/deferred/unused-columns.md`.
