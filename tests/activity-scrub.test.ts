// The activity-log scrub on customer anonymisation (ADR 0010; a DELIBERATE exception to "append-only"): ONLY the five personal fields
// (email, phone, name, address, companyName), ONLY in `before` and `after`, ONLY on rows about that customer (entity User or Customer, that entityId, that
// organisation), in the same transaction as the anonymisation, with one counts-only summary row per customer. Fake data only.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));

import { PERSONAL_FIELDS, SCRUBBED_PLACEHOLDER, scrubCustomerActivity, scrubPersonalFields } from "../src/services/activity-log.service.js";

let fake: FakePrisma;
type Row = Record<string, unknown>;
const log = (over: Row): Row => ({ id: `log_${Math.random().toString(36).slice(2, 10)}`, org_id: ORG_A, actorId: "staff_1", action: "UPDATE_CUSTOMER", entity: "User", entityId: "cust_1", before: null, after: null, createdAt: new Date(), ...over });
const rows = () => fake.rows("activityLog");
const byId = (id: string) => rows().find((r) => r["id"] === id) as Row;
const scrub = (customerIds: string[], orgId = ORG_A) =>
  (fake.client as unknown as { $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> }).$transaction((tx) => scrubCustomerActivity(tx, { orgId, customerIds, actorId: "staff_1" }));
const P = SCRUBBED_PLACEHOLDER;

beforeEach(() => {
  fake = createFakePrisma();
  state.fake = fake;
});

describe("scrubPersonalFields (pure)", () => {
  it("replaces exactly the five personal fields, whatever their value type, and counts them", () => {
    const input = { name: "Alpha Buyer", email: "a@example.test", phone: "0771111111", address: "1 Example Road", companyName: "Alpha Ltd", country: "LK", id: "cust_1" };
    const out = scrubPersonalFields(input);
    expect(out.value).toEqual({ name: P, email: P, phone: P, address: P, companyName: P, country: "LK", id: "cust_1" });
    expect(out.replaced).toBe(5);
    expect([...PERSONAL_FIELDS].sort()).toEqual(["address", "companyName", "email", "name", "phone"]);
  });

  it("leaves everything else alone: other keys, numbers, booleans, nested non-personal data", () => {
    const input = { country: "LK", loginEnabled: false, vehicleCount: 3, createdAt: "2026-01-01T00:00:00.000Z", note: null };
    expect(scrubPersonalFields(input)).toEqual({ value: input, replaced: 0 });
    expect(scrubPersonalFields(null)).toEqual({ value: null, replaced: 0 });
    expect(scrubPersonalFields("a string")).toEqual({ value: "a string", replaced: 0 });
    expect(scrubPersonalFields(42)).toEqual({ value: 42, replaced: 0 });
  });

  it("a personal field that is null is not a value to remove (not counted), and an already scrubbed one is not counted again", () => {
    expect(scrubPersonalFields({ email: null, phone: P })).toEqual({ value: { email: null, phone: P }, replaced: 0 });
  });

  it("finds the fields nested in objects and arrays, without changing the input", () => {
    const input = { snapshot: { customer: { name: "A", tags: [{ email: "x@example.test" }, { colour: "red" }] } }, list: [{ phone: "1" }] };
    const copy = JSON.parse(JSON.stringify(input));
    const out = scrubPersonalFields(input);
    expect(out.replaced).toBe(3);
    expect(out.value).toEqual({ snapshot: { customer: { name: P, tags: [{ email: P }, { colour: "red" }] } }, list: [{ phone: P }] });
    expect(input).toEqual(copy);
  });

  it("is idempotent", () => {
    const once = scrubPersonalFields({ email: "a@example.test", name: "A" });
    expect(scrubPersonalFields(once.value)).toEqual({ value: once.value, replaced: 0 });
  });
});

