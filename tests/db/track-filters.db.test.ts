// G2 and G3 on REAL Postgres (the in-memory fake refuses relation filters, so it cannot prove them): the optional `track=FC|FL` on the
// filter-bar endpoints returns only values used by non-deleted vehicles of that EFFECTIVE track in the caller's organisation, and
// GET /vehicles/partner-names. Converted vehicles land on the track they behave as, not on their serial prefix. Fake data only.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { buildApp } from "../../src/app.js";
import { signAccessToken } from "../../src/lib/mobile-jwt.js";
import { clearStaffAuthCache } from "../../src/services/staff-auth-state.service.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const prisma = getTestPrisma();
const A = "org_test_a";
const B = "org_test_b";
type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const ROLES: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];

// Each tag is one value of every lookup. Who uses it:
//   fc    one native FC vehicle                 fl    one native FL vehicle
//   both  one FC and one FL vehicle             cexp  an FL-rooted vehicle converted to export (behaves as FC)
//   cloc  an FC-rooted vehicle converted to local (behaves as FL)
//   del   a DELETED FC vehicle only             unused  no vehicle        orgb  another organisation's vehicle
const TAGS = ["both", "cexp", "cloc", "del", "fc", "fl", "unused", "orgb"] as const;
type Tag = (typeof TAGS)[number];
const ORG_OF = (tag: Tag) => (tag === "orgb" ? B : A);
const IN_A: Tag[] = ["both", "cexp", "cloc", "del", "fc", "fl", "unused"];
const USED_FC: Tag[] = ["both", "cexp", "fc"];
const USED_FL: Tag[] = ["both", "cloc", "fl"];
const id = (kind: string, tag: Tag) => `${kind}_${tag}`;
const nameOf = (kind: string, tag: Tag) => `${kind}-${tag}`;

const VEHICLES: Array<{ id: string; tag: Tag; prefix: "FC" | "FL"; number: number; extra?: Record<string, unknown> }> = [
  { id: "v_fc", tag: "fc", prefix: "FC", number: 1 },
  { id: "v_fc2", tag: "both", prefix: "FC", number: 2 },
  { id: "v_fl", tag: "fl", prefix: "FL", number: 1 },
  { id: "v_fl2", tag: "both", prefix: "FL", number: 2 },
  { id: "v_cexp", tag: "cexp", prefix: "FL", number: 3, extra: { convertedToExport: true } },
  { id: "v_cloc", tag: "cloc", prefix: "FC", number: 3, extra: { convertedToLocal: true } },
  { id: "v_del", tag: "del", prefix: "FC", number: 4, extra: { deletedAt: new Date("2026-10-01T00:00:00Z") } },
  { id: "v_b", tag: "orgb", prefix: "FC", number: 1 },
];

// kind -> the vehicle column that points at it
const SIMPLE: Array<{ path: string; kind: string; column: string; table: string }> = [
  { path: "auction-halls", kind: "hall", column: "auctionHallId", table: "auctionHall" },
  { path: "suppliers", kind: "supplier", column: "supplierId", table: "supplier" },
  { path: "transport-companies", kind: "transport", column: "transportById", table: "transportCompany" },
  { path: "packing-agents", kind: "packing", column: "packingAgentId", table: "packingAgent" },
  { path: "vehicle-locations", kind: "location", column: "vehicleLocationId", table: "vehicleLocation" },
  { path: "inspection-companies", kind: "inspco", column: "inspectionCompanyId", table: "inspectionCompany" },
  { path: "inspection-by", kind: "inspby", column: "inspectionById", table: "inspectionBy" },
];

let app: Awaited<ReturnType<typeof buildApp>>;
const tokenOf = (role: Role, org = A) => signAccessToken({ sub: `${org === A ? "a" : "b"}_${role}`, orgId: org, role, name: role, email: null });

