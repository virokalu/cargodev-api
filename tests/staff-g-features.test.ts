// G10 (X-Contract-Version on every /api/v1 answer), G6 (isSuperAdmin on the profile), the validation side of G2 and G3 (the track
// parameter, 401, 400; the results themselves are proven on real Postgres in tests/db/track-filters.db.test.ts), and the whole timeline (G12).
// Fake data only.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { STAFF_PASSWORD, installFakeStorage, makeCtx, newContractWorld, removeFakeStorage, type Ctx } from "./helpers/staff-contract-examples.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const state = vi.hoisted(() => {
  process.env["R2_PUBLIC_URL"] = "https://files.example.test";
  return { fake: undefined as unknown };
});
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { buildApp } from "../src/app.js";
import { CONTRACT_VERSION } from "../src/config/contract-version.js";
import { setTrustTokenClaimsForTests } from "../src/lib/staff-auth-seam.js";
import { clearStaffAuthCache } from "../src/services/staff-auth-state.service.js";
import { isSuperAdmin } from "../src/services/user.service.js";

let app: FastifyInstance;
let limited: FastifyInstance;
let fake: FakePrisma;
let ctx: Ctx;
type Body = { data?: unknown; error?: { code: string; fieldErrors?: Record<string, string> } };
const call = async (as: Parameters<Ctx["call"]>[0], method: string, url: string, payload?: unknown) => {
  const res = await ctx.call(as, method, url, payload);
  return { status: res.status, headers: res.headers, body: res.body as Body };
};
const ROLES = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"] as const;

beforeAll(async () => {
  setTrustTokenClaimsForTests(false);
  installFakeStorage();
  state.fake = newContractWorld();
  app = await buildApp({ rateLimit: false, publicStockEnabled: true });
  limited = await buildApp({ rateLimit: true, publicStockEnabled: true });
});
afterAll(async () => {
  await app.close();
  await limited.close();
  removeFakeStorage();
  setTrustTokenClaimsForTests(true);
});
beforeEach(() => {
  fake = newContractWorld();
  state.fake = fake;
  clearStaffAuthCache();
  ctx = makeCtx(app, fake);
});

describe("X-Contract-Version (G10)", () => {
  it("is on a success, a 401, a 403, a 404, a 404 for an unknown route under the prefix, a 400 and a 409", async () => {
    const cases: Array<[string, Awaited<ReturnType<typeof call>>, number]> = [
      ["200", await call("MANAGER", "GET", "/api/v1/profile"), 200],
      ["401", await call(null, "GET", "/api/v1/profile"), 401],
      ["403", await call("VIEWER", "GET", "/api/v1/staff"), 403],
      ["404", await call("MANAGER", "GET", "/api/v1/vehicles/FC999999"), 404],
      ["404 route", await call("MANAGER", "GET", "/api/v1/no-such-route"), 404],
      ["404 route, no token", await call(null, "GET", "/api/v1/no-such-route"), 404],
      ["400", await call(null, "POST", "/api/v1/auth/login", { email: "x", password: "" }), 400],
      ["409", await call("ADMINISTRATOR", "PATCH", "/api/v1/vehicles/v_fc_pending/serial", { serialNumber: 102 }), 409],
    ];
    for (const [name, res, status] of cases) {
      expect([name, res.status]).toEqual([name, status]);
      expect([name, res.headers["x-contract-version"]]).toEqual([name, CONTRACT_VERSION]);
    }
  });

  it("is on a 429 (rate limited)", async () => {
    let last: Awaited<ReturnType<typeof limited.inject>> | undefined;
    for (let i = 0; i < 12; i += 1) {
      last = await limited.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: `nobody${i}@example.test`, password: STAFF_PASSWORD } });
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.headers["x-contract-version"]).toBe(CONTRACT_VERSION);
  });

  it("is NOT sent outside /api/v1: health, the public website API, the customer zone, file links, unknown paths and look-alike prefixes", async () => {
    for (const [method, url] of [["GET", "/health"], ["GET", "/api/public/stock"], ["POST", "/api/customer/v1/auth/login"], ["GET", "/f/v1/anything"], ["GET", "/nowhere"], ["GET", "/api/v1x/profile"], ["GET", "/api/v10/profile"]] as const) {
      const res = await app.inject({ method, url, ...(method === "POST" ? { payload: {} } : {}) });
      expect([url, res.headers["x-contract-version"]]).toEqual([url, undefined]);
    }
  });

  it("is listed for browsers: an allowed origin may read it", async () => {
    const withCors = await buildApp({ rateLimit: false, corsOrigins: ["https://app.example.test"] });
    try {
      const res = await withCors.inject({ method: "GET", url: "/api/v1/profile", headers: { origin: "https://app.example.test" } });
      expect(String(res.headers["access-control-expose-headers"]).toLowerCase()).toContain("x-contract-version");
      const refused = await withCors.inject({ method: "GET", url: "/api/v1/profile", headers: { origin: "https://evil.example.test" } });
      expect(refused.headers["access-control-expose-headers"]).toBeUndefined();
    } finally {
      await withCors.close();
    }
  });
});

