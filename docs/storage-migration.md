# Making the main bucket private

Status: **the code is ready; the bucket has not been changed.** This file records how to turn off public access on the main
(private files) bucket without losing a file and without a gap in service. No hostnames, account ids, keys, URLs or object names
belong in this file: counts only. Every step that touches a bucket or the database is done by the maintainer, or with the
maintainer's approval for that specific run.

## Where things stand

- Existing files (vehicle photos, vehicle documents, the auction sheet) are stored as **full public URLs** in `VehiclePhoto.url`,
  `VehicleDocument.url` and `Vehicle.auctionSheetUrl`. They sit under the public base (`R2_PUBLIC_URL`), inside their
  organisation's folder (`org/<orgId>/...`).
- **Customers never see an address or a key.** They get a photo or a document through the API by its database id
  (`/photos/:id/image`, `/documents/:id/file`); the API checks, reads the object itself and streams it.
- **Staff now get signed links.** `signStaffFileUrl` (src/lib/object-storage.ts) turns a stored address into a short-lived signed
  link on the storage API host. It uses the SAME key derivation as the customer gateway (the address must start with the
  configured public base AND the key must start with `org/<the token's orgId>/`). The staff file endpoints return that link in
  their `url` field plus `expiresAt` (see docs/api-contract.md), so staff screens keep working when the bucket stops being public.
- **The stored value does not change.** The database still holds the public-looking address (it is the file's identity: the host
  is checked, the key is derived from it). Nothing in this plan edits a row.

## Plan A (chosen): keep the same bucket, disable public access

The bucket and every object stay where they are. Only public read access is switched off, once nothing depends on it.

### 1. Find out what depends on the public address (consumers checklist)

Do not switch anything off until every line is ticked or consciously accepted. Check each consumer, on staging first.

- [ ] **The staff web pages (Next.js)**: anything that renders an `<img>`, link or download from a stored address must use the `url`
      the API returns now (the signed link), never a value saved earlier. Pages that cached or stored an old address break at the switch.
- [ ] **The iOS staff app**: the same. Check image caches that key on the address (the signed link changes on every request, so a cache
      keyed on it never hits; key the cache on the file id instead). Old builds that still read the stored address stop working: decide
      the minimum app version (`APP_MIN_VERSION` is for the customer app; staff builds need their own cut-off) before the switch.
- [ ] **PDF generation**: the export fetches images through `GET /vehicles/:serial/pdf-images`, which the API now serves by fetching a
      signed link itself. Test an export with an auction sheet and several photos. Any other PDF code that fetches a stored address
      directly must change first.
- [ ] **Old links**: links already sent in emails, chats, spreadsheets or bookmarks, and any cached copy in a browser or CDN, stop
      working. Search for places staff paste addresses. Accept this, or keep access until they are replaced.
- [ ] **The customer app** needs nothing: it never had an address.
- [ ] **Public stock** is a different bucket and is not affected (below).
- [ ] **Anything else with the old public address**: a search of the code, the staff apps and the website for the public host name
      must find nothing that is still shown to a person after the switch.

### 2. Staff signed links versus the customer gateway

| | Staff | Customers |
|---|---|---|
| How a file is reached | a signed link on the storage API host (the browser or app loads it directly) | the API streams the bytes (`/photos/:id/image`, `/documents/:id/file`) |
| What the client sees | a URL that works for `STAFF_SIGNED_URL_TTL_SECONDS` (60 to 900, default 600) and `expiresAt` | an id only: never an address, a key or a link |
| Authorisation | the staff token's org, checked before anything is signed | the customer's own id, org, release flags, checked before the store is touched |
| A row that cannot be mapped | `url: null, unavailable: true`; a masked count is logged | the same 404 as any other failure |
| Caching | the API answer is `no-store`; clients must not store the link | `private, max-age=300` for the bytes only |

Staff clients must treat the `url` as a ticket, not an address: use it now, ask again later.

### 3. Bucket settings to prepare (before the switch)

- **CORS for the presigned PUT** (staff uploads go straight to the bucket): allowed origins = only the staff web app's origins;
  methods `PUT` (and `GET`/`HEAD` for staff screens that load signed links from the browser); allowed headers `Content-Type`
  (and `Content-Length` if the tool needs it); max age a few minutes. Without it uploads fail even though the link is valid. The
  rule is on the bucket, not on the API host. Re-check it after turning public access off: signed links are not public access.
