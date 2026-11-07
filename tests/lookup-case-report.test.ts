// scripts/check-lookup-case-duplicates.ts (npm run check:lookup-case): the read-only check for lookup names that differ only by case or by
// surrounding spaces. Tested with a FAKE client; the maintainer runs the real one. Fake data only.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOOKUP_TABLES, buildDuplicateQuery, groupRows, runLookupCaseCheck, type DuplicateRow, type Queryable } from "../scripts/lookup-case-report.js";

const SCHEMA = readFileSync("prisma/schema.prisma", "utf8");
const ENTRY = readFileSync("scripts/check-lookup-case-duplicates.ts", "utf8");

function modelBlock(name: string): string {
  const m = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(SCHEMA);
  if (!m) throw new Error(`no model ${name}`);
  return m[1]!;
}

const row = (over: Partial<DuplicateRow>): DuplicateRow => ({ id: "id_1", org: "org_a", scope: null, name: "Toyota", key: "toyota", active_vehicles: 0, all_vehicles: 0, ...over });

/** A fake client: answers every query with the rows prepared for its table (found by the table name in the SQL) and records the SQL. */
function fakeClient(byTable: Record<string, DuplicateRow[]> = {}): Queryable & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query(text: string) {
      sql.push(text);
      const table = /FROM "([A-Za-z]+)" t /.exec(text)?.[1] ?? "";
      return { rows: byTable[table] ?? [] };
    },
  };
}

describe("which tables are checked", () => {
  it("every lookup table of the schema (the ones with a unique name per organisation) is in the list, and nothing else", () => {
    const fromSchema = [...SCHEMA.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter((m) => /@@unique\(\[org_id(, (brand_id|model_id))?, name\]\)/.test(m[2]!))
      .map((m) => m[1]!)
      .sort();
    expect(LOOKUP_TABLES.map((t) => t.table).sort()).toEqual(fromSchema);
    expect(fromSchema.length).toBe(12);
  });

  it("each table's scope column and the vehicle column it points through exist in the schema", () => {
    for (const spec of LOOKUP_TABLES) {
      if (spec.scope) expect(modelBlock(spec.table), `${spec.table}.${spec.scope}`).toMatch(new RegExp(`^\\s+${spec.scope}\\s`, "m"));
      if ("column" in spec.vehicle) expect(modelBlock("Vehicle"), `Vehicle.${spec.vehicle.column}`).toMatch(new RegExp(`^\\s+${spec.vehicle.column}\\s`, "m"));
    }
  });

  it("the scope of the existing unique key is the scope of the check (a model is unique per brand, a grade per model)", () => {
    expect(LOOKUP_TABLES.find((t) => t.table === "VehicleModelRef")?.scope).toBe("brand_id");
    expect(LOOKUP_TABLES.find((t) => t.table === "Grade")?.scope).toBe("model_id");
    expect(LOOKUP_TABLES.filter((t) => t.scope).map((t) => t.table).sort()).toEqual(["Grade", "VehicleModelRef"]);
  });
});

describe("the SQL is read only", () => {
  it("every statement is one SELECT with lower(btrim(name)), and no write or schema keyword appears", () => {
    for (const spec of LOOKUP_TABLES) {
      const sql = buildDuplicateQuery(spec);
      expect(sql.trim()).toMatch(/^SELECT /);
      expect(sql).toContain("lower(btrim(");
      expect(sql, spec.table).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|COPY|CALL|DO|MERGE)\b/i);
      expect(sql.includes(";")).toBe(false);
    }
  });

  it("brands are counted through their models; every other table through its own vehicle column", () => {
    expect(buildDuplicateQuery(LOOKUP_TABLES.find((t) => t.table === "Brand")!)).toContain('"VehicleModelRef" m ON m."brand_id" = t."id"');
    expect(buildDuplicateQuery(LOOKUP_TABLES.find((t) => t.table === "AuctionHall")!)).toContain('v."auctionHallId" = t."id"');
    expect(buildDuplicateQuery(LOOKUP_TABLES.find((t) => t.table === "Grade")!)).toContain('v."gradeId" = t."id"');
  });

  it("counts are counts: no vehicle column other than its id is selected, and the report never reads a person", () => {
    for (const spec of LOOKUP_TABLES) {
      const sql = buildDuplicateQuery(spec);
      expect(sql).not.toMatch(/email|phone|password|customer|User/i);
      expect(sql).toContain('count(v."id")');
    }
  });
});

