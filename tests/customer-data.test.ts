// The customer read API: whitelisted DTOs, ownership (IDOR), what is excluded, pagination, link requests.
// Fake data only. The SQL-dependent parts (status filters, sort and null placement) are proved in tests/db.

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { bearerFor, newCustomerFake } from "./helpers/customer-fixtures.js";
import { dayOffset, newVehicleFake, vehicleRow } from "./helpers/vehicle-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({ fake: undefined as unknown, minVersion: "1.0.0" }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), APP_MIN_VERSION: state.minVersion }) };
});

import { buildApp } from "../src/app.js";
import { CUSTOMER_RATE_LIMITS } from "../src/config/customer-rate-limits.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";

let app: FastifyInstance;
let fake: FakePrisma;

const SENTINELS = [
  "SENTINEL-REMARK", "SENTINEL-JIBAI", "SENTINEL-DOCSENT", "SENTINEL-HALL", "SENTINEL-SUPPLIER", "SENTINEL-TRANSPORT",
  "SENTINEL-AGENT", "SENTINEL-PACKING", "SENTINEL-PARTNER", "SENTINEL-LC", "SENTINEL-TRACKING", "SENTINEL-ROWCOLOUR",
  "SENTINEL-INSPECTOR", "SENTINEL-LOT", "SENTINEL-ITEM", "SENTINEL-LOCATION", "98765",
];
const FORBIDDEN_KEYS = [
  "vehicleRemark", "jibaishake", "docSentComment", "auctionBillPaid", "auctionHall", "auctionHallId", "supplier", "supplierId", "transport", "transportById",
  "freightAgent", "packingAgent", "sellingPrice", "rowColour", "customerId", "org_id", "orgId", "hasPartnership", "partnerName", "lcNo", "trackingNumber",
  "inspection", "logBook", "extraKey", "paidByCustomer", "deletedAt", "customerVisible", "visibleToCustomer", "uploadedBy", "url", "key",
];

