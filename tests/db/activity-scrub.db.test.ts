// The activity-log scrub on customer anonymisation, on REAL Postgres (jsonb columns, real transactions): only the five personal fields, only in before
// and after, only on rows about that customer, in the same transaction, one counts-only summary row; both paths (the customer deletes their account,
// the retention job removes a never-verified sign-up). Other customers', other organisations' and other entities' rows are never touched. Fake data only.

import bcrypt from "bcryptjs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { ORG_A, ORG_B, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});
const settings = vi.hoisted(() => ({ override: {} as Record<string, number | boolean> }));
const failDeleteRow = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...settings.override }) };
});
vi.mock("../../src/services/activity-log.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/activity-log.service.js")>();
  // the LAST write of the deletion fails, so the whole transaction (anonymisation AND scrub) must roll back
  return { ...actual, record: (tx: never, entry: { action: string }) => (failDeleteRow.on && entry.action === "CUSTOMER_DELETE_ACCOUNT" ? Promise.reject(new Error("log write failed")) : actual.record(tx, entry as never)) };
});

import { deleteCustomerAccount } from "../../src/services/customer-auth.service.js";
import { runRetention } from "../../src/services/retention.service.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const prisma = getTestPrisma();
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const PASSWORD = ["example", "Scrub", "Password", "12345"].join("-");
const P = "[removed]";
const personal = { name: "Alpha Buyer", email: "alpha@example.test", phone: "0771111111", address: "1 Example Road", companyName: "Alpha Ltd" };

const logRow = (id: string, over: Record<string, unknown>) =>
  prisma.activityLog.create({ data: { id, org_id: ORG_A, actorId: "admin_a", action: "UPDATE_CUSTOMER", entity: "User", entityId: "cust_1", before: { ...personal, country: "LK" }, after: { ...personal, country: "LK", phone: "0779999999" }, ...over } });
const row = (id: string) => prisma.activityLog.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  settings.override = { RETENTION_DRY_RUN: false };
  failDeleteRow.on = false;
  await resetDb(prisma);
  await seedTwoOrgs(prisma);
  const hash = await bcrypt.hash(PASSWORD, 4);
  await prisma.user.createMany({
    data: [
      { id: "admin_a", org_id: ORG_A, userType: "STAFF", name: "Administrator", role: "ADMINISTRATOR", loginEnabled: true, email: "admin.a@example.test" },
      { id: "admin_b", org_id: ORG_B, userType: "STAFF", name: "Administrator", role: "ADMINISTRATOR", loginEnabled: true, email: "admin.b@example.test" },
      { id: "cust_1", org_id: ORG_A, userType: "CUSTOMER", name: personal.name, email: personal.email, phone: personal.phone, address: personal.address, companyName: personal.companyName, password: hash, loginEnabled: true, emailVerifiedAt: ago(100) },
      { id: "cust_2", org_id: ORG_A, userType: "CUSTOMER", name: "Beta Buyer", email: "beta@example.test", emailVerifiedAt: ago(100) },
      { id: "cust_b", org_id: ORG_B, userType: "CUSTOMER", name: "Gamma Buyer", email: "gamma@example.test", emailVerifiedAt: ago(100) },
    ],
  });
});
afterAll(closeTestPrisma);

const deleteAccount = () => deleteCustomerAccount({ id: "cust_1", orgId: ORG_A }, { password: PASSWORD });

