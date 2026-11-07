// PATCH means "change only what I sent" (G5): an absent field is unchanged, an explicit null (or a blank string) clears a nullable field,
// tri-state flags keep null as "not entered", unknown fields are a 400, an empty body is a 400, another org's id is a 404, and the
// activity log names only the fields that changed. One block per PATCH route that edits a record with several fields.
// Fake data only.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { installFakeStorage, makeCtx, newContractWorld, removeFakeStorage, type Ctx } from "./helpers/staff-contract-examples.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const state = vi.hoisted(() => {
  process.env["R2_PUBLIC_URL"] = "https://files.example.test";
  return { fake: undefined as unknown };
});
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { buildApp } from "../src/app.js";
import { setTrustTokenClaimsForTests } from "../src/lib/staff-auth-seam.js";
import { clearStaffAuthCache } from "../src/services/staff-auth-state.service.js";

let app: FastifyInstance;
let fake: FakePrisma;
let ctx: Ctx;
type Row = Record<string, unknown>;

beforeAll(async () => {
  setTrustTokenClaimsForTests(false);
  installFakeStorage();
  state.fake = newContractWorld();
  app = await buildApp({ rateLimit: false, publicStockEnabled: true });
});
afterAll(async () => {
  await app.close();
  removeFakeStorage();
  setTrustTokenClaimsForTests(true);
});
beforeEach(() => {
  fake = newContractWorld();
  state.fake = fake;
  clearStaffAuthCache();
  ctx = makeCtx(app, fake);
});

const row = (model: string, id: string): Row => fake.rows(model).find((r) => r["id"] === id) as Row;
const lastLog = (action: string): { before: Row; after: Row } => {
  const logs = fake.rows("activityLog").filter((r) => r["action"] === action);
  expect(logs.length, `an activity-log row for ${action}`).toBeGreaterThan(0);
  return logs[logs.length - 1] as { before: Row; after: Row };
};
const seedOtherOrg = (model: string, data: Row) => fake.seed(model, data);

