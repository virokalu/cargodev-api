// Small in-memory stand-in for PrismaClient, for service unit tests. It proves
// service logic (scoping, ownership checks, validation, activity-log writes),
// NOT SQL, constraints or locking: those need a real throwaway Postgres.
// Fake data only. It throws on any `where` shape it does not understand, so a
// test can never pass by silently ignoring a filter.
//
// Known difference from Postgres: a top-level `NOT: {...}` is plain boolean negation here, but
// SQL three-valued logic makes `NOT (col = x)` drop NULL rows for a SCALAR condition. The code only
// uses NOT around relation filters, where Postgres agrees with plain negation (checked in
// tests/db/null-semantics.db.test.ts). Do not rely on the fake for NOT over nullable scalars.

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const OPERATORS = new Set([
  "equals", "in", "notIn", "not", "contains", "startsWith", "endsWith",
  "mode", "gt", "gte", "lt", "lte", "some", "every", "none",
]);

interface Relation {
  model: string;
  /** To-one: field on this row holding the related row's id. To-many: field on the child row holding THIS row's id. */
  fk: string;
  /** A to-many relation (e.g. vehicle.photos). Only selectable, not usable in where/orderBy. */
  many?: boolean;
}

/** Lets `where` and `orderBy` follow to-one relations (e.g. vehicle.model.brand_id). */
interface MatchContext {
  model: string;
  relations: Record<string, Record<string, Relation>>;
  lookup: (model: string, id: unknown) => Row | undefined;
}

export interface FakePrismaOptions {
  /** relations[model][field] -> how to resolve `select: { field: { select } }`. */
  relations?: Record<string, Record<string, Relation>>;
}

function isPlainObject(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function sameValue(a: unknown, b: unknown): boolean {
  // A real database returns null for an unset nullable column.
  if (b === null) return a === null || a === undefined;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function matchesField(actual: unknown, cond: unknown, key: string): boolean {
  if (!isPlainObject(cond)) return sameValue(actual, cond);
  const insensitive = cond["mode"] === "insensitive";
  const norm = (v: unknown) => (insensitive && typeof v === "string" ? v.toLowerCase() : v);
  for (const op of Object.keys(cond)) {
    if (!OPERATORS.has(op)) throw new Error(`fake-prisma: unsupported operator "${op}" on "${key}"`);
    if (op === "some" || op === "every" || op === "none") {
      throw new Error(`fake-prisma: relation filter "${op}" on "${key}" is not supported`);
    }
  }
  if ("equals" in cond && norm(actual) !== norm(cond["equals"])) return false;
  if ("in" in cond && !(cond["in"] as unknown[]).some((v) => sameValue(actual, v))) return false;
  if ("notIn" in cond && (cond["notIn"] as unknown[]).some((v) => sameValue(actual, v))) return false;
  if ("not" in cond) {
    const not = cond["not"];
    // Like Postgres: `col <> x` is not true when col is NULL, so a scalar "not" EXCLUDES NULL rows
    // (verified in tests/db/null-semantics.db.test.ts). `{ not: null }` means "has a value".
    if (not !== null && actual == null) return false;
    if (isPlainObject(not) ? matchesField(actual, not, key) : sameValue(actual, not)) return false;
  }
  if ("contains" in cond) {
    if (typeof actual !== "string") return false;
    if (!String(norm(actual)).includes(String(norm(cond["contains"])))) return false;
  }
  if ("startsWith" in cond && !(typeof actual === "string" && String(norm(actual)).startsWith(String(norm(cond["startsWith"]))))) return false;
  if ("endsWith" in cond && !(typeof actual === "string" && String(norm(actual)).endsWith(String(norm(cond["endsWith"]))))) return false;
  const num = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
  if ("gt" in cond && !(num(actual) > num(cond["gt"]))) return false;
  if ("gte" in cond && !(num(actual) >= num(cond["gte"]))) return false;
  if ("lt" in cond && !(num(actual) < num(cond["lt"]))) return false;
  if ("lte" in cond && !(num(actual) <= num(cond["lte"]))) return false;
  return true;
}

/** Compound unique keys such as { org_id_email: { org_id, email } } are flattened. */
function flatten(where: Where, isRelation: (key: string) => boolean = () => false): Where {
  const out: Where = {};
  for (const [k, v] of Object.entries(where)) {
    if (
      isPlainObject(v) &&
      !isRelation(k) &&
      k !== "AND" && k !== "OR" && k !== "NOT" &&
      !Object.keys(v).some((op) => OPERATORS.has(op))
    ) {
      Object.assign(out, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function matches(row: Row, whereIn: Where | undefined, ctx?: MatchContext): boolean {
  if (!whereIn) return true;
  const relationOf = (key: string) => ctx?.relations[ctx.model]?.[key];
  const where = flatten(whereIn, (key) => relationOf(key) !== undefined);
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "AND") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((w) => matches(row, w as Where, ctx))) return false;
    } else if (key === "OR") {
      if (!(cond as Where[]).some((w) => matches(row, w, ctx))) return false;
    } else if (key === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((w) => matches(row, w as Where, ctx))) return false;
    } else if (ctx && relationOf(key) && isPlainObject(cond)) {
      const rel = relationOf(key)!;
      const related = ctx.lookup(rel.model, row[rel.fk]);
      // A missing related row never satisfies a condition on it.
      if (!related || !matches(related, cond, { ...ctx, model: rel.model })) return false;
    } else if (!matchesField(row[key], cond, key)) {
      return false;
    }
  }
  return true;
}

export interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

/** Object.assign, plus Prisma's { increment } / { decrement } number operations. */
function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value) && ("increment" in value || "decrement" in value)) {
      const current = Number(row[key] ?? 0);
      row[key] = "increment" in value ? current + Number(value["increment"]) : current - Number(value["decrement"]);
    } else {
      row[key] = value;
    }
  }
}

