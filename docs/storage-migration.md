# Moving existing files into the private bucket

Status: **a plan, not yet carried out.** It records how to move files that are stored today as public URLs into a private bucket that
is reached only through the API, without losing a file and without a gap in service. No names, URLs or keys belong in this file:
counts only. Every step that touches a bucket or the database is done by the maintainer or with the maintainer's approval for that
specific run.

## Where things stand

- Existing files (vehicle photos, vehicle documents, the auction sheet) are stored as **full public URLs** in
  `VehiclePhoto.url`, `VehicleDocument.url` and `Vehicle.auctionSheetUrl`. On the staging copy they all sit under the public base,
  inside their organisation's folder (`org/<orgId>/...`). A count per column is recorded in the private notes.
- New uploads are signed (a short-lived PUT link) into the same layout. **Customers never see an address or a key**: they get a photo
  or a document through the API by its database id (`/photos/:id/image`, `/documents/:id/file`); the API checks, reads the object and
  streams it. Staff screens still show the stored URLs.
- The gateway re-derives the object key from the stored URL (`keyFromOwnedUrlForOrg`), so it already works with a URL that points
  into the bucket the API can read.

## Target

- The files live in a **private bucket** with no public access and no public domain. Only the API (its access key) can read or write.
- The database stores the **object key** (for example `org/<orgId>/vehicles/<id>/photos/<file>`), not a URL. Readers build what they
  need: the gateway reads the key; staff screens get what they need from the API (a signed, short-lived link or an API stream).
- The old public bucket is closed (public access off, then emptied and deleted) only after everything has been verified.

## Order of work

Each step ends with a check. Do not start the next one before the check passes.

1. **Inventory (read-only).** Count, per table and column, how many rows hold a URL, how many point into the expected bucket and
   organisation folder, how many are anything else (those are investigated first). Count the objects in the bucket and compare with the
   rows. Record the counts only.
2. **Stop making the problem bigger: new uploads first.** Create the private bucket (no public access). Point **new** uploads at it
   (`R2_BUCKET_NAME`, signed PUT as today) and store the **key** for new rows from now on (a code change with a test, behind a
   switch). Old rows keep working because readers accept both a URL and a key during the transition. Check: upload a test file
   as staff; a customer with a released vehicle sees it through the gateway; the response carries no address.
3. **Copy and verify (old bucket to private bucket).** Copy every object, key unchanged, with a tool run by the maintainer from a
   trusted machine. Never print keys or URLs. After the copy, verify: object count equal; for every object, size equal and checksum
   equal. Check: zero mismatches, zero missing. Repeat the copy for anything uploaded to the old bucket in the meantime until a
   final pass copies nothing new.
4. **Update the stored locations to keys.** A reviewed script, run on a **copy of the data first**, then (with approval, after a
   snapshot or backup) on the real database: for each row whose URL points at the old bucket's base, store the key; in a
   transaction per batch; the number of rows changed per column is printed and must equal the inventory. This is a data update, not a
   schema change; if a new column is wanted for the key it is an additive migration, generated with `diff-script` and
   approved before any `deploy`. The old column is dropped only later, by a separate approved contract migration. Check: the count
   of rows still holding a URL is zero; the gateway test suite passes against the copy.
5. **Switch the readers to the gateway.** Staff screens stop using stored URLs: the API returns what they need (a short-lived signed
   link, or a stream through the API). The PDF export fetches through the store, not through a public URL. Check: a search for the old
   public base in the code and in API responses finds nothing; the file access tests pass.
6. **Close the old bucket.** Turn public access off on the old bucket first and watch for errors for a week (the images in old emails
   or caches will fail: expected). Only then empty and delete it. Keep one verified backup of its contents off-platform for the period
   the business chooses. Check: nothing user-facing breaks; error rates unchanged.

## Rollback

- Steps 1 to 3 change nothing the app depends on: stop at any point.
- Step 4 is reversible from the snapshot or backup taken before it, and from the old bucket (still intact).
- Step 5 is reversible by redeploying the previous version (readers accept URLs and keys during the transition).
- Step 6 is the only step that cannot be undone, so it comes last and only after the retention period.

## Risks and notes

- **Public stock images** are a different bucket by design (`docs/launch-checklist-stock.md`) and are not part of this move.
- **Thumbnails** (`photos-thumb`, `staging-thumb`) are copied with everything else; a missing thumbnail falls back to the full image.
- **Cached or emailed URLs** to the old public bucket stop working at step 6. No customer-facing screen uses them; check staff exports.
- **Cost:** reading and writing every object once; the copy is the only large transfer.
- **Never** use a developer's personal credentials for the copy: use a short-lived key limited to the two buckets, and revoke it after.