beforeEach(async () => {
  fake = newVehicleFake();
  for (const row of newCustomerFake().rows("user")) {
    const existing = fake.rows("user").find((u) => u["id"] === row["id"]);
    if (existing) Object.assign(existing, row);
    else fake.seed("user", row);
  }
  state.fake = fake;
  state.minVersion = "1.0.0";
  identifierLimiter.reset();
  resetShadowLockouts();

  fake.seed("auctionHall", { id: "hall_s", org_id: ORG_A, name: "SENTINEL-HALL" });
  fake.seed("supplier", { id: "sup_s", org_id: ORG_A, name: "SENTINEL-SUPPLIER" });
  fake.seed("transportCompany", { id: "tc_s", org_id: ORG_A, name: "SENTINEL-TRANSPORT" });
  fake.seed("packingAgent", { id: "pa_s", org_id: ORG_A, name: "SENTINEL-PACKING" });
  fake.seed("vehicleLocation", { id: "loc_s", org_id: ORG_A, name: "SENTINEL-LOCATION" });
  fake.seed("inspectionBy", { id: "ib_s", org_id: ORG_A, name: "SENTINEL-INSPECTOR" });
  Object.assign(fake.rows("freightAgent").find((a) => a["id"] === "fa_a1")!, { name: "SENTINEL-AGENT" });
  Object.assign(fake.rows("rowColourStatus").find((r) => r["id"] === "rc_done")!, { name: "SENTINEL-ROWCOLOUR" });

  const internal = {
    vehicleRemark: "SENTINEL-REMARK", jibaishake: "SENTINEL-JIBAI", docSentComment: "SENTINEL-DOCSENT", auctionBillPaid: true, logBook: true, extraKey: false,
    auctionHallId: "hall_s", supplierId: "sup_s", transportById: "tc_s", packingAgentId: "pa_s", vehicleLocationId: "loc_s", inspectionById: "ib_s",
    freightAgentId: "fa_a1", hasPartnership: true, partnerName: "SENTINEL-PARTNER", lcNo: "SENTINEL-LC", trackingNumber: "SENTINEL-TRACKING",
    rowColourStatusId: "rc_done", auctionLotNo: "SENTINEL-LOT", auctionItemNo: "SENTINEL-ITEM", sellingPrice: 98765, paidByCustomer: true,
  };
  const v = (id: string, serial: string, over: Record<string, unknown>) =>
    fake.seed("vehicle", vehicleRow({ id, org_id: ORG_A, serial, customerId: "cust_a1", customerVisible: true, modelId: "model_a1", ...over }));

  v("cv_own1", "FC501", { ...internal, gradeId: "grade_a1", yom: 2019, chassisNo: "OWN-CHASSIS-1", destination: "Country One", purchaseDate: dayOffset(-30), shipmentStatus: "PENDING", customerAmount: 12000, customerAmountCurrency: "USD", portOfLoading: "Port L", portOfDischarge: "Port D", vesselName: "Vessel V", voyageNo: "V1" });
  v("cv_own2", "FC502", { modelId: "model_a2", purchaseDate: dayOffset(-10), shipmentStatus: "BOOKING_RECEIVED", etd: dayOffset(12), eta: dayOffset(40), blNo: "BL-502", shippingMethod: "CONTAINER", containerNumber: "CONT-502" });
  v("cv_own3", "FC503", { purchaseDate: dayOffset(-90), shipmentStatus: "SHIPPED", etd: dayOffset(-60), customerAmount: 3000, customerAmountCurrency: "EUR" });
  v("cv_own4", "FC504", { purchaseDate: null, shipmentStatus: "SHIPPED", etd: dayOffset(-30) });
  v("cv_hidden", "FC505", { customerVisible: false });
  v("cv_fl", "FL506", { serialPrefix: "FL" });
  v("cv_cancelled", "FC507", { rowColourStatusId: "rc_cancel" });
  v("cv_local", "FC508", { convertedToLocal: true });
  v("cv_deleted", "FC509", { deletedAt: new Date() });
  v("cv_fl_exported", "FL510", { serialPrefix: "FL", convertedToExport: true, purchaseDate: dayOffset(-5) });
  v("cv_other", "FC511", { customerId: "cust_a2" });
  fake.seed("vehicle", vehicleRow({ id: "cv_b", org_id: ORG_B, serial: "FC501", customerId: "cust_b1", customerVisible: true, modelId: "model_b1" }));

  const ms = (vehicleId: string, type: string) => fake.seed("vehicleMilestone", { id: `m_${vehicleId}_${type}`, org_id: ORG_A, vehicleId, type, occurredAt: new Date("2026-05-01"), recordedById: null });
  ms("cv_own1", "BOUGHT");
  ms("cv_own3", "DELIVERED");
  ms("cv_own3", "SHIPPED");
  ms("cv_own4", "ARRIVED");

  const photo = (id: string, vehicleId: string, visible: boolean) => fake.seed("vehiclePhoto", { id, vehicleId, url: `https://files.example.test/org/${ORG_A}/vehicles/${vehicleId}/photos/${id}.jpg`, visibleToCustomer: visible, uploadedById: "staff_a1" });
  photo("ph1", "cv_own1", true);
  photo("ph2", "cv_own1", true);
  photo("ph_hidden", "cv_own1", false);
  photo("ph_other", "cv_other", true);
  const doc = (id: string, vehicleId: string, visible: boolean, type = "BL") => fake.seed("vehicleDocument", { id, vehicleId, url: `https://files.example.test/org/${ORG_A}/vehicles/${vehicleId}/documents/${id}.pdf`, name: `Doc ${id}`, documentType: type, visibleToCustomer: visible, uploadedById: "staff_a1" });
  doc("d1", "cv_own1", true);
  doc("d2", "cv_own3", true, "EC");
  doc("d_hidden", "cv_own1", false);
  doc("d_other", "cv_other", true);
  doc("d_hidden_vehicle", "cv_hidden", true);

  fake.seed(
    "faq",
    { id: "f2", org_id: ORG_A, question: "Second?", answer: "Yes.", sortOrder: 2, published: true, createdAt: new Date(2026, 0, 2) },
    { id: "f1", org_id: ORG_A, question: "First?", answer: "Yes.", sortOrder: 1, published: true, createdAt: new Date(2026, 0, 1) },
    { id: "f_draft", org_id: ORG_A, question: "Draft?", answer: "No.", sortOrder: 0, published: false, createdAt: new Date(2026, 0, 1) },
    { id: "f_b", org_id: ORG_B, question: "Other org?", answer: "No.", sortOrder: 0, published: true, createdAt: new Date(2026, 0, 1) }
  );

  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await app.close();
});

const get = async (path: string, as = "cust_a1", orgId = ORG_A) =>
  app.inject({ method: "GET", url: `/api/customer/v1${path}`, headers: await bearerFor(as, orgId) });