/** Unique indexes the fake enforces for createMany (the real database enforces all of them). */
const UNIQUE_KEYS: Record<string, string[][]> = {
  vehicleMilestone: [["vehicleId", "type"]],
  stockVehicle: [["org_id", "slug"]],
  notificationPreference: [["userId"]],
};

export function createFakePrisma(options: FakePrismaOptions = {}) {
  const tables = new Map<string, Row[]>();
  const calls: RecordedCall[] = [];
  let seq = 0;

  const table = (model: string) => {
    let t = tables.get(model);
    if (!t) tables.set(model, (t = []));
    return t;
  };

  function project(model: string, row: Row, select: Row | undefined): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [field, sel] of Object.entries(select)) {
      if (!sel) continue;
      if (field === "_count") {
        const counts: Row = {};
        for (const name of Object.keys((sel as Row)["select"] as Row)) counts[name] = 0;
        out["_count"] = counts;
      } else if (sel === true) {
        out[field] = row[field] ?? null;
      } else if (isPlainObject(sel)) {
        const rel = options.relations?.[model]?.[field];
        if (!rel) throw new Error(`fake-prisma: no relation configured for ${model}.${field}`);
        if (rel.many) {
          const children = table(rel.model).filter((r) => r[rel.fk] === row["id"]);
          // Newest first when the caller asks for createdAt ordering; otherwise insertion order.
          const order = (sel as Row)["orderBy"] as Row | undefined;
          const ordered = order?.["createdAt"] === "desc" ? [...children].reverse() : children;
          out[field] = ordered.map((c) => project(rel.model, c, sel["select"] as Row | undefined));
          continue;
        }
        const related = table(rel.model).find((r) => r["id"] === row[rel.fk]);
        out[field] = related ? project(rel.model, related, sel["select"] as Row | undefined) : null;
      }
    }
    return out;
  }

  /** Resolves an orderBy entry such as { name: "asc" } or { model: { name: "asc" } } to [value, dir]. */
  function sortValue(model: string, row: Row, spec: Row): [unknown, "asc" | "desc"] {
    const [field, dirOrNested] = Object.entries(spec)[0] as [string, unknown];
    if (typeof dirOrNested === "string") return [row[field], dirOrNested as "asc" | "desc"];
    // { sort: "asc" | "desc", nulls: "first" | "last" }: the null placement is applied by sorted() below.
    if (dirOrNested && typeof dirOrNested === "object" && "sort" in (dirOrNested as Row)) return [row[field], (dirOrNested as { sort: "asc" | "desc" }).sort];
    const rel = options.relations?.[model]?.[field];
    if (!rel) throw new Error(`fake-prisma: no relation configured for orderBy ${model}.${field}`);
    const related = table(rel.model).find((r) => r["id"] === row[rel.fk]);
    return related ? sortValue(rel.model, related, dirOrNested as Row) : [undefined, "asc"];
  }

  function sorted(model: string, rows: Row[], orderBy: unknown): Row[] {
    const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    if (list.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const o of list as Row[]) {
        const norm = (v: unknown) => (v instanceof Date ? v.getTime() : v);
        const [rawA, dir] = sortValue(model, a, o) as [number | string | Date | null | undefined, "asc" | "desc"];
        const [rawB] = sortValue(model, b, o) as [number | string | Date | null | undefined, "asc" | "desc"];
        // Dates compare by time (two equal Dates are different objects), so ties fall through to the next sort key.
        const av = norm(rawA) as number | string | null | undefined;
        const bv = norm(rawB) as number | string | null | undefined;
        if (av === bv) continue;
        // Nulls sort last ascending, first descending (PostgreSQL default) unless the order asks for { nulls }.
        const nulls = (Object.values(o)[0] as { nulls?: "first" | "last" } | undefined)?.nulls;
        if (av == null) return nulls === "last" ? 1 : nulls === "first" ? -1 : dir === "asc" ? 1 : -1;
        if (bv == null) return nulls === "last" ? -1 : nulls === "first" ? 1 : dir === "asc" ? -1 : 1;
        const cmp = av > bv ? 1 : -1;
        return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  const ctxFor = (model: string): MatchContext => ({
    model,
    relations: options.relations ?? {},
    lookup: (m, id) => table(m).find((r) => r["id"] === id),
  });

  function modelApi(model: string) {
    const rec = (method: string, args: unknown) => calls.push({ model, method, args });
    const find = (args: { where?: Where } | undefined) =>
      table(model).filter((r) => matches(r, args?.where, ctxFor(model)));

    return {
      async findFirst(args?: { where?: Where; select?: Row; orderBy?: unknown }) {
        rec("findFirst", args);
        const row = sorted(model, find(args), args?.orderBy)[0];
        return row ? project(model, row, args?.select) : null;
      },
      async findFirstOrThrow(args?: { where?: Where; select?: Row; orderBy?: unknown }) {
        rec("findFirstOrThrow", args);
        const row = sorted(model, find(args), args?.orderBy)[0];
        if (!row) throw new Error(`No ${model} found`);
        return project(model, row, args?.select);
      },
      async findUnique(args: { where: Where; select?: Row }) {
        rec("findUnique", args);
        const row = find(args)[0];
        return row ? project(model, row, args.select) : null;
      },
      async findUniqueOrThrow(args: { where: Where; select?: Row }) {
        rec("findUniqueOrThrow", args);
        const row = find(args)[0];
        if (!row) throw new Error(`No ${model} found`);
        return project(model, row, args.select);
      },
      async findMany(args?: { where?: Where; select?: Row; orderBy?: unknown; take?: number; skip?: number; distinct?: string[] }) {
        rec("findMany", args);
        let rows = sorted(model, find(args), args?.orderBy);
        if (args?.distinct) {
          const seen = new Set<string>();
          rows = rows.filter((r) => {
            const k = JSON.stringify(args.distinct!.map((f) => r[f]));
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        rows = rows.slice(args?.skip ?? 0, args?.take === undefined ? undefined : (args.skip ?? 0) + args.take);
        return rows.map((r) => project(model, r, args?.select));
      },
      async count(args?: { where?: Where }) {
        rec("count", args);
        return find(args).length;
      },
      async groupBy(args: unknown) {
        rec("groupBy", args);
        return [];
      },
      async aggregate(args: unknown) {
        rec("aggregate", args);
        return {};
      },
      async create(args: { data: Row; select?: Row; include?: Row }) {
        rec("create", args);
        const row: Row = { id: `${model}_${++seq}`, createdAt: new Date(), ...args.data };
        table(model).push(row);
        // `include` returns every column plus the named relations.
        if (args.include && !args.select) return { ...row, ...project(model, row, args.include) };
        return project(model, row, args.select);
      },
      async createMany(args: { data: Row[]; skipDuplicates?: boolean }) {
        rec("createMany", args);
        let count = 0;
        for (const data of args.data) {
          const keys = UNIQUE_KEYS[model] ?? [];
          const duplicate = keys.some((fields) => table(model).some((r) => fields.every((f) => r[f] === data[f])));
          if (duplicate) {
            if (args.skipDuplicates) continue;
            throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          }
          table(model).push({ id: `${model}_${++seq}`, createdAt: new Date(), ...data });
          count += 1;
        }
        return { count };
      },
      async createManyAndReturn(args: { data: Row[]; select?: Row }) {
        rec("createManyAndReturn", args);
        return args.data.map((data) => {
          const row: Row = { id: `${model}_${++seq}`, createdAt: new Date(), ...data };
          table(model).push(row);
          return project(model, row, args.select);
        });
      },
      async upsert(args: { where: Where; create: Row; update: Row; select?: Row }) {
        rec("upsert", args);
        const row = find(args)[0];
        if (row) {
          Object.assign(row, args.update);
          return project(model, row, args.select);
        }
        const created: Row = { id: `${model}_${++seq}`, createdAt: new Date(), lastSeenAt: new Date(), ...args.create };
        table(model).push(created);
        return project(model, created, args.select);
      },
      async update(args: { where: Where; data: Row; select?: Row }) {
        rec("update", args);
        const row = find(args)[0];
        if (!row) throw new Error(`Record to update not found (${model}).`);
        applyData(row, args.data);
        return project(model, row, args.select);
      },
      async updateMany(args: { where?: Where; data: Row }) {
        rec("updateMany", args);
        const rows = find(args);
        for (const r of rows) applyData(r, args.data);
        return { count: rows.length };
      },
      async delete(args: { where: Where }) {
        rec("delete", args);
        const t = table(model);
        const i = t.findIndex((r) => matches(r, args.where));
        if (i < 0) throw new Error(`Record to delete not found (${model}).`);
        return t.splice(i, 1)[0];
      },
      async deleteMany(args?: { where?: Where }) {
        rec("deleteMany", args);
        const t = table(model);
        const keep = t.filter((r) => !matches(r, args?.where));
        const count = t.length - keep.length;
        tables.set(model, keep);
        return { count };
      },
    };
  }

  const models = new Map<string, ReturnType<typeof modelApi>>();
  const client = new Proxy(
    {
      async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(client);
      },
      // Row locks (SELECT ... FOR UPDATE) have nothing to do in a single-threaded fake.
      async $queryRaw() {
        return [];
      },
    } as Record<string | symbol, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== "string") return undefined;
        let api = models.get(prop);
        if (!api) models.set(prop, (api = modelApi(prop)));
        return api;
      },
    }
  );

  return {
    /** Pass as `tx` or return from the mocked getPrisma(). */
    client: client as never,
    calls,
    /** Seed rows (stored as given; add org_id etc. yourself). */
    seed(model: string, ...rows: Row[]) {
      for (const r of rows) table(model).push({ createdAt: new Date(), ...r });
    },
    rows(model: string): Row[] {
      return table(model);
    },
  };
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;

/** True if an arg tree contains `org_id: orgId` anywhere. Used by scoping tests. */
export function mentionsOrg(args: unknown, orgId: string): boolean {
  if (Array.isArray(args)) return args.some((a) => mentionsOrg(a, orgId));
  if (isPlainObject(args)) {
    return Object.entries(args).some(([k, v]) => (k === "org_id" && v === orgId) || mentionsOrg(v, orgId));
  }
  return false;
}
