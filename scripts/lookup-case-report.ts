// Lookup names that differ only by case or by surrounding whitespace ("Toyota", "toyota", "Toyota "). The database unique key on a lookup
// table is case-sensitive, so such variants can coexist (the app checks case-insensitively, but two requests can race past that check).
// A unique index on (org_id, lower(btrim(name))) would fail to build while any exist. This module finds them, READ ONLY.
//
// Pure functions plus one runner that takes any object with `query(sql)`, so the tests use a fake client. The runner issues SELECTs only
// (the entry script also sets the session read-only). Output is names, row ids and COUNTS of vehicles; no person, no e-mail, no credential.

export interface LookupSpec {
  /** The database table (quoted in SQL). */
  table: string;
  /** A short label for the report. */
  label: string;
  /** An extra column that scopes the unique key (a model is unique per brand, a grade per model). */
  scope?: string;
  /** How a vehicle points at a row of this table: a column on "Vehicle", or a join through the models (a brand has no column of its own). */
  vehicle: { column: string } | { viaModels: true };
}

export const LOOKUP_TABLES: readonly LookupSpec[] = [
  { table: "Brand", label: "brands", vehicle: { viaModels: true } },
  { table: "VehicleModelRef", label: "models", scope: "brand_id", vehicle: { column: "modelId" } },
  { table: "Grade", label: "grades", scope: "model_id", vehicle: { column: "gradeId" } },
  { table: "AuctionHall", label: "auction halls", vehicle: { column: "auctionHallId" } },
  { table: "Supplier", label: "suppliers", vehicle: { column: "supplierId" } },
  { table: "TransportCompany", label: "transport companies", vehicle: { column: "transportById" } },
  { table: "InspectionCompany", label: "inspection companies", vehicle: { column: "inspectionCompanyId" } },
  { table: "InspectionBy", label: "inspectors", vehicle: { column: "inspectionById" } },
  { table: "VehicleLocation", label: "vehicle locations", vehicle: { column: "vehicleLocationId" } },
  { table: "FreightAgent", label: "freight agents", vehicle: { column: "freightAgentId" } },
  { table: "PackingAgent", label: "packing agents", vehicle: { column: "packingAgentId" } },
  { table: "RowColourStatus", label: "row colour statuses", vehicle: { column: "rowColourStatusId" } },
];

/** One SELECT: every row whose (org, scope, lower(btrim(name))) is shared with another row, with its vehicle counts. Nothing is written. */
export function buildDuplicateQuery(spec: LookupSpec): string {
  const scope = spec.scope ? `, t."${spec.scope}"` : "";
  const scopeSelect = spec.scope ? `, t."${spec.scope}" AS scope` : ", NULL::text AS scope";
  const join =
    "viaModels" in spec.vehicle
      ? `LEFT JOIN "VehicleModelRef" m ON m."brand_id" = t."id" LEFT JOIN "Vehicle" v ON v."modelId" = m."id"`
      : `LEFT JOIN "Vehicle" v ON v."${spec.vehicle.column}" = t."id"`;
  return [
    `SELECT t."id" AS id, t."org_id" AS org${scopeSelect}, t."name" AS name, lower(btrim(t."name")) AS key,`,
    `  (count(v."id") FILTER (WHERE v."deletedAt" IS NULL))::int AS active_vehicles, count(v."id")::int AS all_vehicles`,
    `FROM "${spec.table}" t ${join}`,
    `WHERE (t."org_id"${scope}, lower(btrim(t."name"))) IN (`,
    `  SELECT "org_id"${spec.scope ? `, "${spec.scope}"` : ""}, lower(btrim("name")) FROM "${spec.table}" GROUP BY 1, 2${spec.scope ? ", 3" : ""} HAVING count(*) > 1`,
    `)`,
    `GROUP BY t."id"`,
    `ORDER BY t."org_id", lower(btrim(t."name")), t."name", t."id"`,
  ].join("\n");
}

export interface DuplicateRow {
  id: string;
  org: string;
  scope: string | null;
  name: string;
  key: string;
  active_vehicles: number;
  all_vehicles: number;
}

export interface DuplicateGroup {
  org: string;
  scope: string | null;
  key: string;
  variants: Array<{ id: string; name: string; activeVehicles: number; allVehicles: number }>;
}

export function groupRows(rows: readonly DuplicateRow[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const row of rows) {
    const id = `${row.org}\u0000${row.scope ?? ""}\u0000${row.key}`;
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { org: row.org, scope: row.scope, key: row.key, variants: [] }));
    group.variants.push({ id: row.id, name: row.name, activeVehicles: row.active_vehicles, allVehicles: row.all_vehicles });
  }
  // A "group" needs at least two spellings or ids; one row alone is not a duplicate.
  return [...groups.values()].filter((g) => g.variants.length > 1);
}

export interface Queryable {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

export interface LookupCaseResult {
  /** The report, one line per element. */
  lines: string[];
  /** Total number of duplicate groups over every table. */
  groups: number;
  perTable: Array<{ label: string; groups: number }>;
}

/** Runs the check on every lookup table. SELECTs only. */
export async function runLookupCaseCheck(client: Queryable, tables: readonly LookupSpec[] = LOOKUP_TABLES): Promise<LookupCaseResult> {
  const lines: string[] = [];
  const perTable: LookupCaseResult["perTable"] = [];
  let total = 0;
  for (const spec of tables) {
    const result = await client.query(buildDuplicateQuery(spec));
    const groups = groupRows(result.rows as DuplicateRow[]);
    perTable.push({ label: spec.label, groups: groups.length });
    total += groups.length;
    lines.push(`${spec.label}: ${groups.length} group(s) of names that differ only by case or surrounding spaces`);
    for (const group of groups) {
      lines.push(`  organisation ${group.org}${group.scope ? `, ${spec.scope} ${group.scope}` : ""}, name ignoring case and spaces: ${JSON.stringify(group.key)}`);
      for (const variant of group.variants) {
        lines.push(`    ${JSON.stringify(variant.name)}  id ${variant.id}  vehicles: ${variant.activeVehicles} active, ${variant.allVehicles} in total`);
      }
    }
  }
  lines.push("");
  lines.push(
    total === 0
      ? "No duplicates: a unique index on (org_id, lower(btrim(name))) can be built on every lookup table."
      : `${total} group(s) in total: merge them first (docs/lookup-duplicates-merge-plan.md), or the unique index on (org_id, lower(btrim(name))) will fail to build.`
  );
  return { lines, groups: total, perTable };
}
