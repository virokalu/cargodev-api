# Privacy policy checklist

What the privacy policy and the data handling must cover for the customer app, the staff apps and the public website. Not legal advice: review with whoever writes the policy. Everything below describes what the code does today; nothing here is real data.

## Personal data we hold, and how long (as implemented)

| Data | Where | Why | Kept (as implemented) |
|---|---|---|---|
| Customer name, email, phone, company, country, address, destination port, language and theme | `User` | Run the account and ship vehicles | Until the customer deletes the account (then anonymised, see below). A customer who registered themselves but never verified their email, and owns nothing, is anonymised after `UNVERIFIED_ACCOUNT_DAYS` (14) once `RETENTION_DRY_RUN=false` |
| Last-seen time (presence) | `User.lastActiveAt` | Show staff which customers are online | Overwritten on use (at most one write every few minutes); gone with the account's anonymisation. Only a time, no location |
| Password (bcrypt hash only) | `User` | Sign-in | Until the account is deleted |
| One-time codes (keyed hash only, never the code) | `OtpCode` | Verify email, reset password | Valid 10 minutes; expired rows deleted after `RETENTION_OTP_DAYS` (30) |
| Customer sign-in sessions (token hash, user agent) | `CustomerSession` | Stay signed in | Expired or revoked rows deleted after `RETENTION_SESSION_DAYS` (30) |
| Staff sign-in sessions (token hash, user agent, IP address when the session starts) | `RefreshToken` | Stay signed in | Expired or revoked rows deleted after `RETENTION_SESSION_DAYS` (30) |
| Push device tokens (Expo token, platform, app version, last seen) | `DeviceToken` | Notifications | Until sign-out, until the account is deleted, or until Expo reports the token dead |
| Customer alerts (title and text about a vehicle) | `Notification` | In-app history | **Read** alerts older than `RETENTION_ALERT_DAYS` (180) are deleted; unread alerts are kept; deleted with the account |
| Chat messages and conversations | `Message`, `Conversation` | Support | **No automatic deletion. Open question 1.** Deleted when the customer deletes their account |
| Website enquiries (name, email, phone, message) | `Enquiry` | Reply to the enquiry | **No automatic deletion. Open question 1.** Not linked to an account, so not removed when an account is deleted |
| Staff name, email, phone, role | `User` | Run the business | While the account exists; staff are deactivated, not erased (**open question 4**) |
| Documents and photos about the customers' vehicles | R2 (private bucket) | Service | While the vehicle record exists. Customers reach them only through the API |
| Activity log (who did what, when) | `ActivityLog` | Audit | Kept. **It is not free of personal values**: a staff edit of a customer stores the before and after name, email, phone and address; vehicle edits store the vehicle row. **Open question 3** |
| Retention summary rows (counts only) | `ActivityLog` | Show what the clean-up removed | Kept |

Logs (server output) never contain passwords, codes, tokens, message bodies or full email addresses; request lines carry only the method, the route pattern, the status, the duration and the request id (enforced by tests).

## What happens when a customer deletes their account

In one transaction: the row is anonymised (name replaced, email, phone, address, company, country, destination port, language, theme and password removed, sign-in switched off, marked deleted), all sessions are revoked, one-time codes, device tokens, chat (messages and conversations), alerts and notification settings are deleted. **Kept**: the vehicle records and other business records that pointed at the customer (now pointing at an anonymous row), the activity log (see above), and any website enquiry the person sent under the same email (not linked to the account).

## The daily clean-up (retention)

Runs inside the daily job; **a dry run until `RETENTION_DRY_RUN=false`** (the default, in every environment): it logs one line of counts and removes nothing. It never touches chats or enquiries. Details: `docs/architecture.md`, `docs/env.md`.

## Open questions for FTJ (decisions the business must make)

1. **How long are chats and website enquiries kept?** Today: forever (chats until the customer deletes their account; enquiries forever). Suggested starting point to confirm or change: chats 2 years after the last message, enquiries 1 year after being marked handled. Whatever is decided gets implemented in the daily job and written in the policy.
2. **Who may see a customer's contact details (email, phone, address)?** Today: administrators, managers and operators see them; a read-only viewer does not (list, search and reports leave them out). Operators in chat only reach customers assigned to them. Confirm that this is the intended rule.
3. **Should the activity log keep personal values?** Today a customer edit stores the old and new email, phone and address, and these stay after the customer deletes their account. Options: keep as is and say so in the policy, remove personal values from new entries, or erase them when the account is deleted.
4. **What happens to a staff member's personal data when they leave?** Today the account is deactivated and the name, email and phone stay (the audit trail points at it).
5. **Backups.** How long the database host keeps backups decides how long "deleted" data still exists. Needs the host's setting and a sentence in the policy.

## Checklist for the policy

- [ ] The policy names the controller and a contact for privacy requests.
- [ ] It lists the data above and the purpose of each, including the last-seen time and the device tokens.
- [ ] Retention periods for chat and enquiries are decided (open question 1), written down, then implemented (today there is no automatic deletion for them).
- [ ] The retention periods in the table above are stated, and the dry-run switch is turned off on purpose once the logged counts look right.
- [ ] Account deletion is described as above: personal data removed, business records stay, the activity log stays.
- [ ] Who can see customers' contact details is stated (open question 2).
- [ ] Processors are listed: the database host, Cloudflare (R2 storage), the email provider (Resend), Expo (push notifications). WhatsApp is not used, and there is no phone verification.
- [ ] International transfers are covered for those processors.
- [ ] Customers can ask for access, correction and deletion, and there is a person who handles it.
- [ ] The public website enquiry form states what happens to the message and links the policy; anti-spam checks do not collect more than needed.
- [ ] Cookies or similar on the website are covered (the API itself sets none).
- [ ] Logs never contain passwords, codes, tokens, message bodies or full email addresses (enforced by tests; mention in the security section).