async function get(url: string, role: Role | null = "MANAGER", org = A) {
  const res = await app.inject({ method: "GET", url, ...(role ? { headers: { authorization: `Bearer ${await tokenOf(role, org)}` } } : {}) });
  return { status: res.statusCode, body: res.json() as { data?: unknown; error?: { code: string; fieldErrors?: Record<string, string> } } };
}
const names = (reply: { data?: unknown } | { body: { data?: unknown } }) => {
  const body = "body" in reply ? reply.body : reply; // a whole reply from get(), or just its body
  return (body.data as Array<{ name?: string }>).map((r) => r.name);
};
const expectedNames = (kind: string, tags: Tag[]) => tags.map((t) => nameOf(kind, t)).sort();

async function seed() {
  await resetDb(prisma);
  clearStaffAuthCache();
  app = app ?? (await buildApp({ rateLimit: false, publicStockEnabled: true }));
  for (const org of [A, B]) await prisma.organization.create({ data: { id: org, name: org } });
  await prisma.user.createMany({
    data: [
      ...ROLES.map((role) => ({ id: `a_${role}`, org_id: A, userType: "STAFF" as const, name: role, role, loginEnabled: true, email: `${role.toLowerCase()}@example.test` })),
      ...ROLES.map((role) => ({ id: `b_${role}`, org_id: B, userType: "STAFF" as const, name: role, role, loginEnabled: true, email: `b.${role.toLowerCase()}@example.test` })),
    ],
  });

  for (const tag of TAGS) {
    const org_id = ORG_OF(tag);
    await prisma.brand.create({ data: { id: id("brand", tag), org_id, name: nameOf("brand", tag) } });
    await prisma.vehicleModelRef.create({ data: { id: id("model", tag), org_id, brand_id: id("brand", tag), name: nameOf("model", tag) } });
    await prisma.grade.create({ data: { id: id("grade", tag), org_id, model_id: id("model", tag), name: nameOf("grade", tag) } });
    for (const s of SIMPLE) await (prisma as never as Record<string, { create: (a: unknown) => Promise<unknown> }>)[s.table]!.create({ data: { id: id(s.kind, tag), org_id, name: nameOf(s.kind, tag) } });
    await prisma.freightAgent.create({ data: { id: id("agent", tag), org_id, name: nameOf("agent", tag), offersRoro: true, offersContainer: tag !== "fl" } });
    await prisma.rowColourStatus.create({ data: { id: id("colour", tag), org_id, name: nameOf("colour", tag), colour: "#112233", transportCellOnly: false } });
    await prisma.user.create({ data: { id: id("cust", tag), org_id, userType: "CUSTOMER", name: nameOf("customer", tag), email: `${tag}@customers.example.test` } });
  }

  for (const v of VEHICLES) {
    const tag = v.tag;
    await prisma.vehicle.create({
      data: {
        id: v.id, org_id: ORG_OF(tag), serialPrefix: v.prefix, serialNumber: v.number, serial: `${v.prefix}${v.number}`,
        modelId: id("model", tag), gradeId: id("grade", tag),
        auctionHallId: id("hall", tag), supplierId: id("supplier", tag), transportById: id("transport", tag), packingAgentId: id("packing", tag),
        vehicleLocationId: id("location", tag), inspectionCompanyId: id("inspco", tag), inspectionById: id("inspby", tag),
        freightAgentId: id("agent", tag), rowColourStatusId: id("colour", tag), customerId: id("cust", tag), destination: nameOf("dest", tag),
        ...v.extra,
      },
    });
  }
}
afterAll(async () => {
  await app?.close();
  await closeTestPrisma();
});