- **Scoped tokens, one per bucket and per environment.** The API's key is limited to this bucket (object read, write, delete, list
  only if needed); the staging API uses a different bucket and a different key; the public stock bucket has its own key; the
  audit and copy tools use short-lived keys that you revoke afterwards. Never reuse a developer's personal key, never one key across
  environments.
- **The public domain on this bucket** (and the shared public development address `r2.dev`) will be disconnected at the switch; plan the
  order below so nothing still uses them.

### 4. Backup copy before closing

- [ ] Take a **verified copy of the whole bucket** into a separate bucket on a different account or provider (a one-way copy tool run by
      the maintainer, never printing keys). Verify: object count equal (compare with `npm run r2:audit`), and for a sample plus every
      object over a size threshold, size and checksum equal.
- [ ] Keep it until the retention period the business chooses has passed after the switch.
- [ ] Take a database snapshot too (the stored addresses are the map to the files).

### 5. Verification steps

Run `npm run r2:audit` first (read-only; it prints counts only). It shows how many objects are in each top-level folder and how many stored
addresses in the database are on the configured public address versus anywhere else. Anything "elsewhere" is investigated first: those
rows cannot be signed and will show as unavailable.

On **staging** (with its own bucket made private the same way):

1. Staff: open a vehicle, see photos, documents and the auction sheet load; open an export; upload a photo, a document and an auction
   sheet; delete one. Each works with public access OFF.
2. A signed link works until `expiresAt` and fails afterwards; a link for one object does not open another.
3. The bucket's public address answers 403/404 for an object that used to load without a signature.
4. A customer with a released vehicle still sees its photos and documents through the app (the gateway).
5. A search of logs and API responses finds no signed-link secret (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`).

Then in **production**, in this order, one change at a time: (a) deploy the API version that returns signed links and check staff screens;
(b) wait until staff app builds that read the stored address are gone; (c) take the backup copy (section 4); (d) disable public access
on the bucket (and disconnect its public domain and `r2.dev`); (e) repeat steps 1 to 5 above on production straight away.

### 6. Monitoring

- Watch the staff apps' image and download errors, and the API's rate of `unavailable` rows (the masked warning), for a week after the switch.
- Watch the storage provider's request metrics for 403s on the old public path: a few mean old links, a steady stream means a consumer
  was missed.
- The external uptime monitor and the file gateway tests (docs/testing.md) stay green.

### 7. Rollback (re-enable public access)

Nothing was copied, moved or edited, so rollback is switching the bucket's public access (and its public domain) back on. Objects, keys and
database rows are unchanged, and the API keeps working either way (customers use the gateway; staff links work with or without public
access). Do this at the first sign of a missed consumer, fix the consumer, then repeat the switch. The only thing that cannot be undone is
deleting objects, which this plan never does.

## The public stock bucket stays public

Public website stock images live in a **separate** bucket (`R2_PUBLIC_STOCK_BUCKET_NAME`) served on a **custom domain**
(`PUBLIC_STOCK_IMAGE_BASE_URL`), with the shared public development address (`r2.dev`) **disabled**, nothing private in it, and bucket
listing off (docs/launch-checklist-stock.md). It is deliberately public and is not part of this plan. The two buckets must never be
merged.

## Plan B (not chosen): move the files into a new private bucket

If the main bucket cannot be made private for a reason that cannot be removed, files can be copied to a new private bucket instead:
create it (no public access, own scoped key); point new uploads at it; copy every object with the key unchanged and verify counts, sizes and
checksums; switch the readers (the staff signed links and the gateway already derive the key from the stored address, so a stored
address still maps to the same key in the new bucket); only then close and finally delete the old bucket after the retention period. A
later, separate step may store keys instead of addresses (a data update on a copy first, with a snapshot, with approval; any new column
is an additive migration generated with `diff-script` and approved before any `deploy`). This costs one full copy and a longer
transition, which is why Plan A is preferred.

## Risks and notes

- A signed link is a bearer credential until it expires: it is never stored, never logged (the redactor strips the signature, credential and
  session token from logs and errors), and the API response that carries it is `no-store`.
- Thumbnails (`photos-thumb`, `staging-thumb`) live in the same bucket and need nothing special; a missing thumbnail falls back to the full image.
- The activity log keeps the stored addresses of files that were added or removed. They identify objects but open nothing once the bucket is
  private.
- The presign response for an upload still contains a `publicUrl` (the stored form of the address). It is an identifier, not a working link,
  after the switch; staff clients must send it back unchanged when registering the file and use the signed link from the file endpoints to view it.
