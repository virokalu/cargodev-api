# Privacy policy checklist

What the privacy policy and the data handling must cover for the customer app and the public website. Not legal advice: review with whoever writes the policy.

## Personal data we hold

| Data | Where | Why | Kept |
|---|---|---|---|
| Customer name, email, phone, company, country, destination port | `User` | Run the account and ship vehicles | Until the account is deleted (then anonymised) |
| Password (bcrypt hash only), one-time codes (HMAC only) | `User`, `OtpCode` | Sign-in | Hash until deletion; codes expire in 10 minutes |
| Sessions (token hash, user agent) | `CustomerSession` | Stay signed in | Until expiry or sign-out |
| Push device tokens | `DeviceToken` | Notifications | Until sign-out or deletion |
| Chat messages | `Message` | Support | **Retention to be decided** |
| Website enquiries (name, email, phone, message) | `Enquiry` | Reply to the enquiry | **Retention to be decided** |
| Documents and photos about the customer's vehicles | R2 | Service | While the vehicle record exists |
| Activity log (who did what; no personal values) | `ActivityLog` | Audit | Kept |

## Checklist

- [ ] The policy names the controller and a contact for privacy requests.
- [ ] It lists the data above and the purpose of each.
- [ ] Retention periods for chat and enquiries are decided and written down (then implemented; today there is no automatic deletion).
- [ ] Account deletion is described: personal data is removed, vehicle and business records stay, sessions and device tokens are removed.
- [ ] Processors are listed: the database host, Cloudflare (R2 storage), the email provider (Resend), Expo (push notifications). WhatsApp is not used.
- [ ] International transfers are covered for those processors.
- [ ] Customers can ask for access, correction and deletion, and there is a person who handles it.
- [ ] The public website enquiry form states what happens to the message and links the policy; anti-spam checks do not collect more than needed.
- [ ] Cookies or similar on the website are covered (the API itself sets none).
- [ ] Logs never contain passwords, codes, tokens, message bodies or full email addresses (enforced by tests; mention in the security section).