const ENDPOINTS: Array<{ url: (track?: string) => string; kind: string; keys: string[]; tag?: (t: Tag) => string }> = [
  ...SIMPLE.map((s) => ({ url: (t?: string) => `/api/v1/lookups/${s.path}${t === undefined ? "" : `?track=${t}`}`, kind: s.kind, keys: ["id", "name"] })),
  { url: (t) => `/api/v1/lookups/brands${t === undefined ? "" : `?track=${t}`}`, kind: "brand", keys: ["id", "name"] },
  { url: (t) => `/api/v1/lookups/freight-agents${t === undefined ? "" : `?track=${t}`}`, kind: "agent", keys: ["id", "name", "offersContainer", "offersRoro"] },
  { url: (t) => `/api/v1/lookups/freight-agents/search${t === undefined ? "" : `?track=${t}`}`, kind: "agent", keys: ["id", "name", "offersContainer", "offersRoro"] },
  { url: (t) => `/api/v1/lookups/row-colour-statuses${t === undefined ? "" : `?track=${t}`}`, kind: "colour", keys: ["colour", "id", "name", "transportCellOnly"] },
  { url: (t) => `/api/v1/customers/search${t === undefined ? "" : `?track=${t}`}`, kind: "customer", keys: ["id", "name"] },
];

describe.each(ENDPOINTS.map((e) => [e.url().replace("/api/v1", ""), e] as const))("track on %s", (_label, e) => {
  beforeAll(seed); // read-only below: seeded once per endpoint group
  it("without track: every row of the organisation, nothing of the other one, same keys as before", async () => {
    const res = await get(e.url());
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(expectedNames(e.kind, IN_A));
    for (const row of res.body.data as object[]) expect(Object.keys(row).sort()).toEqual(e.keys);
  });

  it("track=FC: only values used by non-deleted vehicles that behave as FC (a converted FL vehicle counts, a converted FC one does not)", async () => {
    const res = await get(e.url("FC"));
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(expectedNames(e.kind, USED_FC));
    for (const row of res.body.data as object[]) expect(Object.keys(row).sort()).toEqual(e.keys);
  });

  it("track=FL: only values used by non-deleted vehicles that behave as FL", async () => {
    const res = await get(e.url("FL"));
    expect(names(res.body)).toEqual(expectedNames(e.kind, USED_FL));
  });

  it("never shows another organisation's values; the other organisation sees only its own", async () => {
    for (const track of ["FC", "FL"]) expect(names(await get(e.url(track))).map(String).join()).not.toContain("orgb");
    expect(names(await get(e.url("FC"), "MANAGER", B))).toEqual([nameOf(e.kind, "orgb")]);
    expect(names(await get(e.url("FL"), "MANAGER", B))).toEqual([]);
  });

  it("every staff role may read it, and no token is 401", async () => {
    for (const role of ROLES) expect((await get(e.url("FC"), role)).status, role).toBe(200);
    expect((await get(e.url("FC"), null)).status).toBe(401);
  });

  it("an invalid track is 400 VALIDATION with fieldErrors.track: ALL, lower case, empty, anything else", async () => {
    for (const bad of ["ALL", "fc", "fl", "", "XX", "FC,FL", "FC%20"]) {
      const res = await get(e.url(bad));
      expect([bad, res.status, res.body.error?.code, Object.keys(res.body.error?.fieldErrors ?? {})]).toEqual([bad, 400, "VALIDATION", ["track"]]);
    }
  });

});

describe("an empty result is an empty array (reseeded for each endpoint)", () => {
  beforeEach(seed);
  it.each(ENDPOINTS.map((e) => [e.url().replace("/api/v1", ""), e] as const))("%s", async (_label, e) => {
    await prisma.vehicle.updateMany({ where: { org_id: A }, data: { deletedAt: new Date() } });
    const res = await get(e.url("FC"));
    expect([res.status, res.body.data]).toEqual([200, []]);
  });
});