const data = async (path: string, as = "cust_a1", orgId = ORG_A) => (await get(path, as, orgId)).json().data;
const sorted = (o: object) => Object.keys(o).sort();

const SUMMARY_KEYS = ["amount", "brand", "chassisNo", "coverPhotoId", "destination", "eta", "etd", "grade", "id", "model", "photoCount", "portOfDischarge", "portOfLoading", "purchaseDate", "serial", "status", "vesselName", "year"];
const DETAIL_KEYS = [...SUMMARY_KEYS, "blNo", "containerNumber", "shippingMethod", "voyageNo"].sort();

describe("every route needs a customer token", () => {
  const ROUTES = ["/home", "/vehicles", "/vehicles/cv_own1", "/vehicles/cv_own1/timeline", "/vehicles/cv_own1/photos", "/purchase-history", "/documents", "/help/faqs"];

  it.each(ROUTES)("%s: 401 without a token, with a staff token, and with a forged one", async (path) => {
    const staff = await signAccessToken({ sub: "staff_a1", orgId: ORG_A, role: "ADMINISTRATOR", name: "S", email: null });
    for (const headers of [{}, { authorization: `Bearer ${staff}` }, { authorization: "Bearer not.a.token" }]) {
      const res = await app.inject({ method: "GET", url: `/api/customer/v1${path}`, headers });
      expect(res.statusCode, path).toBe(401);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("link requests too, and a customer token works on all of them", async () => {
    expect((await app.inject({ method: "POST", url: "/api/customer/v1/vehicles/link-requests", payload: { serial: "FC1" } })).statusCode).toBe(401);
    for (const path of ROUTES) expect((await get(path)).statusCode, path).toBe(200);
  });
});

describe("GET /vehicles", () => {
  it("lists exactly the customer's own, released, export-track, not-cancelled, not-deleted vehicles", async () => {
    const body = await data("/vehicles?sort=purchaseDate&dir=asc");
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual(["cv_own3", "cv_own1", "cv_own2", "cv_fl_exported", "cv_own4"]);
    expect(body.total).toBe(5);
    const ids = new Set(body.rows.map((r: { id: string }) => r.id));
    for (const excluded of ["cv_hidden", "cv_fl", "cv_cancelled", "cv_local", "cv_deleted", "cv_other", "cv_b"]) expect(ids.has(excluded), excluded).toBe(false);
  });

  it("another customer and another org see only their own", async () => {
    expect((await data("/vehicles", "cust_a2")).rows.map((r: { id: string }) => r.id)).toEqual(["cv_other"]);
    expect((await data("/vehicles", "cust_b1", ORG_B)).rows.map((r: { id: string }) => r.id)).toEqual(["cv_b"]);
  });

  it("returns the whitelisted summary keys and nothing else", async () => {
    const { rows } = await data("/vehicles");
    for (const row of rows) expect(sorted(row)).toEqual(SUMMARY_KEYS);
  });

  it("maps the data: names, money, status, cover photo and released photo count", async () => {
    const { rows } = await data("/vehicles");
    const one = rows.find((r: { id: string }) => r.id === "cv_own1");
    expect(one).toMatchObject({
      serial: "FC501", brand: "Alpha Motors", model: "Zeta One", grade: "Base", year: 2019, chassisNo: "OWN-CHASSIS-1", destination: "Country One",
      status: "PENDING", amount: { amount: 12000, currency: "USD" }, coverPhotoId: "ph1", photoCount: 2, portOfLoading: "Port L", portOfDischarge: "Port D", vesselName: "Vessel V",
    });
    expect(rows.find((r: { id: string }) => r.id === "cv_own2")).toMatchObject({ status: "BOOKING_RECEIVED", amount: null, coverPhotoId: null, photoCount: 0 });
    expect(rows.find((r: { id: string }) => r.id === "cv_own3").status).toBe("DELIVERED");
    expect(rows.find((r: { id: string }) => r.id === "cv_own4").status).toBe("ARRIVED");
  });

  it("never contains an internal value or an internal field name", async () => {
    for (const path of ["/vehicles", "/vehicles/cv_own1", "/home", "/purchase-history", "/documents", "/vehicles/cv_own1/timeline", "/vehicles/cv_own1/photos"]) {
      const text = (await get(path)).body;
      for (const s of SENTINELS) expect(text, `${path} ${s}`).not.toContain(s);
      for (const k of FORBIDDEN_KEYS) expect(text, `${path} ${k}`).not.toContain(`"${k}"`);
    }
  });

  describe("pagination", () => {
    it("pages with a stable order and reports the total", async () => {
      const first = await data("/vehicles?pageSize=2&sort=purchaseDate&dir=asc");
      const second = await data("/vehicles?pageSize=2&page=2&sort=purchaseDate&dir=asc");
      const third = await data("/vehicles?pageSize=2&page=3&sort=purchaseDate&dir=asc");
      expect([first, second, third].map((p) => p.rows.map((r: { id: string }) => r.id))).toEqual([["cv_own3", "cv_own1"], ["cv_own2", "cv_fl_exported"], ["cv_own4"]]);
      expect([first.total, second.total, third.total]).toEqual([5, 5, 5]);
      expect(first).toMatchObject({ page: 1, pageSize: 2 });
    });

    it("a page past the end is empty, not an error", async () => {
      expect((await data("/vehicles?page=99")).rows).toEqual([]);
    });

    it.each(["page=0", "page=-1", "page=abc", "page=1.5", "page=100001", "pageSize=0", "pageSize=51", "pageSize=1000", "pageSize=abc"])("rejects %s with 400", async (q) => {
      expect((await get(`/vehicles?${q}`)).statusCode).toBe(400);
    });

    it("accepts the largest page size, 50", async () => {
      expect((await get("/vehicles?pageSize=50")).statusCode).toBe(200);
    });
  });

  describe("parameters are strict", () => {
    it.each(["orgId=org_x", "customerId=cust_a2", "sort=sellingPrice", "sort=chassisNo", "dir=up", "status=CANCELLED", "status=shipped", "x=1", "limit=5"])("rejects %s with 400", async (q) => {
      const res = await get(`/vehicles?${q}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION");
    });
  });

  it("sorts by price with vehicles that have no price last, in both directions", async () => {
    const asc = (await data("/vehicles?sort=price&dir=asc")).rows.map((r: { id: string }) => r.id);
    const desc = (await data("/vehicles?sort=price&dir=desc")).rows.map((r: { id: string }) => r.id);
    expect(asc.slice(0, 2)).toEqual(["cv_own3", "cv_own1"]);
    expect(desc.slice(0, 2)).toEqual(["cv_own1", "cv_own3"]);
    for (const order of [asc, desc]) expect(order.slice(2).sort()).toEqual(["cv_fl_exported", "cv_own2", "cv_own4"]);
  });

  it("filters by brand, ignoring case", async () => {
    expect((await data("/vehicles?brand=BETA%20autos")).rows.map((r: { id: string }) => r.id)).toEqual(["cv_own2"]);
    expect((await data("/vehicles?brand=nothing")).total).toBe(0);
  });
});

describe("vehicle detail, timeline and photos: ownership", () => {
  const ROUTES = (id: string) => [`/vehicles/${id}`, `/vehicles/${id}/timeline`, `/vehicles/${id}/photos`];
  const NOT_FOUND = { error: { code: "NOT_FOUND", message: "Vehicle not found." } };

  it.each(ROUTES("cv_own1"))("%s: the owner gets 200", async (path) => {
    expect((await get(path)).statusCode).toBe(200);
  });

  it.each([
    ["another customer's vehicle in the same org", "cv_other"],
    ["a vehicle not released to the customer", "cv_hidden"],
    ["a local (FL) vehicle", "cv_fl"],
    ["a cancelled vehicle", "cv_cancelled"],
    ["a vehicle converted to local", "cv_local"],
    ["a deleted vehicle", "cv_deleted"],
    ["another org's vehicle", "cv_b"],
    ["an unknown id", "nope"],
    ["a path-like id", "..%2F..%2Fx"],
    ["a very long id", "a".repeat(90)],
  ])("%s is the same 404 on all three routes", async (_name, id) => {
    for (const path of ROUTES(id)) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(404);
      expect(res.json(), path).toEqual(NOT_FOUND);
    }
  });

  it("the other customers get 404 for the first customer's vehicle, and a token for the wrong org is refused by the guard", async () => {
    for (const path of ROUTES("cv_own1")) {
      expect((await get(path, "cust_a2")).statusCode).toBe(404);
      expect((await get(path, "cust_b1", ORG_B)).statusCode).toBe(404);
      expect((await get(path, "cust_a1", ORG_B)).statusCode).toBe(401);
    }
  });

  it("an FL vehicle converted to export is visible", async () => {
    expect((await get("/vehicles/cv_fl_exported")).statusCode).toBe(200);
  });

  it("the detail has the whitelisted keys", async () => {
    expect(sorted(await data("/vehicles/cv_own2"))).toEqual(DETAIL_KEYS);
    expect(await data("/vehicles/cv_own2")).toMatchObject({ blNo: "BL-502", shippingMethod: "CONTAINER", containerNumber: "CONT-502", status: "BOOKING_RECEIVED" });
  });

  it("the timeline always lists the 9 steps in order, with the recorded ones completed", async () => {
    const steps = await data("/vehicles/cv_own3/timeline");
    expect(steps.map((s: { type: string }) => s.type)).toEqual([
      "BOUGHT", "AUCTION_BILL_PAID", "AT_EXPORT_YARD", "EXPORT_CERT_ISSUED", "BOOKING_RECEIVED", "SHIPPED", "BL_ISSUED", "ARRIVED", "DELIVERED",
    ]);
    for (const s of steps) expect(sorted(s)).toEqual(["completed", "label", "occurredAt", "type"]);
    expect(steps.filter((s: { completed: boolean }) => s.completed).map((s: { type: string }) => s.type)).toEqual(["SHIPPED", "DELIVERED"]);
    expect(steps.find((s: { type: string }) => s.type === "SHIPPED")).toMatchObject({ label: "Shipped", occurredAt: "2026-05-01T00:00:00.000Z" });
    expect(steps.find((s: { type: string }) => s.type === "BOUGHT")).toMatchObject({ completed: false, occurredAt: null });
  });

  it("the photos list holds only released photos, as ids and dates, never a URL", async () => {
    const photos = await data("/vehicles/cv_own1/photos");
    expect(photos.map((p: { id: string }) => p.id)).toEqual(["ph1", "ph2"]);
    for (const p of photos) expect(sorted(p)).toEqual(["createdAt", "id"]);
    expect(JSON.stringify(photos)).not.toMatch(/https?:|org\//);
  });
});

describe("documents", () => {
  it("lists only released documents of the customer's own visible vehicles", async () => {
    const body = await data("/documents");
    expect(body.rows.map((d: { id: string }) => d.id).sort()).toEqual(["d1", "d2"]);
    expect(body.total).toBe(2);
    for (const d of body.rows) {
      expect(sorted(d)).toEqual(["createdAt", "id", "name", "type", "vehicle"]);
      expect(sorted(d.vehicle)).toEqual(["id", "serial"]);
    }
    expect(JSON.stringify(body)).not.toMatch(/https?:|org\/|\.pdf/);
  });

  it("filters by one of the customer's vehicles; a vehicle that is not theirs matches nothing (no error, no hint)", async () => {
    expect((await data("/documents?vehicleId=cv_own1")).rows.map((d: { id: string }) => d.id)).toEqual(["d1"]);
    for (const id of ["cv_other", "cv_hidden", "cv_b", "nope"]) {
      const res = await get(`/documents?vehicleId=${id}`);
      expect(res.statusCode, id).toBe(200);
      expect(res.json().data).toMatchObject({ rows: [], total: 0 });
    }
  });

  it("another customer sees only their own documents", async () => {
    expect((await data("/documents", "cust_a2")).rows.map((d: { id: string }) => d.id)).toEqual(["d_other"]);
  });

  it.each(["pageSize=51", "page=0", "x=1", "orgId=org_b"])("rejects %s", async (q) => {
    expect((await get(`/documents?${q}`)).statusCode).toBe(400);
  });
});

describe("purchase history", () => {
  it("counts delivered vehicles, groups money by currency (mixed currencies give no single total) and gives the member-since date", async () => {
    const body = await data("/purchase-history");
    expect(sorted(body)).toEqual(["customerSince", "deliveredCount", "totalSpent", "totalSpentByCurrency"]);
    expect(body.deliveredCount).toBe(1);
    expect(body.totalSpent).toBeNull();
    expect(body.totalSpentByCurrency).toEqual([{ amount: 3000, currency: "EUR" }, { amount: 12000, currency: "USD" }]);
    expect(typeof body.customerSince).toBe("string");
  });

  it("with one currency there is a single total", async () => {
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "cv_own3")!, { customerAmountCurrency: "USD" });
    expect((await data("/purchase-history")).totalSpent).toEqual({ amount: 15000, currency: "USD" });
  });

  it("without any value entered, the total is null and the list empty", async () => {
    const body = await data("/purchase-history", "cust_a2");
    expect(body).toMatchObject({ deliveredCount: 0, totalSpent: null, totalSpentByCurrency: [] });
  });

  it("never counts another customer's, an unreleased or a local vehicle", async () => {
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "cv_other")!, { customerAmount: 777, customerAmountCurrency: "USD" });
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "cv_hidden")!, { customerAmount: 555, customerAmountCurrency: "USD" });
    expect((await data("/purchase-history")).totalSpentByCurrency).toEqual([{ amount: 3000, currency: "EUR" }, { amount: 12000, currency: "USD" }]);
  });
});

describe("home", () => {
  it("has the whitelisted keys and sensible numbers", async () => {
    const home = await data("/home");
    expect(sorted(home)).toEqual(["activeCount", "deliveredCount", "name", "nextDeparture", "recentVehicles"]);
    expect(home).toMatchObject({ name: "Customer cust_a1", activeCount: 4, deliveredCount: 1 });
    expect(sorted(home.nextDeparture)).toEqual(["etd", "serial", "vehicleId"]);
    expect(home.nextDeparture).toMatchObject({ vehicleId: "cv_own2", serial: "FC502" });
    expect(home.recentVehicles).toHaveLength(3);
    for (const r of home.recentVehicles) expect(sorted(r)).toEqual(SUMMARY_KEYS);
  });

  it("a customer with nothing has empty numbers and no departure", async () => {
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "cv_other")!, { customerVisible: false });
    expect(await data("/home", "cust_a2")).toMatchObject({ activeCount: 0, deliveredCount: 0, nextDeparture: null, recentVehicles: [] });
  });
});

describe("FAQs", () => {
  it("lists only published FAQs of the customer's org, in order", async () => {
    const faqs = await data("/help/faqs");
    expect(faqs.map((f: { id: string }) => f.id)).toEqual(["f1", "f2"]);
    for (const f of faqs) expect(sorted(f)).toEqual(["answer", "id", "question"]);
    expect((await data("/help/faqs", "cust_b1", ORG_B)).map((f: { id: string }) => f.id)).toEqual(["f_b"]);
  });

  it("takes no query parameters", async () => {
    expect((await get("/help/faqs?orgId=org_b")).statusCode).toBe(400);
  });
});

describe("GET /app/min-version", () => {
  it("needs no token, returns only the version, and follows APP_MIN_VERSION", async () => {
    const res = await app.inject({ method: "GET", url: "/api/customer/v1/app/min-version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { minVersion: "1.0.0" } });
    state.minVersion = "2.3.4";
    expect((await app.inject({ method: "GET", url: "/api/customer/v1/app/min-version" })).json().data.minVersion).toBe("2.3.4");
  });
});

describe("POST /vehicles/link-requests", () => {
  const post = async (body: unknown, as = "cust_a1", orgId = ORG_A) =>
    app.inject({ method: "POST", url: "/api/customer/v1/vehicles/link-requests", headers: await bearerFor(as, orgId), payload: body as object });
  const requests = () => fake.rows("vehicleLinkRequest");

  beforeEach(() => {
    fake.seed(
      "user",
      { id: "mgr_1", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "Manager" },
      { id: "viewer_1", org_id: ORG_A, userType: "STAFF", role: "VIEWER", loginEnabled: true, name: "Viewer" },
      { id: "agent_1", org_id: ORG_A, userType: "STAFF", role: "OPERATOR", loginEnabled: true, name: "Agent" },
      { id: "mgr_b", org_id: ORG_B, userType: "STAFF", role: "MANAGER", loginEnabled: true, name: "Other org manager" }
    );
    Object.assign(fake.rows("user").find((u) => u["id"] === "cust_a1")!, { assignedAgentId: "agent_1" });
  });

  it("answers 202 {accepted:true} for a serial that exists, one that does not, another customer's and another org's: identical", async () => {
    const answers = [];
    for (const serial of ["FC501", "FC999999", "FC511", "FL506", "FC505"]) {
      const res = await post({ serial });
      answers.push({ status: res.statusCode, body: res.json(), type: res.headers["content-type"] });
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0]).toMatchObject({ status: 202, body: { data: { accepted: true } } });
  });

  it("never looks the vehicle up", async () => {
    await post({ serial: "FC501" });
    await post({ serial: "FC424242" });
    expect(fake.calls.filter((c) => c.model === "vehicle")).toEqual([]);
  });

  it("stores the request for the token's customer and org, with the serial normalised, and logs it", async () => {
    await post({ serial: "  fc501 " });
    expect(requests()).toMatchObject([{ org_id: ORG_A, customerId: "cust_a1", serialEntered: "FC501", status: "PENDING" }]);
    expect(fake.rows("activityLog")).toMatchObject([{ action: "CREATE_LINK_REQUEST", actorId: "cust_a1", org_id: ORG_A }]);
  });

  it("a repeat of a pending request creates nothing new and answers the same", async () => {
    const first = await post({ serial: "FC501" });
    const again = await post({ serial: "fc501" });
    expect(again.json()).toEqual(first.json());
    expect(requests()).toHaveLength(1);
  });

  it("stops creating rows after 20 pending, still answering the same", async () => {
    identifierLimiter.reset();
    for (let i = 1; i <= 22; i++) {
      identifierLimiter.reset();
      expect((await post({ serial: `FC${1000 + i}` })).statusCode).toBe(202);
    }
    expect(requests()).toHaveLength(20);
  });

  it("notifies administrators, managers and the assigned agent (not viewers, not other orgs) and writes no customer notification", async () => {
    await post({ serial: "FC501" });
    const rows = fake.rows("notification");
    expect(rows.map((n) => n["userId"] ?? n["user_id"]).sort()).toEqual(["agent_1", "mgr_1", "staff_a1"]);
    expect(rows.every((n) => n["event"] === "VEHICLE_LINK_REQUESTED" && n["org_id"] === ORG_A)).toBe(true);
    expect(rows[0]!["body"]).toBe("Customer cust_a1 asked to be linked to FC501.");
  });

  it("a repeat or a capped request sends no second notification", async () => {
    await post({ serial: "FC501" });
    const before = fake.rows("notification").length;
    await post({ serial: "FC501" });
    expect(fake.rows("notification")).toHaveLength(before);
  });

  it.each([
    ["no serial", {}],
    ["an empty serial", { serial: "" }],
    ["a number", { serial: 501 }],
    ["no prefix", { serial: "501" }],
    ["a wrong prefix", { serial: "XX501" }],
    ["text after the number", { serial: "FC501 or 1=1" }],
    ["a very long number", { serial: "FC12345678901" }],
    ["extra fields", { serial: "FC501", customerId: "cust_a2" }],
    ["an org id", { serial: "FC501", orgId: ORG_B }],
    ["a vehicle id", { serial: "FC501", vehicleId: "cv_other" }],
  ])("rejects %s with 400 and stores nothing", async (_n, body) => {
    expect((await post(body)).statusCode).toBe(400);
    expect(requests()).toHaveLength(0);
  });

  it("is limited per customer (5 an hour) and per IP, with the standard 429", async () => {
    expect(CUSTOMER_RATE_LIMITS.linkRequest.identifier).toEqual({ max: 5, windowMs: 3_600_000 });
    expect(CUSTOMER_RATE_LIMITS.linkRequest.ip).toEqual({ max: 10, windowMs: 60_000 });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post({ serial: `FC${2000 + i}` })).statusCode);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429, 429]);
    const limited = await post({ serial: "FC3000" });
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("another customer's limit is separate", async () => {
    for (let i = 0; i < 6; i++) await post({ serial: `FC${2000 + i}` });
    expect((await post({ serial: "FC1" }, "cust_a2")).statusCode).toBe(202);
  });
});

describe("rate limits for reading", () => {
  it("are in the config module with the intended values", () => {
    expect(CUSTOMER_RATE_LIMITS.read).toEqual({ ip: { max: 120, windowMs: 60_000 }, identifier: { max: 240, windowMs: 60_000 } });
    expect(CUSTOMER_RATE_LIMITS.appConfig.ip).toEqual({ max: 60, windowMs: 60_000 });
  });

  it("a customer who reads too much gets 429, others do not", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 242; i++) statuses.push((await get("/help/faqs")).statusCode);
    expect(statuses.slice(0, 240).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(240)).toEqual([429, 429]);
    expect((await get("/help/faqs", "cust_a2")).statusCode).toBe(200);
  }, 60_000);
});