describe("scrubCustomerActivity", () => {
  it("replaces the personal fields in before and after of the customer's own rows, and keeps the rest of each row", async () => {
    fake.seed(
      "activityLog",
      log({ id: "upd", action: "UPDATE_CUSTOMER", before: { phone: "0771111111", name: "Alpha Buyer" }, after: { phone: "0779999999", name: "Alpha B." } }),
      log({ id: "crt", action: "CREATE_CUSTOMER", before: null, after: { id: "cust_1", name: "Alpha Buyer", email: "alpha@example.test", phone: "0771111111", country: "LK", address: "1 Example Road", vehicleCount: 0 } }),
      log({ id: "own", entity: "Customer", action: "CUSTOMER_UPDATE_PROFILE", after: { fields: ["phone"] } })
    );
    const counts = await scrub(["cust_1"]);
    expect(byId("upd")["before"]).toEqual({ phone: P, name: P });
    expect(byId("upd")["after"]).toEqual({ phone: P, name: P });
    expect(byId("crt")["after"]).toEqual({ id: "cust_1", name: P, email: P, phone: P, country: "LK", address: P, vehicleCount: 0 });
    expect(byId("crt")["before"]).toBeNull();
    expect(byId("own")["after"]).toEqual({ fields: ["phone"] }); // nothing personal: untouched
    for (const id of ["upd", "crt", "own"]) {
      const row = byId(id);
      expect([row["action"], row["entityId"], row["actorId"], row["org_id"]]).toEqual([id === "upd" ? "UPDATE_CUSTOMER" : id === "crt" ? "CREATE_CUSTOMER" : "CUSTOMER_UPDATE_PROFILE", "cust_1", "staff_1", ORG_A]);
    }
    expect(counts.get("cust_1")).toEqual({ rowsScrubbed: 2, fieldsReplaced: 8 });
  });

  it("NEVER touches another customer's rows, another organisation's rows with the same id, or rows of other entities with that id", async () => {
    const personal = { name: "Someone", email: "s@example.test", phone: "1", address: "x", companyName: "c" };
    fake.seed(
      "activityLog",
      log({ id: "mine", after: { ...personal } }),
      log({ id: "other_customer", entityId: "cust_2", after: { ...personal } }),
      log({ id: "other_org", org_id: ORG_B, entityId: "cust_1", after: { ...personal } }),
      log({ id: "vehicle_row", entity: "Vehicle", entityId: "cust_1", after: { ...personal } }),
      log({ id: "staff_row", entity: "User", entityId: "staff_9", after: { ...personal } })
    );
    await scrub(["cust_1"]);
    expect((byId("mine")["after"] as Row)["email"]).toBe(P);
    for (const id of ["other_customer", "other_org", "vehicle_row", "staff_row"]) expect(byId(id)["after"], id).toEqual(personal);
  });

  it("scrubs several customers in one call and counts each separately", async () => {
    fake.seed(
      "activityLog",
      log({ id: "a1", entityId: "cust_1", after: { email: "1@example.test" } }),
      log({ id: "a2", entityId: "cust_1", after: { name: "N", phone: "1" } }),
      log({ id: "b1", entityId: "cust_2", after: { address: "x" } }),
      log({ id: "c1", entityId: "cust_3", after: { country: "LK" } })
    );
    const counts = await scrub(["cust_1", "cust_2", "cust_3"]);
    expect(counts.get("cust_1")).toEqual({ rowsScrubbed: 2, fieldsReplaced: 3 });
    expect(counts.get("cust_2")).toEqual({ rowsScrubbed: 1, fieldsReplaced: 1 });
    expect(counts.get("cust_3")).toEqual({ rowsScrubbed: 0, fieldsReplaced: 0 });
  });

  it("writes ONE summary row per customer: action, entity Customer, the customer's id, counts only, attributed to the actor", async () => {
    fake.seed("activityLog", log({ id: "x", after: { email: "a@example.test", phone: "1" } }));
    await scrub(["cust_1", "cust_2"]);
    const summaries = rows().filter((r) => r["action"] === "CUSTOMER_ACTIVITY_SCRUBBED");
    expect(summaries).toHaveLength(2);
    const one = summaries.find((r) => r["entityId"] === "cust_1")!;
    expect([one["entity"], one["actorId"], one["org_id"]]).toEqual(["Customer", "staff_1", ORG_A]);
    expect(one["after"]).toEqual({ rowsScrubbed: 1, fieldsReplaced: 2 });
    expect(Object.keys(one["after"] as object).sort()).toEqual(["fieldsReplaced", "rowsScrubbed"]);
    expect(JSON.stringify(summaries)).not.toMatch(/example\.test|0771/);
    expect((summaries.find((r) => r["entityId"] === "cust_2")!["after"])).toEqual({ rowsScrubbed: 0, fieldsReplaced: 0 });
  });

  it("is safe to run twice: the second run changes nothing in the old rows (it adds its own summary row of zeros)", async () => {
    fake.seed("activityLog", log({ id: "x", after: { email: "a@example.test" } }));
    await scrub(["cust_1"]);
    const afterFirst = JSON.stringify(byId("x"));
    const second = await scrub(["cust_1"]);
    expect(JSON.stringify(byId("x"))).toBe(afterFirst);
    expect(second.get("cust_1")).toEqual({ rowsScrubbed: 0, fieldsReplaced: 0 });
  });

  it("handles more rows than one page (500) for one customer", async () => {
    fake.seed("activityLog", ...Array.from({ length: 1203 }, (_, i) => log({ id: `bulk_${String(i).padStart(5, "0")}`, after: { phone: `07${i}` } })));
    const counts = await scrub(["cust_1"]);
    expect(counts.get("cust_1")).toEqual({ rowsScrubbed: 1203, fieldsReplaced: 1203 });
    expect(rows().filter((r) => (r["after"] as Row | null)?.["phone"] === P)).toHaveLength(1203);
  });

  it("with no customer ids it does nothing and writes nothing", async () => {
    fake.seed("activityLog", log({ id: "x", after: { email: "a@example.test" } }));
    await scrub([]);
    expect(rows()).toHaveLength(1);
    expect((byId("x")["after"] as Row)["email"]).toBe("a@example.test");
  });
});