describe("models and grades keep their required parent and use the track", () => {
  beforeAll(seed);
  it("models: brandId is still required (400), and the track narrows within the brand", async () => {
    expect((await get("/api/v1/lookups/models?track=FC")).status).toBe(400);
    for (const tag of IN_A) {
      const inFc = (await get(`/api/v1/lookups/models?brandId=${id("brand", tag)}&track=FC`)).body;
      const inFl = (await get(`/api/v1/lookups/models?brandId=${id("brand", tag)}&track=FL`)).body;
      const all = (await get(`/api/v1/lookups/models?brandId=${id("brand", tag)}`)).body;
      expect([tag, names(inFc)]).toEqual([tag, USED_FC.includes(tag) ? [nameOf("model", tag)] : []]);
      expect([tag, names(inFl)]).toEqual([tag, USED_FL.includes(tag) ? [nameOf("model", tag)] : []]);
      expect(names(all)).toEqual([nameOf("model", tag)]);
    }
    expect((await get(`/api/v1/lookups/models?brandId=${id("brand", "orgb")}&track=FC`)).body.data).toEqual([]); // another org's brand
    expect((await get("/api/v1/lookups/models?brandId=brand_fc&track=ALL")).status).toBe(400);
  });

  it("grades: modelId is still required (400), and the track narrows within the model", async () => {
    expect((await get("/api/v1/lookups/grades?track=FL")).status).toBe(400);
    for (const tag of IN_A) {
      const inFc = (await get(`/api/v1/lookups/grades?modelId=${id("model", tag)}&track=FC`)).body;
      const inFl = (await get(`/api/v1/lookups/grades?modelId=${id("model", tag)}&track=FL`)).body;
      expect([tag, names(inFc)]).toEqual([tag, USED_FC.includes(tag) ? [nameOf("grade", tag)] : []]);
      expect([tag, names(inFl)]).toEqual([tag, USED_FL.includes(tag) ? [nameOf("grade", tag)] : []]);
    }
    expect((await get("/api/v1/lookups/grades?modelId=model_fc&track=fc")).status).toBe(400);
  });

});

describe("the limit of 20 matches stays with a track", () => {
  beforeEach(seed);
  it("20 of 25", async () => {
    for (let n = 0; n < 25; n += 1) {
      const hall = `bulk_hall_${String(n).padStart(2, "0")}`;
      await prisma.auctionHall.create({ data: { id: hall, org_id: A, name: `Bulk ${String(n).padStart(2, "0")}` } });
      await prisma.vehicle.create({ data: { id: `bulk_${n}`, org_id: A, serialPrefix: "FC", serialNumber: 100 + n, serial: `FC${100 + n}`, auctionHallId: hall } });
    }
    const res = await get("/api/v1/lookups/auction-halls?q=Bulk&track=FC");
    expect(names(res.body)).toHaveLength(20);
    expect(names(res.body)).toEqual([...names(res.body)].sort());
    expect(names(await get("/api/v1/lookups/auction-halls?q=Bulk")).length).toBe(20);
  });
});

describe("converted vehicles land on the track they behave as", () => {
  beforeEach(seed);
  it("converting back moves the value to the other tab, with no serialPrefix involved", async () => {
    expect(names(await get("/api/v1/lookups/brands?track=FC"))).toContain("brand-cexp");
    expect(names(await get("/api/v1/lookups/brands?track=FL"))).not.toContain("brand-cexp");
    await prisma.vehicle.update({ where: { id: "v_cexp" }, data: { convertedToExport: false } }); // an FL vehicle again
    expect(names(await get("/api/v1/lookups/brands?track=FC"))).not.toContain("brand-cexp");
    expect(names(await get("/api/v1/lookups/brands?track=FL"))).toContain("brand-cexp");

    expect(names(await get("/api/v1/lookups/brands?track=FL"))).toContain("brand-cloc");
    await prisma.vehicle.update({ where: { id: "v_cloc" }, data: { convertedToLocal: false } }); // an FC vehicle again
    expect(names(await get("/api/v1/lookups/brands?track=FL"))).not.toContain("brand-cloc");
    expect(names(await get("/api/v1/lookups/brands?track=FC"))).toContain("brand-cloc");
  });

  it("a soft-deleted vehicle stops counting, and counts again when restored", async () => {
    expect(names(await get("/api/v1/lookups/brands?track=FC"))).not.toContain("brand-del");
    await prisma.vehicle.update({ where: { id: "v_del" }, data: { deletedAt: null } });
    expect(names(await get("/api/v1/lookups/brands?track=FC"))).toContain("brand-del");
    await prisma.vehicle.update({ where: { id: "v_fc" }, data: { deletedAt: new Date() } });
    expect(names(await get("/api/v1/lookups/brands?track=FC"))).not.toContain("brand-fc");
  });
});