describe("the customer deletes their account", () => {
  it("scrubs the five personal fields in before AND after of their own rows (jsonb), keeps every other key, and anonymises the user", async () => {
    await logRow("edit", {});
    await logRow("create", { action: "CREATE_CUSTOMER", before: null, after: { id: "cust_1", ...personal, country: "LK", vehicleCount: 0 } });
    await logRow("own", { entity: "Customer", actorId: "cust_1", action: "CUSTOMER_UPDATE_PROFILE", before: null, after: { fields: ["phone"] } });
    await deleteAccount();
    expect((await row("edit")).before).toEqual({ name: P, email: P, phone: P, address: P, companyName: P, country: "LK" });
    expect((await row("edit")).after).toEqual({ name: P, email: P, phone: P, address: P, companyName: P, country: "LK" });
    expect((await row("create")).after).toEqual({ id: "cust_1", name: P, email: P, phone: P, address: P, companyName: P, country: "LK", vehicleCount: 0 });
    expect((await row("create")).before).toBeNull();
    expect((await row("own")).after).toEqual({ fields: ["phone"] });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: "cust_1" } });
    expect([user.name, user.email, user.deletedAt === null]).toEqual(["Deleted customer", null, false]);
    // the rest of each row is what it was
    const edit = await row("edit");
    expect([edit.action, edit.entity, edit.entityId, edit.actorId, edit.org_id]).toEqual(["UPDATE_CUSTOMER", "User", "cust_1", "admin_a", ORG_A]);
  });

  it("writes ONE counts-only summary row for the customer, next to the delete row", async () => {
    await logRow("edit", {});
    await deleteAccount();
    const summary = await prisma.activityLog.findMany({ where: { action: "CUSTOMER_ACTIVITY_SCRUBBED" } });
    expect(summary).toHaveLength(1);
    expect([summary[0]?.entity, summary[0]?.entityId, summary[0]?.actorId, summary[0]?.org_id]).toEqual(["Customer", "cust_1", "cust_1", ORG_A]);
    expect(summary[0]?.after).toEqual({ rowsScrubbed: 1, fieldsReplaced: 10 });
    expect(JSON.stringify(summary)).not.toMatch(/example\.test|0771|Alpha|Road/);
    expect(await prisma.activityLog.count({ where: { action: "CUSTOMER_DELETE_ACCOUNT", entityId: "cust_1" } })).toBe(1);
  });

  it("NEVER touches another customer's rows, another organisation's rows with the same entity id, or rows of other entities", async () => {
    await logRow("mine", {});
    await logRow("other_customer", { entityId: "cust_2" });
    await logRow("other_org", { org_id: ORG_B, actorId: "admin_b" });
    await logRow("other_entity", { entity: "Vehicle" });
    await logRow("staff_account", { entityId: "admin_a" });
    const before = Object.fromEntries(await Promise.all(["other_customer", "other_org", "other_entity", "staff_account"].map(async (id) => [id, JSON.stringify(await row(id))])));
    await deleteAccount();
    for (const id of Object.keys(before)) expect(JSON.stringify(await row(id)), id).toBe(before[id]);
    expect((await row("mine")).after).toMatchObject({ email: P });
    // the summary counts only the customer's own row (a wrong read would count the others even if the write skipped them)
    expect((await prisma.activityLog.findFirstOrThrow({ where: { action: "CUSTOMER_ACTIVITY_SCRUBBED" } })).after).toEqual({ rowsScrubbed: 1, fieldsReplaced: 10 });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: "cust_2" } })).toMatchObject({ email: "beta@example.test", deletedAt: null });
  });

  it("is ALL OR NOTHING with the anonymisation: if the transaction fails afterwards, nothing was scrubbed and the account is intact", async () => {
    await logRow("edit", {});
    failDeleteRow.on = true;
    await expect(deleteAccount()).rejects.toThrow("log write failed");
    expect((await row("edit")).after).toMatchObject({ email: personal.email, name: personal.name });
    expect(await prisma.activityLog.count({ where: { action: "CUSTOMER_ACTIVITY_SCRUBBED" } })).toBe(0);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: "cust_1" } })).toMatchObject({ email: personal.email, deletedAt: null });
  });

  it("a wrong password scrubs nothing", async () => {
    await logRow("edit", {});
    await expect(deleteCustomerAccount({ id: "cust_1", orgId: ORG_A }, { password: "wrong-example-password" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await row("edit")).after).toMatchObject({ email: personal.email });
    expect(await prisma.activityLog.count({ where: { action: "CUSTOMER_ACTIVITY_SCRUBBED" } })).toBe(0);
  });

  it("handles a customer with more rows than one page (500)", async () => {
    await prisma.activityLog.createMany({ data: Array.from({ length: 1203 }, (_, i) => ({ id: `bulk_${String(i).padStart(5, "0")}`, org_id: ORG_A, actorId: "admin_a", action: "UPDATE_CUSTOMER", entity: "User", entityId: "cust_1", after: { phone: `07${i}` } })) });
    await deleteAccount();
    expect(await prisma.activityLog.count({ where: { entityId: "cust_1", entity: "User", NOT: { after: { path: ["phone"], equals: P } } } })).toBe(0);
    const summary = await prisma.activityLog.findFirstOrThrow({ where: { action: "CUSTOMER_ACTIVITY_SCRUBBED" } });
    expect(summary.after).toEqual({ rowsScrubbed: 1203, fieldsReplaced: 1203 });
  });
});