describe("grouping", () => {
  it("rows that share (organisation, scope, name ignoring case and spaces) form a group; a lone row does not", () => {
    const groups = groupRows([
      row({ id: "1", name: "Toyota", key: "toyota", active_vehicles: 5, all_vehicles: 6 }),
      row({ id: "2", name: "toyota ", key: "toyota", active_vehicles: 1, all_vehicles: 1 }),
      row({ id: "3", name: "Honda", key: "honda" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.variants.map((v) => [v.id, v.name, v.activeVehicles, v.allVehicles])).toEqual([["1", "Toyota", 5, 6], ["2", "toyota ", 1, 1]]);
  });

  it("the same name in two organisations is NOT a duplicate", () => {
    expect(groupRows([row({ id: "1", org: "org_a" }), row({ id: "2", org: "org_b" })])).toEqual([]);
  });

  it("the same model name under two brands is NOT a duplicate; under one brand it is", () => {
    expect(groupRows([row({ id: "1", scope: "brand_1", name: "Corolla", key: "corolla" }), row({ id: "2", scope: "brand_2", name: "Corolla", key: "corolla" })])).toEqual([]);
    expect(groupRows([row({ id: "1", scope: "brand_1", name: "Corolla", key: "corolla" }), row({ id: "2", scope: "brand_1", name: "COROLLA", key: "corolla" })])).toHaveLength(1);
  });

  it("several groups are kept apart", () => {
    const groups = groupRows([
      row({ id: "1", key: "a", name: "A" }), row({ id: "2", key: "a", name: "a" }),
      row({ id: "3", key: "b", name: "B" }), row({ id: "4", key: "b", name: " B" }), row({ id: "5", key: "b", name: "b" }),
    ]);
    expect(groups.map((g) => g.variants.length)).toEqual([2, 3]);
  });
});

describe("the report", () => {
  it("with nothing found: every table is listed with 0 groups, the summary says an index can be built, and every table was queried once", async () => {
    const client = fakeClient();
    const result = await runLookupCaseCheck(client);
    expect(result.groups).toBe(0);
    expect(client.sql).toHaveLength(LOOKUP_TABLES.length);
    expect(result.perTable.map((t) => t.label)).toEqual(LOOKUP_TABLES.map((t) => t.label));
    expect(result.lines.filter((l) => /: 0 group\(s\)/.test(l))).toHaveLength(LOOKUP_TABLES.length);
    expect(result.lines.at(-1)).toMatch(/No duplicates/);
  });

  it("with duplicates: the group, the spellings, the ids and the vehicle counts are printed, and the summary points to the merge plan", async () => {
    const client = fakeClient({
      Brand: [row({ id: "brand_1", name: "Toyota", key: "toyota", active_vehicles: 40, all_vehicles: 44 }), row({ id: "brand_2", name: "toyota ", key: "toyota", active_vehicles: 2, all_vehicles: 2 })],
      Grade: [row({ id: "g1", scope: "model_9", name: "Base", key: "base" }), row({ id: "g2", scope: "model_9", name: "BASE", key: "base", all_vehicles: 3, active_vehicles: 3 })],
    });
    const result = await runLookupCaseCheck(client);
    expect(result.groups).toBe(2);
    expect(result.perTable.filter((t) => t.groups > 0).map((t) => [t.label, t.groups])).toEqual([["brands", 1], ["grades", 1]]);
    const text = result.lines.join("\n");
    expect(text).toContain('"Toyota"  id brand_1  vehicles: 40 active, 44 in total');
    expect(text).toContain('"toyota "  id brand_2  vehicles: 2 active, 2 in total');
    expect(text).toContain("model_id model_9");
    expect(text).toContain("docs/lookup-duplicates-merge-plan.md");
    expect(result.lines.at(-1)).toMatch(/2 group\(s\) in total/);
  });

  it("names are quoted with their spaces visible, so a trailing space can be seen", async () => {
    const result = await runLookupCaseCheck(fakeClient({ Brand: [row({ id: "1", name: "Toyota", key: "toyota" }), row({ id: "2", name: "Toyota ", key: "toyota" })] }));
    expect(result.lines.join("\n")).toContain('"Toyota "');
  });
});

describe("the entry script", () => {
  it("reads MIGRATION_DATABASE_URL only, runs in a READ ONLY session, and prints neither the URL nor a password", () => {
    expect(ENTRY).toMatch(/process\.env\["MIGRATION_DATABASE_URL"\]/);
    expect(ENTRY).not.toMatch(/process\.env\["(DATABASE_URL|DIRECT_URL)"\]/);
    expect(ENTRY).toContain("SET default_transaction_read_only = on");
    expect(ENTRY).toContain("BEGIN READ ONLY");
    expect(ENTRY).toContain("redactConnectionStrings");
    // nothing prints the raw URL or the whole target object
    expect(ENTRY).not.toMatch(/console\.(log|error)\([^)]*\burl\b[^)]*\)/);
    expect(ENTRY).not.toMatch(/console\.(log|error)\([^)]*target\.url/);
    expect(ENTRY).not.toMatch(/console\.(log|error)\(target\)/);
    expect(ENTRY).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/);
  });

  it("is wired as npm run check:lookup-case, and exits 0 / 2 / 1 as documented", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:lookup-case"]).toContain("scripts/check-lookup-case-duplicates.ts");
    expect(ENTRY).toContain("result.groups === 0 ? 0 : 2");
  });
});