describe("isSuperAdmin on the profile (G6)", () => {
  it("GET and PATCH /profile carry exactly the keys id, name, email, phone, role, isSuperAdmin", async () => {
    for (const role of ROLES) {
      const res = await call(role, "GET", "/api/v1/profile");
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data as object).sort()).toEqual(["email", "id", "isSuperAdmin", "name", "phone", "role"]);
    }
    const patched = await call("MANAGER", "PATCH", "/api/v1/profile", { phone: "0770000001" });
    expect(Object.keys(patched.body.data as object).sort()).toEqual(["email", "id", "isSuperAdmin", "name", "phone", "role"]);
    expect((patched.body.data as { isSuperAdmin: boolean }).isSuperAdmin).toBe(false);
  });

  it("is true for the account named exactly Administrator with the ADMINISTRATOR role, and false for everyone else", async () => {
    const answers = [];
    for (const role of ROLES) answers.push([role, ((await call(role, "GET", "/api/v1/profile")).body.data as { isSuperAdmin: boolean }).isSuperAdmin]);
    expect(answers).toEqual([["ADMINISTRATOR", true], ["MANAGER", false], ["OPERATOR", false], ["VIEWER", false]]);
  });

  it("uses the SAME function as the reserved-name rule: for every name and role the answer equals isSuperAdmin(name, role)", async () => {
    const names = ["Administrator", "administrator", "Administrator ", "Other Admin", "Example Administrator", ""];
    for (const name of names) {
      for (const role of ["ADMINISTRATOR", "MANAGER"] as const) {
        const row = fake.rows("user").find((u) => u["id"] === (role === "ADMINISTRATOR" ? "staff_admin" : "staff_mgr"))!;
        row["name"] = name;
        clearStaffAuthCache();
        const res = await call(role, "GET", "/api/v1/profile");
        expect([name, role, (res.body.data as { isSuperAdmin: boolean }).isSuperAdmin]).toEqual([name, role, isSuperAdmin({ name, role })]);
      }
    }
  });

  it("changes with the name: renaming the super-admin away takes the flag with it, and the server still decides everything else", async () => {
    expect(((await call("ADMINISTRATOR", "GET", "/api/v1/profile")).body.data as { isSuperAdmin: boolean }).isSuperAdmin).toBe(true);
    const renamed = await call("ADMINISTRATOR", "PATCH", "/api/v1/profile", { name: "Someone Else" });
    expect((renamed.body.data as { isSuperAdmin: boolean }).isSuperAdmin).toBe(false);
    // not just a label, and with NO manual cache clearing: the profile update ended the cached identity, so the very next request is judged
    // by the new name. The account can no longer do what only the super-admin may do.
    const asOrdinaryAdmin = await call("ADMINISTRATOR", "POST", "/api/v1/staff", { name: "New Admin", email: "new.admin@example.test", role: "ADMINISTRATOR", password: STAFF_PASSWORD });
    expect(asOrdinaryAdmin.status).toBe(403);
  });

  it("401 without a token", async () => {
    expect((await call(null, "GET", "/api/v1/profile")).status).toBe(401);
  });
});