describe("the retention job removes a never-verified sign-up", () => {
  const signup = async (id: string, org = ORG_A) => {
    await prisma.user.create({ data: { id, org_id: org, userType: "CUSTOMER", name: "Stale Visitor", email: `${id}@example.test`, createdAt: ago(40) } });
    await prisma.activityLog.create({ data: { org_id: org, actorId: id, action: "CUSTOMER_REGISTER", entity: "Customer", entityId: id, createdAt: ago(40) } });
  };

  it("scrubs the anonymised accounts' own rows, writes a summary row per account attributed to the administrator, and touches nobody else", async () => {
    await signup("stale_1");
    await signup("stale_2");
    await prisma.activityLog.createMany({
      data: [
        { id: "s1_edit", org_id: ORG_A, actorId: "admin_a", action: "UPDATE_CUSTOMER", entity: "User", entityId: "stale_1", after: { email: "stale_1@example.test", name: "Stale Visitor" } },
        { id: "s2_edit", org_id: ORG_A, actorId: "admin_a", action: "UPDATE_CUSTOMER", entity: "User", entityId: "stale_2", before: { phone: "123" } },
        { id: "kept_edit", org_id: ORG_A, actorId: "admin_a", action: "UPDATE_CUSTOMER", entity: "User", entityId: "cust_2", after: { email: "beta@example.test" } },
        { id: "other_org_edit", org_id: ORG_B, actorId: "admin_b", action: "UPDATE_CUSTOMER", entity: "User", entityId: "stale_1", after: { email: "stale_1@example.test" } },
      ],
    });
    const counts = await runRetention(ORG_A, NOW);
    expect(counts.unverifiedAccounts).toBe(2);
    expect((await row("s1_edit")).after).toEqual({ email: P, name: P });
    expect((await row("s2_edit")).before).toEqual({ phone: P });
    expect((await row("kept_edit")).after).toEqual({ email: "beta@example.test" });
    expect((await row("other_org_edit")).after).toEqual({ email: "stale_1@example.test" });
    const summary = await prisma.activityLog.findMany({ where: { action: "CUSTOMER_ACTIVITY_SCRUBBED" }, orderBy: { entityId: "asc" } });
    expect(summary.map((s) => [s.entityId, s.actorId, s.org_id])).toEqual([["stale_1", "admin_a", ORG_A], ["stale_2", "admin_a", ORG_A]]);
    expect(summary.map((s) => s.after)).toEqual([{ rowsScrubbed: 1, fieldsReplaced: 2 }, { rowsScrubbed: 1, fieldsReplaced: 1 }]);
    expect(JSON.stringify(summary)).not.toMatch(/example\.test|Stale Visitor/);
  });

  it("a DRY RUN scrubs nothing", async () => {
    settings.override = { RETENTION_DRY_RUN: true };
    await signup("stale_1");
    await prisma.activityLog.create({ data: { id: "s1_edit", org_id: ORG_A, actorId: "admin_a", action: "UPDATE_CUSTOMER", entity: "User", entityId: "stale_1", after: { email: "x@example.test" } } });
    const counts = await runRetention(ORG_A, NOW);
    expect([counts.dryRun, counts.unverifiedAccounts]).toEqual([true, 1]);
    expect((await row("s1_edit")).after).toEqual({ email: "x@example.test" });
    expect(await prisma.activityLog.count({ where: { action: "CUSTOMER_ACTIVITY_SCRUBBED" } })).toBe(0);
  });

  it("running it again changes nothing more", async () => {
    await signup("stale_1");
    await prisma.activityLog.create({ data: { id: "s1_edit", org_id: ORG_A, actorId: "admin_a", action: "UPDATE_CUSTOMER", entity: "User", entityId: "stale_1", after: { email: "x@example.test" } } });
    await runRetention(ORG_A, NOW);
    const first = JSON.stringify(await row("s1_edit"));
    const second = await runRetention(ORG_A, NOW);
    expect(second.unverifiedAccounts).toBe(0);
    expect(JSON.stringify(await row("s1_edit"))).toBe(first);
    expect(await prisma.activityLog.count({ where: { action: "CUSTOMER_ACTIVITY_SCRUBBED" } })).toBe(1);
  });
});