describe("GET /vehicles/destinations", () => {
  beforeAll(seed);
  const list = async (url = "/api/v1/vehicles/destinations", role: Role | null = "MANAGER", org = A) => (await get(url, role, org)).body.data as string[];

  it("without track: every destination of live vehicles in the organisation, once each, sorted", async () => {
    expect(await list()).toEqual(["dest-both", "dest-cexp", "dest-cloc", "dest-fc", "dest-fl"]); // not the deleted vehicle's, not the other org's
  });

  it("track=FC and track=FL use the effective track", async () => {
    expect(await list("/api/v1/vehicles/destinations?track=FC")).toEqual(["dest-both", "dest-cexp", "dest-fc"]);
    expect(await list("/api/v1/vehicles/destinations?track=FL")).toEqual(["dest-both", "dest-cloc", "dest-fl"]);
    expect(await list("/api/v1/vehicles/destinations?track=FC", "MANAGER", B)).toEqual(["dest-orgb"]);
  });

  it("an invalid track is 400, no token is 401, every role may read", async () => {
    for (const bad of ["ALL", "fc", "", "x"]) expect((await get(`/api/v1/vehicles/destinations?track=${bad}`)).status, bad).toBe(400);
    expect((await get("/api/v1/vehicles/destinations", null)).status).toBe(401);
    for (const role of ROLES) expect((await get("/api/v1/vehicles/destinations?track=FL", role)).status, role).toBe(200);
  });
});

describe("GET /vehicles/partner-names (the field is Vehicle.partnerName)", () => {
  beforeEach(seed);
  const names500 = async (url = "/api/v1/vehicles/partner-names", role: Role | null = "VIEWER", org = A) => get(url, role, org);
  const setPartner = (vehicleId: string, partnerName: string | null, extra: Record<string, unknown> = {}) =>
    prisma.vehicle.update({ where: { id: vehicleId }, data: { partnerName, hasPartnership: partnerName !== null, ...extra } });

  it("returns distinct, trimmed, non-empty names of live FL vehicles, sorted without regard to case; FL is the default", async () => {
    await setPartner("v_fl", "  zeta Trading ");
    await setPartner("v_fl2", "Alpha Co");
    await setPartner("v_cloc", "alpha co", {}); // an FC-rooted vehicle converted to local: behaves as FL
    await setPartner("v_fc", "bravo Ltd"); // a native FC vehicle: not in the FL list
    await prisma.vehicle.create({ data: { id: "v_blank", org_id: A, serialPrefix: "FL", serialNumber: 50, serial: "FL50", partnerName: "   ", hasPartnership: true } });
    await prisma.vehicle.create({ data: { id: "v_dup", org_id: A, serialPrefix: "FL", serialNumber: 51, serial: "FL51", partnerName: "Zeta Trading" } });
    await prisma.vehicle.create({ data: { id: "v_dup2", org_id: A, serialPrefix: "FL", serialNumber: 52, serial: "FL52", partnerName: "zeta Trading" } }); // same after trimming: once
    const res = await names500();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(["Alpha Co", "alpha co", "Zeta Trading", "zeta Trading"]);
    expect((await names500("/api/v1/vehicles/partner-names?track=FL")).body.data).toEqual(res.body.data);
  });

  it("track=FC uses the effective track as well (a converted FL vehicle counts)", async () => {
    await setPartner("v_fc", "Bravo Ltd");
    await setPartner("v_cexp", "Echo Ltd"); // FL-rooted, converted to export: behaves as FC
    await setPartner("v_fl", "Foxtrot Ltd");
    expect((await names500("/api/v1/vehicles/partner-names?track=FC")).body.data).toEqual(["Bravo Ltd", "Echo Ltd"]);
    expect((await names500()).body.data).toEqual(["Foxtrot Ltd"]);
  });

  it("excludes soft-deleted vehicles and never returns another organisation's names", async () => {
    await setPartner("v_del", "Deleted Partner", { serialPrefix: "FL" });
    await setPartner("v_fl", "Mine Ltd");
    await prisma.vehicle.update({ where: { id: "v_b" }, data: { partnerName: "Other Org Partner", serialPrefix: "FL", serial: "FL1" } });
    expect((await names500()).body.data).toEqual(["Mine Ltd"]);
    expect((await names500("/api/v1/vehicles/partner-names", "MANAGER", B)).body.data).toEqual(["Other Org Partner"]);
  });

  it("is capped at 500 names", async () => {
    await prisma.vehicle.createMany({
      data: Array.from({ length: 520 }, (_, n) => ({ id: `p_${n}`, org_id: A, serialPrefix: "FL" as const, serialNumber: 1000 + n, serial: `FL${1000 + n}`, partnerName: `Partner ${String(n).padStart(4, "0")}` })),
    });
    const data = (await names500()).body.data as string[];
    expect(data).toHaveLength(500);
    expect(data[0]).toBe("Partner 0000");
    expect(data[499]).toBe("Partner 0499");
  });

  it("empty result, invalid track (400), no token (401), every role", async () => {
    expect((await names500()).body.data).toEqual([]);
    for (const bad of ["ALL", "fl", "", "XX"]) {
      const res = await names500(`/api/v1/vehicles/partner-names?track=${bad}`);
      expect([bad, res.status, res.body.error?.code, Object.keys(res.body.error?.fieldErrors ?? {})]).toEqual([bad, 400, "VALIDATION", ["track"]]);
    }
    expect((await names500("/api/v1/vehicles/partner-names", null)).status).toBe(401);
    for (const role of ROLES) expect((await names500("/api/v1/vehicles/partner-names", role)).status, role).toBe(200);
  });
});

