# Launch checklist: website stock (version 1)

Stock on the public website is part of version 1: the public read API, the enquiry form, the staff stock tools and the enquiries inbox.
Reserving a vehicle and the cost / CIF estimator stay deferred. A stock tab in the customer app is pending a decision (see
`docs/deferred/customer-app-stock.md`). No hostnames, project references or secrets belong in this file.

## 1. Flags and settings to switch on

Set on the API host (names only here; values are kept privately). With `PUBLIC_STOCK_ENABLED` false (the default) none of the public
routes, the staff stock tools or the enquiries inbox exist.

| Variable | Set to |
|---|---|
| `PUBLIC_STOCK_ENABLED` | `true` (last step, after everything below passes on staging) |
| `PUBLIC_ALLOWED_ORIGINS` | the website's origin(s), comma-separated, exact scheme and host. Never `*` (startup refuses it). Separate from `CORS_ALLOWED_ORIGINS` |
| `PUBLIC_STOCK_IMAGE_BASE_URL` | the public address of the public image bucket (the custom domain, below) |
| `R2_PUBLIC_STOCK_BUCKET_NAME` | the name of the PUBLIC image bucket (same account and credentials as the private bucket, which must be configured) |
| `TURNSTILE_SECRET` | the Cloudflare Turnstile secret for the enquiry form (unset skips the bot check) |

## 2. The public bucket and custom domain

- [ ] Create a **separate** bucket for stock images. It is public for reading; it must contain **nothing private** and nothing else. It
      is never the private files bucket.
- [ ] Attach a **custom domain** to it and use that address as `PUBLIC_STOCK_IMAGE_BASE_URL` (long-lived caching and a CDN are fine
      here: keys are random and never reused).
- [ ] Keys the API issues look like `stock/<hash of the org id>/<random>.<jpg|png|webp>`: no org id, no vehicle serial, no file name.
- [ ] Turn off directory listing / bucket listing for the public bucket.
- [ ] Confirm no object other than stock images is ever written there (the API writes only through signed uploads it issues).

## 3. Staff upload CORS rule (public bucket)

Staff upload images straight to the bucket with a short-lived signed link, so the bucket needs a CORS rule:

- allowed origins: **only the staff app's origin(s)** (not the website, not `*`)
- allowed methods: `PUT` (and `GET`/`HEAD` only if the staff app previews from the bucket)
- allowed headers: `Content-Type` (the signed link pins the exact size and type)
- max age: a few minutes to an hour

Without it the browser blocks the upload even though the link is valid. (The private bucket has a similar rule for vehicle uploads.)

## 4. Staff data-entry workflow

1. **Create** a listing (a **draft**): make, model and the details you have. Price is the listing price in **whole Sri Lankan rupees**
   (positive, no cents, at most 2,000,000,000), or empty. The web address (slug) is generated; it cannot be chosen or edited.
2. **Add images**: ask for an upload link, upload the file, then register it (the order follows the order added; reorder and write
   alt text for each).
3. **Review** the draft. Nothing is public yet.
4. **Publish** (an explicit step): needs at least one image. Optionally announce it to customers who have "new stock" alerts on.
5. **Sold**: mark it sold when it is; it leaves the website at once (the website may keep a cached copy for up to 60 seconds).
6. **Unpublish** to take a listing back to draft; **delete** removes it with its images.

Every change is recorded in the activity log. Enquiries arrive in the enquiries inbox; mark them handled.

## 5. Image requirements

- Types: **JPEG, PNG or WebP only.** Never SVG, HTML or PDF.
- Size: at most **8 MB** per image; at most **20 images** per listing.
- Upload originals that are large enough for a detail page (for example at least 1600 px on the long side). Use a consistent
  landscape ratio for the first image (it is the cover).
- **Thumb and full variants:** the API stores and serves the original. The website should generate or request resized variants
  through its own image pipeline or CDN (a small variant for the list, a full one for the detail page) so a list page does not
  download full-size files. The API returns one address per image.
- Write useful alt text (what is in the picture); it is returned with each image.

## 5b. What the API returns

`GET /api/public/stock` and `GET /api/public/stock/:slug`. Exactly these fields, no ids, no status, no internal data:
`slug, make, model, year, price, mileageKm, bodyType, fuel, transmission, colour, publishedAt, image` (and `description` and `images`
on the detail). `price` is `{ "amount": 1250000, "currency": "LKR" }` or `null`. Never a bare number.

## 6. What the website must do

- [ ] **Render pages on the server** (server-side rendering or static generation) so search engines and link previews see the
      content. Do not build the pages only in the browser.
- [ ] **Structured data:** emit schema.org `Vehicle`/`Product` + `Offer` JSON-LD on detail pages (name, image, `priceCurrency: "LKR"`,
      `price`, availability), so search results can show the vehicle.
- [ ] **Sitemap:** generate `sitemap.xml` from the list endpoint (the slug is the address) and refresh it when stock changes. Sold and
      unpublished listings must drop out; return 404 or 410 for them.
- [ ] **Always label prices LKR** (for example "LKR 1,250,000"). Never show a bare number, and never convert (there is no conversion).
      When `price` is null show "Contact us", not 0.
