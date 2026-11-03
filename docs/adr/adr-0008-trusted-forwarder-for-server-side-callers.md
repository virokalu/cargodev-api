# ADR 0008: A trusted forwarder for server-side callers

- Status: **Accepted**
- Date: 2026-11-01

## Context

The API limits requests per client address (300 a minute overall; 10 a minute for `auth/login` and `auth/refresh`; and others), locks sign-in per
account and address, and logs the address it saw. A web front end that runs on a server (the Next.js app) calls the API **from that server**:
the API then sees the server's address for every visitor. All visitors share one bucket, so a busy minute of sign-ins from many people produces
`429` for everyone, and a single abuser can exhaust the bucket for the whole company.

Forwarding headers cannot be believed when a client may send them: `X-Forwarded-For` and similar are ignored in `socket` mode, and in the other
modes they are only trusted because the hosting edge overwrites them. A server-side caller is not that edge.

## Options

1. **The browser calls the API directly** for sign-in, refresh, uploads and the notification stream.
   - Each browser has its own address, so limits work with no new code. CORS lists the app's origin.
   - Costs: the access and refresh tokens live in the browser, so the web app cannot keep them in an HTTP-only cookie behind its own server; the
     server cannot add its own checks or caching in front of those calls; every page-level read still goes through the server or also moves to
     the browser, which splits the data layer in two.
2. **The Next server as a plain proxy, sharing one address.**
   - No API change.
   - Costs: the shared-bucket problem above, in its worst form. Raising the limits to fit the whole company weakens the protection against a
     password-guessing visitor, and the lockout and the logs lose the real address.
3. **A trusted forwarder** (chosen): the server-side caller signs the visitor's address with a secret shared with the API; the API believes the
   address only when the signature verifies.
   - The caller stays a server (cookies, caching and checks stay possible), and the limits, lockout keys and logs see the real visitor.
   - Costs: a new secret to keep and rotate, and a few lines of signing code in the caller.

## Decision

Option 3, as an **optional** feature. With no `TRUSTED_FORWARDER_SECRET` it is off and nothing changes. Option 1 stays available at the same
time for the calls that suit a browser (uploads and the stream).

The caller sends three headers:

| Header | Value |
|---|---|
| `X-Client-IP` | The visitor's address: exactly one valid IPv4 or IPv6 address (no list, no port, no zone id, no spaces) |
| `X-Forwarder-Timestamp` | Unix seconds when it signed (digits only) |
| `X-Forwarder-Signature` | `base64url(HMAC-SHA256(secret, "v1|<ip>|<timestamp>"))`, unpadded, 43 characters, canonical encoding |

The API accepts the address only if all of these hold:

1. The address is one valid IP address and the timestamp is digits and the signature is 43 canonical base64url characters.
2. The timestamp is at most 60 seconds old and at most 30 seconds in the future (clock skew).
3. The signature matches the current secret or the previous one (rotation), compared in constant time. Every configured secret is tried.

If any check fails, the three headers are **ignored entirely**: normal client-address resolution stands (`CLIENT_IP_SOURCE`), the request is not
rejected, and one masked warning a minute is logged naming the reason and the header names, never a value, a signature or a secret.

When accepted, the verified address is `request.ip` for this request: the rate limiters, the lockout keys and the logs use it. This applies on
every route, in the staff, customer and public zones alike: the secret proves the caller, not the route.

Secrets: `TRUSTED_FORWARDER_SECRET` (32 bytes or more, different from every other secret) and an optional `TRUSTED_FORWARDER_SECRET_PREVIOUS`
for rotation (needs the current one; different from it and from every other secret). Startup fails otherwise.

## Consequences

- Whoever holds the secret can claim any address for the requests it signs. Keep it only on the server-side caller, never in browser code, and
  rotate it with the previous-secret slot (no downtime: add the new one as current, move the old to previous, remove it after a day).
- A leaked secret lets an attacker pick their own address and so escape the per-address limits until it is rotated. Per-account lockout still
  works, and a signature is valid for 60 seconds only, so a captured message cannot be replayed later.
- Replay inside the 60 second window is possible for the same address and timestamp. That gives an attacker nothing beyond the address the
  caller already vouched for.
- The caller must sign for the real visitor. A caller that signs a constant (or its own address) gets option 2 back.
- Behind a load balancer the TCP peer is still the balancer; this feature does not replace `CLIENT_IP_SOURCE`. It overrides the address only
  for requests that carry a valid signature.
