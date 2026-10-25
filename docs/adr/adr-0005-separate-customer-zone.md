# ADR 0005: A separate customer zone

- Status: **Accepted**
- Date: 2026-10-25
- Supersedes the "customer accounts/login are out of scope" rule (CLAUDE.md, ADR 0001).

## Context

Customers need to sign in to a mobile app to see their own vehicles. Customers and staff are rows in the same
`User` table, and a mistake that lets a customer token pass a staff guard (or the reverse) would expose the whole
organisation. Customers are also untrusted strangers by default: anyone can try to register.

## Decision

1. **A different zone, not extra roles.** Customer routes live under `/api/customer/v1`, with their own guard
   (`requireCustomer`), their own secret (`CUSTOMER_JWT_SECRET`), audience (`customer`) and session table
   (`CustomerSession`). Staff tokens now carry `aud: "staff"`. Each guard verifies signature, audience and issuer,
   so a token from one zone cannot pass the other even if a secret leaked into the wrong place. Startup fails if the
   two secrets are equal. If `CUSTOMER_JWT_SECRET` is unset, the customer routes are not mounted at all.
2. **The password is chosen with the code.** Register stores no password. The email code and the password arrive
   together at `verify-email`, so nobody can register someone else's address with a password they know and wait for the
   owner to verify it.
3. **One rule for who may sign in** (`src/lib/customer-access.ts`): customer, not deleted, login enabled, has a
   password, email verified. `CUSTOMER_SELF_SIGNUP` (default true) decides whether register creates accounts and whether
   verifying switches login on; when false, only customers staff created and enabled can get in, setting a password
   through "forgot password".
4. **No enumeration.** Register, resend, forgot, verify, reset and login answer identically for any address, with
   the same bcrypt work or a response-time floor, and per-identifier rate limits that count unknown addresses too.
5. **One-time codes** are 6 digits from `crypto.randomInt`, stored as an HMAC, valid 10 minutes, single use, and every
   check spends one of 5 attempts atomically BEFORE the comparison, so parallel guessing cannot exceed 5.
6. **Sessions** follow the staff design: opaque 30-day refresh tokens stored as sha256, atomic rotation, reuse after a
   10 s grace revokes every session, and a password reset, account deletion or (later) staff disabling login ends
   all sessions.
7. **Deleting an account anonymises** the `User` row (no personal data, email freed), ends sessions and removes codes
   and device tokens. Vehicles and other business records stay.
8. **Email** is a single module over the Resend HTTP API with built-in `fetch`; without a key nothing is sent.

## Consequences

- Staff access tokens issued before this change have no audience and are refused; staff re-login (or refresh) once.
  The CargoDev Next app issues tokens without an audience too: they stop working on this API once it is deployed.
- The `User.password` column holds customer password hashes as well; `country` and `lastActiveAt` already existed.
- Slices 2 to 7 add milestones, files, the customer read API, staff tools, notifications, chat and the public stock API
  on top of this zone.