- [ ] Use the **canonical slug** in URLs; handle the 404 for a slug that has been sold or unpublished.
- [ ] The enquiry form sends: `name`, `email`, optional `phone`, `message`, optional `stockSlug`, the Turnstile token, and an empty hidden
      field named `website` (the honeypot: real visitors never fill it). Show the same "thanks" message for the 202 whatever happens.
- [ ] Respect the API's rate limits; do not call the API from the visitor's browser for the list if the server can cache it for 60 s.
- [ ] Never send an `Authorization` header to `/api/public` (it is ignored) and never put a staff or customer token in the website.

## 7. Pre-launch test list (on staging)

Run these before switching `PUBLIC_STOCK_ENABLED` on in production. The automated suite already covers the first group; this list
proves the same on the real deployment.

- [ ] **Published only:** a draft, a sold listing and an unpublished listing are absent from the list and 404 on the detail.
- [ ] **No internal data:** responses contain no `id`, no org, no `status`, no storage key, no `priceFob`, and every `price` is
      `{ amount, currency: "LKR" }` or null.
- [ ] **Key sets:** a card has exactly the listed fields (compare against section 5b).
- [ ] **Paging and filters:** page size never exceeds 24; an unknown parameter is a 400; `%`, `_` and a backslash in `q` search literally.
- [ ] **Rate limits:** the read limit trips (429 with `Retry-After`) from one address; the enquiry form trips at 5 a minute, 10 an hour per
      address and 3 an hour per email.
- [ ] **Honeypot:** a submission with the hidden field filled returns 202 and no enquiry appears in the inbox.
- [ ] **Turnstile:** a submission with a missing or wrong token is refused; a good one is accepted (with the secret set).
- [ ] **CORS allow-list:** the website origin gets `Access-Control-Allow-Origin`; an unlisted origin does not; the staff/customer API
      gives the website origin nothing.
- [ ] **Cache headers:** successful `GET`s send `Cache-Control: public, max-age=60`; errors and the enquiry `POST` send `no-store`.
- [ ] **Images:** an uploaded image loads from the custom domain; the private bucket is not reachable from the internet.
- [ ] **Alerts:** staff receive the "new website enquiry" alert without the message text.
- [ ] **Staff workflow:** create, add image, publish, mark sold, unpublish, delete all work for ADMINISTRATOR and MANAGER, and are
      refused (403) for OPERATOR and VIEWER.

## 8. Staging smoke-test outline

Curl-style steps. Replace `$API` with the staging API address and `$SITE` with the website origin (both kept privately). `$SLUG` is the
slug of a published test listing and `$DRAFT_SLUG` the slug of a draft. Expected results are in the comments. No secrets are typed in.

```sh
# 1. List: 200, a data.rows array, each row with exactly the card fields, cache header present
curl -si "$API/api/public/stock" -H "Origin: $SITE" | head -20

# 2. Detail of a published listing: 200, price is {"amount":N,"currency":"LKR"}
curl -s "$API/api/public/stock/$SLUG"

# 3. Detail of an unpublished (draft) listing: 404 {"error":{"code":"NOT_FOUND",...}}
curl -si "$API/api/public/stock/$DRAFT_SLUG" | head -1

# 4. A bad parameter and an over-large page size: 400 both
curl -si "$API/api/public/stock?pageSize=100" | head -1
curl -si "$API/api/public/stock?sort=id" | head -1

# 5. Enquiry: 202 {"data":{"accepted":true}} (use a clearly fake name and a throwaway address)
curl -si -X POST "$API/api/public/enquiries" -H "Content-Type: application/json" -H "Origin: $SITE" \
  -d '{"name":"Smoke Test","email":"smoke@example.test","message":"Smoke test, please ignore."}' | head -1

# 6. Honeypot: 202 as well, but nothing appears in the staff inbox
curl -si -X POST "$API/api/public/enquiries" -H "Content-Type: application/json" \
  -d '{"name":"Bot","email":"bot@example.test","message":"Spam spam spam","website":"http://spam.example.test"}' | head -1

# 7. Rate limit trips: send the enquiry 6 times quickly from one address; the sixth is 429 with Retry-After
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/api/public/enquiries" \
  -H "Content-Type: application/json" -d "{\"name\":\"Rate $i\",\"email\":\"rate$i@example.test\",\"message\":\"Rate limit check\"}"; done

# 8. CORS rejects an unlisted origin: no Access-Control-Allow-Origin header in the answer
curl -si "$API/api/public/stock" -H "Origin: https://unlisted.example.test" | grep -i "access-control-allow-origin" || echo "no CORS header (correct)"

# 9. CORS preflight from the website origin: 204, allow-origin = $SITE, methods GET, POST, OPTIONS
curl -si -X OPTIONS "$API/api/public/enquiries" -H "Origin: $SITE" \
  -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type" | head -12

# 10. Staff tools are not reachable without a token: 401
curl -si "$API/api/v1/stock" | head -1
```

After the run, delete the smoke-test enquiries in the inbox (mark handled) and confirm the activity log shows no unexpected entries.
