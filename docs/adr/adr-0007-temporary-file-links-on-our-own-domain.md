# ADR 0007: Temporary file links on our own domain

- Status: **Accepted**
- Date: 2026-10-29

## Context

Staff screens and apps show vehicle photos, documents and the auction sheet. While the main bucket was public the stored address opened in a
browser. Closing the bucket means a client needs another way to load a file. The first answer was a **presigned GET link** on the storage
API host (`signStaffFileUrl`). It works, but every link shows a client the storage host, the account id, the bucket name and the object key,
and it cannot be revoked: it lives until it expires, whatever happens to the file or the person in the meantime.

We want the opposite: nothing in a link reveals where or how files are stored, and removing someone's access (or releasing a file back to
private) takes effect on links that were already handed out.

## Options

| | Presigned R2 GET link | **A gateway on our own domain (chosen)** | A Cloudflare Worker with an R2 binding (later) |
|---|---|---|---|
| What the client sees | storage host, account id, bucket, key | our hostname and database ids | our hostname and ids |
| Revocation | none until expiry | **immediate** (the database is asked on every fetch) | immediate if the Worker asks the API or a cache of it |
| Load on the API | none (the browser talks to storage) | the API streams the bytes (CPU and bandwidth) | none on the API; bytes served at the edge |
| New moving parts | none | none (same service, a new route and one secret) | a Worker, a binding, a way to ask the API, a deploy path |
| Browser caching | by the storage headers | we set private caching and an ETag | at the edge |
| CORS for GET | needed on the bucket | not needed on the bucket | not needed on the bucket |

## Decision

Build the gateway on the API's own hostname now. **A Worker with an R2 binding is a later scale option**: if streaming files ever costs the
API too much, the same link format and the same checks can be served from a Worker without changing any client.

### The link

```
<FILE_LINK_BASE_URL>/f/v1/<kind>/<id>/<variant>?o=<org>&u=<user>&a=<staff|customer>&exp=<unix seconds>&sig=<base64url>
```

- `kind` is `photo`, `document` or `auction-sheet`. `id` is the **database id** (the vehicle's id for an auction sheet), never a key.
  `variant` is `thumb` or `full`. Nothing in a link names an object, a bucket, a storage host or the account.
- `sig` is HMAC-SHA256 over the exact string `v1|kind|id|variant|o|u|a|exp`, keyed by `FILE_LINK_SECRET` (32+ bytes, different from every
  other secret). During a rotation `FILE_LINK_SECRET_PREVIOUS` is also accepted.
- A link lives `FILE_LINK_TTL_SECONDS` (30 to 900, default 300). `FILE_LINK_MAX_TTL_SECONDS` (default 900) is a hard cap on how far ahead a
  link may be dated, so even a stolen secret cannot mint a long-lived link. 30 seconds of clock skew is allowed.

### Issuing

`issueFileLink(context, kind, id, variant)` is called only **after** an endpoint's normal authorization (a staff route's role list and org
scoping). The staff file endpoints keep the field name `url`, which now holds this link, plus `expiresAt`. A client must not store a link.

### Serving: `GET /f/v1/:kind/:id/:variant` (no Bearer token)

The signature is a ticket, **not** the authorization. On every fetch, in this order: (1) the link has exactly the expected shape; (2) the
signature matches (constant-time, current secret then the previous one); (3) it has not expired and was not dated further ahead than the cap;
(4) the person is still allowed, read from the database now (a staff user through `getFreshStaffAuth`: active, in that org; a customer
through the same account check the customer guard uses, and then the **customer file gateway's own ownership and release rules**); (5) the
row exists in that org, the vehicle is not deleted, the stored address maps to a key inside the org's folder, and the type is allowed for
the kind; (6) only then is the object read.

**Every failure is the same 404** (status, headers and body), so a link cannot be used to learn whether a file exists, whose it is or why it
was refused. Successful answers carry `nosniff`, `Referrer-Policy: no-referrer`, a sandboxing CSP, `Cache-Control: private, max-age=<the
link's remaining life, at most 300>`, an ETag (304 supported), `inline` for images and `attachment` for documents, one `Range` (206) for PDFs,
a size cap, and the read from storage is stopped when the client goes away. The route has a per-IP rate limit
(`src/config/file-link-rate-limits.ts`). The signature is never logged (the redactor removes `sig=`), and request logs name the route
pattern, not the URL.

## Consequences

- Staff and customer screens can show files with a plain `<img>` or `<a>`; closing the bucket needs **no storage CORS rule for GET** and no
  presigned GET. `presignGet` and `signStaffFileUrl` are removed. Presigned **PUT** (uploads) stays.
- Un-releasing a file, deactivating a user or deleting a vehicle stops links already issued at once.
- Replacing an auction sheet makes an old link serve the new sheet (the link names the vehicle, not the object).
- The API now carries the file bytes for staff views. If that becomes a cost, move serving to a Worker (above).
- The link host is the API's own hostname for now; a dedicated hostname (`files.<domain>`) is possible later without a code change
  (`FILE_LINK_BASE_URL`).
- Customer endpoints and their Bearer gateway are unchanged; the same route can serve a customer link (`a=customer`) when an app wants
  one.