describe("the track parameter: validation and the unchanged default (G2, G3)", () => {
  const ENDPOINTS = [
    "/api/v1/lookups/brands",
    "/api/v1/lookups/models?brandId=brand_a1",
    "/api/v1/lookups/grades?modelId=model_a1",
    "/api/v1/lookups/auction-halls",
    "/api/v1/lookups/suppliers",
    "/api/v1/lookups/transport-companies",
    "/api/v1/lookups/packing-agents",
    "/api/v1/lookups/vehicle-locations",
    "/api/v1/lookups/inspection-companies",
    "/api/v1/lookups/inspection-by",
    "/api/v1/lookups/freight-agents",
    "/api/v1/lookups/freight-agents/search",
    "/api/v1/lookups/row-colour-statuses",
    "/api/v1/customers/search",
    "/api/v1/vehicles/destinations",
    "/api/v1/vehicles/partner-names",
  ];
  const withTrack = (url: string, track: string) => `${url}${url.includes("?") ? "&" : "?"}track=${track}`;

  it.each(ENDPOINTS)("%s: ALL, lower case, empty and other values are 400 VALIDATION with fieldErrors.track", async (url) => {
    for (const bad of ["ALL", "fc", "fl", "", "XX", "FC,FL"]) {
      const res = await call("MANAGER", "GET", withTrack(url, bad));
      expect([bad, res.status, res.body.error?.code, Object.keys(res.body.error?.fieldErrors ?? {})]).toEqual([bad, 400, "VALIDATION", ["track"]]);
    }
  });

  it.each(ENDPOINTS)("%s: no token is 401, and without track the answer is the same 200 as before", async (url) => {
    expect((await call(null, "GET", url)).status).toBe(401);
    for (const role of ROLES) expect((await call(role, "GET", url)).status, role).toBe(200);
  });

  it("GET /vehicles/partner-names: track defaults to FL; FC is the other value; both give string arrays, sorted without regard to case", async () => {
    const names = (res: { body: Body }) => res.body.data as string[];
    const byDefault = await call("VIEWER", "GET", "/api/v1/vehicles/partner-names");
    const explicit = await call("VIEWER", "GET", "/api/v1/vehicles/partner-names?track=FL");
    expect(names(byDefault)).toEqual(names(explicit));
    expect(names(byDefault)).toEqual(["Partner One", "Partner Two"]); // Partner Two: an FC vehicle converted to local behaves as FL
    expect(names(await call("VIEWER", "GET", "/api/v1/vehicles/partner-names?track=FC"))).toEqual([]);
    for (const value of names(byDefault)) expect(typeof value).toBe("string");
  });

  it("GET /vehicles/partner-names: a soft-deleted vehicle's partner is not listed and neither is another organisation's", async () => {
    const row = (id: string) => fake.rows("vehicle").find((v) => v["id"] === id)!;
    row("v_fl_native")["deletedAt"] = new Date();
    expect(((await call("VIEWER", "GET", "/api/v1/vehicles/partner-names")).body.data as string[])).toEqual(["Partner Two"]);
    row("v_b_fc")["partnerName"] = "Other Org Partner";
    row("v_b_fc")["serialPrefix"] = "FL";
    expect(((await call("VIEWER", "GET", "/api/v1/vehicles/partner-names")).body.data as string[])).not.toContain("Other Org Partner");
  });
});

describe("the whole Shipment Timeline (G12)", () => {
  const steps = async (serial: string) => ((await call("VIEWER", "GET", `/api/v1/vehicles/${serial}/timeline`)).body.data as Array<{ key: string; label: string; completed: boolean; date: string | null }>);
  const vehicle = (id: string) => fake.rows("vehicle").find((v) => v["id"] === id)!;

  it("a finished container shipment to Sri Lanka has all nine steps, in order, all completed, with their labels", async () => {
    fake.seed("transportCompany", { id: "tc_1", org_id: "org_test_a", name: "Example Transport" });
    const past = new Date("2026-01-05T00:00:00Z");
    Object.assign(vehicle("v_fc_booked_future"), {
      auctionBillPaid: true, transportById: "tc_1", destination: "Sri Lanka", lcNo: "LC-1", etd: past, eta: new Date("2026-02-05T00:00:00Z"),
      shippingMethod: "CONTAINER", vanningDate: new Date("2026-01-03T00:00:00Z"),
    });
    const doc = (id: string, documentType: string) => ({ id, vehicleId: "v_fc_booked_future", url: "https://files.example.test/x.pdf", name: "x.pdf", documentType, uploadedById: "staff_mgr", createdAt: new Date("2026-01-02T00:00:00Z"), visibleToCustomer: false });
    fake.seed("vehicleDocument", doc("d_ec", "EC"), doc("d_in", "INSPECTION_REPORT"));
    const all = await steps("FC102");
    expect(all.map((s) => [s.key, s.label, s.completed])).toEqual([
      ["AUCTION_BILL_PAID", "Auction Bill Paid", true],
      ["TRANSPORT_ASSIGNED", "Rikso Given", true],
      ["EC_RECEIVED", "EC Received", true],
      ["INSPECTION_COMPLETED", "Inspection Completed", true],
      ["LC_OPEN", "LC Open", true],
      ["BOOKING_RECEIVED", "Booking Received", true],
      ["LOADED", "Loaded", true],
      ["SHIPPED", "Shipped", true],
      ["DELIVERED", "Delivered", true],
    ]);
    for (const step of all) expect(Object.keys(step).sort()).toEqual(["completed", "date", "key", "label"]);
  });

  it("an FL vehicle gets the steps derivable from its own fields (no ETD or ETA, so none of the shipping steps complete)", async () => {
    const fl = await steps("FL201");
    expect(fl.map((s) => s.key)).toEqual(["AUCTION_BILL_PAID", "TRANSPORT_ASSIGNED", "EC_RECEIVED", "BOOKING_RECEIVED", "SHIPPED", "DELIVERED"]);
    expect(fl.filter((s) => s.key === "BOOKING_RECEIVED" || s.key === "SHIPPED" || s.key === "DELIVERED").every((s) => !s.completed)).toBe(true);
  });

  it("an FL vehicle converted to export behaves as FC: its ETD makes Booking Received complete", async () => {
    const converted = await steps("FL202");
    expect(converted.find((s) => s.key === "BOOKING_RECEIVED")?.completed).toBe(true);
  });
});
