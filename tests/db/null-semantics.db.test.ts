// What does PostgreSQL (through Prisma) do with NULL when a filter says "not equal to X"?
//
// SQL's three-valued logic says `col <> 'x'` is NULL (not true) when col is NULL, so a row
// with a NULL column is EXCLUDED by a "not" filter. This matters here because several
// vehicle columns are nullable foreign keys (row colour, customer, ...) and the code was
// written assuming "everything except X" includes rows with no value.
//
// These tests run against real Postgres and pin down what actually happens, for each form of
// "not" the code uses, so no unit test with a fake database can quietly assume otherwise.

import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { ORG_A, minimalVehicle, seedTwoOrgs } from "./helpers/seed.js";

const prisma = getTestPrisma();
let colourA: string;
let colourB: string;

const serials = async (where: object) =>
  (await prisma.vehicle.findMany({ where: { org_id: ORG_A, ...where }, select: { serial: true }, orderBy: { serialNumber: "asc" } })).map(
    (v) => v.serial
  );

beforeEach(async () => {
  await resetDb(prisma);
  await seedTwoOrgs(prisma);
  colourA = (await prisma.rowColourStatus.create({ data: { org_id: ORG_A, name: "Colour A", colour: "#111111" } })).id;
  colourB = (await prisma.rowColourStatus.create({ data: { org_id: ORG_A, name: "Colour B", colour: "#222222" } })).id;
  await prisma.vehicle.createMany({
    data: [
      minimalVehicle(ORG_A, 1), // FC1: NO colour (NULL)
      minimalVehicle(ORG_A, 2, { rowColourStatusId: colourA }), // FC2
      minimalVehicle(ORG_A, 3, { rowColourStatusId: colourB }), // FC3
    ],
  });
});
afterAll(closeTestPrisma);

describe("scalar `{ not: id }` on a nullable foreign key", () => {
  it("EXCLUDES rows where the column is NULL (SQL three-valued logic)", async () => {
    // FC1 has no colour. It is NOT returned by "colour is not A", though a person would expect it.
    expect(await serials({ rowColourStatusId: { not: colourA } })).toEqual(["FC3"]);
  });

  it("a top-level NOT on the same condition ALSO excludes NULL rows", async () => {
    expect(await serials({ NOT: { rowColourStatusId: colourA } })).toEqual(["FC3"]);
  });

  it("is only correct when NULL is asked for explicitly", async () => {
    expect(await serials({ OR: [{ rowColourStatusId: null }, { rowColourStatusId: { not: colourA } }] })).toEqual(["FC1", "FC3"]);
  });

  it("`{ not: null }` is the safe way to say 'has a value'", async () => {
    expect(await serials({ rowColourStatusId: { not: null } })).toEqual(["FC2", "FC3"]);
  });
});

describe("relation filters inside NOT (the effective-status filters use this)", () => {
  const CANCELLING = ["Colour A"];

  it("a plain relation filter matches only rows that have that related row", async () => {
    expect(await serials({ rowColourStatus: { name: { in: CANCELLING } } })).toEqual(["FC2"]);
  });

  it("NOT of a relation filter: does it keep rows with NO related row?", async () => {
    // "Not cancelled" must include the vehicle that has no row colour at all (FC1) and the
    // one with a non-cancelling colour (FC3). If Postgres dropped FC1 here, every PENDING
    // vehicle without a row colour would vanish from the PENDING filter.
    expect(await serials({ NOT: { rowColourStatus: { name: { in: CANCELLING } } } })).toEqual(["FC1", "FC3"]);
  });

  it("NOT of a compound condition containing a relation filter keeps rows with no related row", async () => {
    // Same shape as CANCELLED_WHERE: (FC or converted) AND not converted-local AND colour in (...)
    const cancelled = {
      OR: [{ serialPrefix: "FC" as const }, { convertedToExport: true }],
      convertedToLocal: false,
      rowColourStatus: { name: { in: CANCELLING } },
    };
    expect(await serials({ NOT: cancelled })).toEqual(["FC1", "FC3"]);
  });
});