describe("a vehicle of ANOTHER organisation never makes this organisation's rows count", () => {
  beforeEach(seed);

  it("even if corrupt data lets it point at them: the subquery filters by organisation too", async () => {
    // organisation B's vehicle (FC) pointing at organisation A's UNUSED rows; the database allows such a reference, the API never creates one
    await prisma.vehicle.create({
      data: {
        id: "v_cross", org_id: B, serialPrefix: "FC", serialNumber: 77, serial: "FC77",
        modelId: id("model", "unused"), gradeId: id("grade", "unused"),
        auctionHallId: id("hall", "unused"), supplierId: id("supplier", "unused"), transportById: id("transport", "unused"), packingAgentId: id("packing", "unused"),
        vehicleLocationId: id("location", "unused"), inspectionCompanyId: id("inspco", "unused"), inspectionById: id("inspby", "unused"),
        freightAgentId: id("agent", "unused"), rowColourStatusId: id("colour", "unused"), customerId: id("cust", "unused"), destination: "dest-cross", partnerName: "Cross Partner",
      },
    });
    for (const e of ENDPOINTS) {
      const res = await get(e.url("FC"));
      expect([e.url(), names(res)]).toEqual([e.url(), expectedNames(e.kind, USED_FC)]); // unchanged: "unused" did not start to count
    }
    expect((await get(`/api/v1/lookups/models?brandId=${id("brand", "unused")}&track=FC`)).body.data).toEqual([]);
    expect((await get(`/api/v1/lookups/grades?modelId=${id("model", "unused")}&track=FC`)).body.data).toEqual([]);
    expect((await get("/api/v1/vehicles/destinations?track=FC")).body.data).not.toContain("dest-cross");
    expect((await get("/api/v1/vehicles/partner-names?track=FC")).body.data).not.toContain("Cross Partner");
    await prisma.vehicle.update({ where: { id: "v_cross" }, data: { serialPrefix: "FL", serialNumber: 78, serial: "FL78" } }); // now an FL vehicle
    expect((await get("/api/v1/vehicles/partner-names")).body.data).not.toContain("Cross Partner");
    expect((await get("/api/v1/vehicles/partner-names", "MANAGER", B)).body.data).toContain("Cross Partner"); // it is theirs, so they see it
  });
});
