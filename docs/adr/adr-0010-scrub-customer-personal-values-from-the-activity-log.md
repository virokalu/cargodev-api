# ADR 0010: Scrubbing a customer's personal values from the activity log on anonymisation

- Status: **Accepted**
- Date: 2026-11-07
- Related: `docs/privacy-checklist.md` (open question 3), CLAUDE.md rule 4 (every mutation writes an `ActivityLog` row).

## Context

The activity log answers "who did what, and when". It is append-only by design: no route edits or deletes a row.

A staff edit of a customer stores the **values** it changed: `UPDATE_CUSTOMER` keeps the old and new name, e-mail, phone and address, and
`CREATE_CUSTOMER` keeps the new customer's contact details. When a customer is **anonymised** (they delete their own account, or the retention job
removes a sign-up that never verified its e-mail), the user row loses those values, but the log kept them for ever. A person who has asked to be
forgotten was therefore still readable in an administrator's activity-log screen. That is not defensible.

## Options considered

1. **Keep the log untouched** (strict append-only). Strongest audit trail, but retains a deleted person's contact details indefinitely.
2. **Stop storing contact values in new log rows, and leave the old ones.** Fixes the future only.
3. **Delete the customer's log rows.** Loses who-did-what, and the log is also evidence about the staff members' actions.
4. **Replace only the personal fields in that customer's own rows, and record that it happened** (chosen).

## Decision

When a customer is anonymised, **in the same database transaction** as the anonymisation:

- In the `before` and `after` JSON of every log row **about that customer**, replace the five personal fields `name`, `email`, `phone`, `address`
  and `companyName` with the text `[removed]`. "About that customer" is exact: entity `User` (staff edits of the customer) or `Customer` (the
  customer's own actions), `entityId` equal to the customer's id, and the customer's organisation. The fields are found anywhere in the JSON
  (nested objects and arrays too). A field that is empty, or already `[removed]`, is not touched or counted.
- Write **one new summary row per customer**: action `CUSTOMER_ACTIVITY_SCRUBBED`, entity `Customer`, `entityId` the customer, and in `after`
  only the counts `{ rowsScrubbed, fieldsReplaced }`. It is attributed to the customer for their own deletion, and to the organisation's
  administrator (who stands in for the system) for the retention job.
- Touch **nothing else**: not another customer's rows, not another organisation's rows with the same id, not rows of other entities, not any
  field other than the five, not the action, entity, entity id, actor or time of any row. Each write names the organisation, the entity and the
  customer again, so a row that is not about this customer cannot change even if the first read were wrong.
- Both anonymisation paths use the same function (`scrubCustomerActivity` in `src/services/activity-log.service.ts`). A retention **dry run** scrubs
  nothing.

This is a **deliberate exception** to "the activity log is append-only", and it is the only one. It is narrow on purpose: a staff member's edits
of *other* people keep their values, because that is not the data of someone who asked to be forgotten.

## Consequences

- The audit trail still shows that a customer was edited, by whom and when, and that a scrub happened and how big it was. It no longer shows the
  deleted person's name, e-mail, phone, address or company name.
- The scrub is part of the anonymisation transaction: if anything after it fails (for example the final log write), both are rolled back, and
  nothing is half-done (proved on real Postgres: `tests/db/activity-scrub.db.test.ts`).
- Cost: one extra read per anonymisation (paged, 500 rows a page) and one write per row that changes. A retention batch of up to 1000 accounts
  does the read once for all of them.
- The values are **not recoverable** from the log. The backup of the database is the only place they can still exist (the retention of backups is
  covered in `docs/privacy-checklist.md`).
- If a new place stores personal values of a customer in a log row under another entity or another field name, it must be added to the five fields
  or to the entity list here, with a test; otherwise it is not scrubbed.
