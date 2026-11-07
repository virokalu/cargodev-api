# Merging lookup names that differ only by case

Why: the unique key on a lookup table (`(org_id, name)`, models per brand, grades per model) is **case-sensitive**. The app compares names without regard to case when it creates or renames a row, but two requests at the same moment can both pass that check, so "Toyota" and "toyota" (or "Toyota ") can exist side by side. The prepared migration `prisma/pending-migrations/20261105130000_lookup_name_case_insensitive_unique` builds a unique index on `(org_id, lower(btrim(name)))` for every lookup table. **That index cannot be built while such pairs exist**, so they have to be merged first. Nothing in this document is run by the API or by a script: it is a plan for the maintainer.

## 1. Find them (read only, safe on any database)

```powershell
$env:MIGRATION_DATABASE_URL = "<the target's direct connection string, from your password manager>"
npm run check:lookup-case
```

It opens a **read-only** session, prints the target as `host:port/database` (never the URL or a password), and for each of the 12 lookup tables the groups of names that differ only by case or surrounding spaces, with every spelling, its row id, and how many vehicles point at it (active and in total). Exit code `0` = nothing to merge, `2` = duplicates found, `1` = it could not run.

## 2. Decide the survivor of each group

For each group pick **one row to keep**. Usually the spelling the business wants shown, or the one with the most vehicles. Write down: the group, the row to keep (id), the rows to merge away (ids).

- **Models and grades** are scoped: a model is a duplicate only inside one brand, a grade only inside one model. The same name under two brands is correct and is not reported.
- **Brands** have no column on the vehicle: a brand is used through its models. Merging two brands means moving the models of the loser to the survivor, and **a model of the same name may then exist twice under the survivor** (a model duplicate); merge those models first (then their grades), then the brands. The order is: **grades, then models, then brands**.

## 3. Repoint, then remove (per group, in one transaction, on a copy first)

Take a **backup first** and rehearse on a copy of the database. Replace `<keep>` and `<lose>` with the ids from step 2. These are examples for the maintainer to run by hand; they are not part of the migration, and they change data.

```sql
BEGIN;
-- 1. every vehicle that points at the row to remove points at the survivor instead
UPDATE "Vehicle" SET "auctionHallId" = '<keep>' WHERE "auctionHallId" = '<lose>';   -- the column of the table being merged
-- 2. the row to remove no longer has any reference: check it, then delete it
SELECT count(*) FROM "Vehicle" WHERE "auctionHallId" = '<lose>';                    -- must be 0
DELETE FROM "AuctionHall" WHERE id = '<lose>';
COMMIT;
```

The column per table: halls `auctionHallId`, suppliers `supplierId`, transport companies `transportById`, inspection companies `inspectionCompanyId`, inspectors `inspectionById`, vehicle locations `vehicleLocationId`, freight agents `freightAgentId`, packing agents `packingAgentId`, row colour statuses `rowColourStatusId`, grades `gradeId`, models `modelId`.

Things that need care:

- **Freight agents** carry `offersRoro` / `offersContainer`. Keep the union: if either spelling offers RORO or Container, the survivor must too, or a vehicle can end up with an agent that no longer offers its shipping method.
- **Models:** move the grades of the losing model to the survivor first (`UPDATE "Grade" SET model_id = '<keep>' WHERE model_id = '<lose>'`), and merge any grade that now duplicates one of the survivor's.
- **Brands:** `UPDATE "VehicleModelRef" SET brand_id = '<keep>' WHERE brand_id = '<lose>'` only after the models are merged, then delete the loser brand.
- **Row colour statuses** drive the cancelled rule by **name** (`Unit Canceled`, `Resold in Auction`). Keep the spelling the code matches.
- **Deleted vehicles** also point at lookup rows; the `UPDATE` above includes them (it has no `deletedAt` condition), which is what you want, or the delete fails on the foreign key.
- **The activity log** keeps the names it saw at the time and is not changed.
- If you would rather **rename** than merge (two rows that really are different, for example "Honda" and "honda " as different suppliers by mistake), rename one to a distinct name instead (a rename also takes effect for the case-insensitive rule once the index exists).

## 4. Check, then build the index

1. Run `npm run check:lookup-case` again: it must exit `0`.
2. Enable the migration like any other (a reviewed change; the scan is clean: only `CREATE UNIQUE INDEX`): move `prisma/pending-migrations/20261105130000_lookup_name_case_insensitive_unique` into `prisma/migrations`, run the test suites, and run `deploy` only with the maintainer's approval for that run (`docs/runbook.md`, "Run a migration").
3. The old case-sensitive unique indexes are **not removed** by it; they stay.

## 5. After it is in place

A concurrent create or rename that differs only by case now fails at the database. The services map that violation to `409 CONFLICT` with `fieldErrors.name` (already done for the existing key), so users see a normal message instead of a duplicate. Add a regression test for the case-insensitive key in `tests/db/unique-violation.db.test.ts` when the migration is enabled (the prepared test `tests/db/lookup-case-index.db.test.ts` already proves that the SQL builds on clean data and fails on duplicates).