describe("PATCH /customers/:id", () => {
  const url = "/api/v1/customers/cust_1";

  it("a partial update keeps every field that was not sent", async () => {
    const before = { ...row("user", "cust_1") };
    const res = await ctx.call("MANAGER", "PATCH", url, { phone: "0779999999" });
    expect(res.status).toBe(200);
    const after = row("user", "cust_1");
    expect(after["phone"]).toBe("0779999999");
    for (const key of ["name", "email", "country", "address"]) expect(after[key], key).toBe(before[key]);
  });

  it("an explicit null, or a blank string, clears a nullable field; the name cannot be cleared", async () => {
    expect((await ctx.call("MANAGER", "PATCH", url, { phone: null, address: "  " })).status).toBe(200);
    expect(row("user", "cust_1")["phone"]).toBeNull();
    expect(row("user", "cust_1")["address"]).toBeNull();
    expect(row("user", "cust_1")["email"]).toBe("alpha.buyer@example.test");
    expect((await ctx.call("MANAGER", "PATCH", url, { name: null })).status).toBe(400);
    expect((await ctx.call("MANAGER", "PATCH", url, { name: "  " })).status).toBe(400);
  });

  it("rejects unknown fields and an empty body, and changes nothing", async () => {
    const before = JSON.stringify(row("user", "cust_1"));
    for (const body of [{ phone: "1", nickname: "x" }, { orgId: "org_other" }, { loginEnabled: true }, {}]) {
      const res = await ctx.call("MANAGER", "PATCH", url, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(JSON.stringify(row("user", "cust_1"))).toBe(before);
  });

  it("another org's customer is a 404 and nothing changes", async () => {
    seedOtherOrg("user", { id: "cust_other", org_id: "org_other", userType: "CUSTOMER", name: "Other Buyer", email: "other@example.test", phone: "1", country: null, address: null, createdAt: new Date() });
    const res = await ctx.call("MANAGER", "PATCH", "/api/v1/customers/cust_other", { phone: "2" });
    expect(res.status).toBe(404);
    expect(row("user", "cust_other")["phone"]).toBe("1");
  });

  it("the activity log records only the fields that changed", async () => {
    await ctx.call("MANAGER", "PATCH", url, { phone: "0779999999", name: "Alpha Buyer" /* same value */ });
    const log = lastLog("UPDATE_CUSTOMER");
    expect(log.before).toEqual({ phone: "0771111111" });
    expect(log.after).toEqual({ phone: "0779999999" });
  });
});

describe("PATCH /staff/:id", () => {
  const url = "/api/v1/staff/staff_op";

  it("a partial update keeps every field that was not sent (including the role, the active flag and the password)", async () => {
    const before = { ...row("user", "staff_op") };
    const res = await ctx.call("ADMINISTRATOR", "PATCH", url, { phone: "0775555555" });
    expect(res.status).toBe(200);
    const after = row("user", "staff_op");
    expect(after["phone"]).toBe("0775555555");
    for (const key of ["name", "email", "role", "loginEnabled", "password"]) expect(after[key], key).toBe(before[key]);
  });

  it("only the sent fields can change: a role change alone leaves the account active; deactivating alone keeps the role", async () => {
    expect((await ctx.call("ADMINISTRATOR", "PATCH", url, { role: "MANAGER" })).status).toBe(200);
    expect(row("user", "staff_op")["role"]).toBe("MANAGER");
    expect(row("user", "staff_op")["loginEnabled"]).toBe(true);
    expect((await ctx.call("ADMINISTRATOR", "PATCH", url, { active: false })).status).toBe(200);
    expect(row("user", "staff_op")["role"]).toBe("MANAGER");
    expect(row("user", "staff_op")["loginEnabled"]).toBe(false);
  });

  it("null clears the phone; a blank or null password leaves the password alone", async () => {
    const hash = row("user", "staff_op")["password"];
    expect((await ctx.call("ADMINISTRATOR", "PATCH", url, { phone: null, password: null })).status).toBe(200);
    expect(row("user", "staff_op")["phone"]).toBeNull();
    expect(row("user", "staff_op")["password"]).toBe(hash);
    expect((await ctx.call("ADMINISTRATOR", "PATCH", url, { phone: "1", password: "   " })).status).toBe(200);
    expect(row("user", "staff_op")["password"]).toBe(hash);
  });

  it("rejects unknown fields and an empty body, and changes nothing", async () => {
    const before = JSON.stringify(row("user", "staff_op"));
    for (const body of [{ phone: "1", isAdmin: true }, { orgId: "org_other" }, { userType: "CUSTOMER" }, {}, { name: null }, { role: "OWNER" }]) {
      expect((await ctx.call("ADMINISTRATOR", "PATCH", url, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(JSON.stringify(row("user", "staff_op"))).toBe(before);
  });

  it("another org's staff account is a 404", async () => {
    seedOtherOrg("user", { id: "staff_other", org_id: "org_other", userType: "STAFF", role: "OPERATOR", name: "Other Staff", email: "o@example.test", phone: "1", loginEnabled: true, createdAt: new Date() });
    expect((await ctx.call("ADMINISTRATOR", "PATCH", "/api/v1/staff/staff_other", { phone: "2" })).status).toBe(404);
    expect(row("user", "staff_other")["phone"]).toBe("1");
  });

  it("the activity log records only what changed, and never the password", async () => {
    await ctx.call("ADMINISTRATOR", "PATCH", url, { phone: "0775555555", role: "OPERATOR" /* same value */ });
    const log = lastLog("UPDATE_STAFF");
    expect(log.before).toEqual({ phone: "0770000000" });
    expect(log.after).toEqual({ phone: "0775555555" });
    await ctx.call("ADMINISTRATOR", "PATCH", url, { password: ["a", "much", "longer", "pass"].join("-") + "-9876" });
    const second = lastLog("UPDATE_STAFF");
    expect(second.after).toEqual({ passwordChanged: true });
    expect(JSON.stringify(second)).not.toMatch(/\$2[aby]\$/);
  });

  it("a role change alone still ends the person's sessions; a field that does not matter does not", async () => {
    const tokens = () => fake.rows("refreshToken").filter((r) => r["userId"] === "staff_op" && r["revokedAt"] == null).length;
    fake.seed("refreshToken", { id: "rt_x", org_id: "org_test_a", userId: "staff_op", tokenHash: "h1", expiresAt: new Date(Date.now() + 1e9), revokedAt: null, createdAt: new Date() });
    await ctx.call("ADMINISTRATOR", "PATCH", url, { phone: "1" });
    expect(tokens()).toBe(1);
    await ctx.call("ADMINISTRATOR", "PATCH", url, { role: "VIEWER" });
    expect(tokens()).toBe(0);
  });
});

describe("PATCH /profile", () => {
  it("a partial update keeps the other fields; null clears the phone; unknown fields and an empty body are 400", async () => {
    const before = { ...row("user", "staff_mgr") };
    expect((await ctx.call("MANAGER", "PATCH", "/api/v1/profile", { name: "Renamed Manager" })).status).toBe(200);
    const after = row("user", "staff_mgr");
    expect(after["name"]).toBe("Renamed Manager");
    expect([after["email"], after["phone"], after["role"]]).toEqual([before["email"], before["phone"], before["role"]]);
    expect((await ctx.call("MANAGER", "PATCH", "/api/v1/profile", { phone: null })).status).toBe(200);
    expect(row("user", "staff_mgr")["phone"]).toBeNull();
    for (const body of [{}, { role: "ADMINISTRATOR" }, { name: "x", extra: 1 }, { name: null }]) {
      expect((await ctx.call("MANAGER", "PATCH", "/api/v1/profile", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(row("user", "staff_mgr")["role"]).toBe("MANAGER");
  });

  it("the activity log records only what changed", async () => {
    await ctx.call("MANAGER", "PATCH", "/api/v1/profile", { name: "Renamed Manager", phone: "0770000000" /* same value */ });
    const log = lastLog("UPDATE_PROFILE");
    expect(log.before).toEqual({ name: "Example Manager" });
    expect(log.after).toEqual({ name: "Renamed Manager" });
  });
});

describe("the other multi-field PATCH routes already behave this way", () => {
  it("FAQs: only the sent fields change, unknown fields and an empty body are 400, another org's FAQ is 404", async () => {
    const before = { ...row("faq", "faq_1") };
    expect((await ctx.call("MANAGER", "PATCH", "/api/v1/faqs/faq_1", { published: false })).status).toBe(200);
    expect(row("faq", "faq_1")["published"]).toBe(false);
    expect([row("faq", "faq_1")["question"], row("faq", "faq_1")["answer"]]).toEqual([before["question"], before["answer"]]);
    for (const body of [{}, { published: false, extra: 1 }]) expect((await ctx.call("MANAGER", "PATCH", "/api/v1/faqs/faq_1", body)).status).toBe(400);
    seedOtherOrg("faq", { id: "faq_other", org_id: "org_other", question: "Q", answer: "A", sortOrder: 1, published: true, createdAt: new Date(), updatedAt: new Date() });
    expect((await ctx.call("MANAGER", "PATCH", "/api/v1/faqs/faq_other", { published: false })).status).toBe(404);
  });

  it("stock: only the sent fields change; null clears an optional field; unknown fields and an empty body are 400; another org is 404", async () => {
    const before = { ...row("stockVehicle", "stock_1") };
    expect((await ctx.call("MANAGER", "PATCH", "/api/v1/stock/stock_1", { price: 1450000 })).status).toBe(200);
    expect(row("stockVehicle", "stock_1")["priceFob"]).toBe(1450000);
    for (const key of ["make", "model", "year", "colour", "description"]) expect(row("stockVehicle", "stock_1")[key], key).toBe(before[key]);
    expect((await ctx.call("MANAGER", "PATCH", "/api/v1/stock/stock_1", { description: null })).status).toBe(200);
    expect(row("stockVehicle", "stock_1")["description"]).toBeNull();
    expect(row("stockVehicle", "stock_1")["colour"]).toBe(before["colour"]);
    for (const body of [{}, { price: 1, extra: 1 }, { slug: "mine" }]) expect((await ctx.call("MANAGER", "PATCH", "/api/v1/stock/stock_1", body)).status, JSON.stringify(body)).toBe(400);
    seedOtherOrg("stockVehicle", { id: "stock_other", org_id: "org_other", slug: "x-1", make: "X", model: "Y", year: 2020, priceFob: 1, status: "DRAFT", createdAt: new Date(), updatedAt: new Date() });
    expect((await ctx.call("MANAGER", "PATCH", "/api/v1/stock/stock_other", { price: 2 })).status).toBe(404);
  });

  it("vehicle customer-info: only the sent fields change, null clears, unknown fields and an empty body are 400", async () => {
    const url = "/api/v1/vehicles/v_fc_booked_future/customer-info";
    expect((await ctx.call("MANAGER", "PATCH", url, { portOfLoading: "Port One", voyageNo: "V1" })).status).toBe(200);
    expect((await ctx.call("MANAGER", "PATCH", url, { voyageNo: null })).status).toBe(200);
    const v = row("vehicle", "v_fc_booked_future");
    expect([v["portOfLoading"], v["voyageNo"]]).toEqual(["Port One", null]);
    for (const body of [{}, { voyageNo: "x", extra: 1 }]) expect((await ctx.call("MANAGER", "PATCH", url, body)).status).toBe(400);
  });

  it("tri-state flags keep null as 'not entered': the auction-bill PATCH needs the key, and null is stored as null, never false", async () => {
    const url = "/api/v1/vehicles/v_fc_pending/auction-bill-paid";
    expect((await ctx.call("OPERATOR", "PATCH", url, {})).status).toBe(400);
    expect((await ctx.call("OPERATOR", "PATCH", url, { auctionBillPaid: true })).status).toBe(200);
    expect((await ctx.call("OPERATOR", "PATCH", url, { auctionBillPaid: null })).status).toBe(200);
    expect(row("vehicle", "v_fc_pending")["auctionBillPaid"]).toBeNull();
  });
});
