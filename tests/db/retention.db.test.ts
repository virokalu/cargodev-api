// Retention against real Postgres: what the daily job removes, what it must keep, the 1000-row batch, idempotence, org
// scoping, the counts-only summary row, and the exact cut-off days. Fake data only.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { minimalVehicle, ORG_A, ORG_B, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

const failLog = vi.hoisted(() => ({ on: false }));
const settings = vi.hoisted(() => ({ override: {} as Record<string, number | boolean> }));
vi.mock("../../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...settings.override }) };
});
vi.mock("../../src/services/activity-log.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/activity-log.service.js")>();
  return { ...actual, record: (tx: never, entry: never) => (failLog.on ? Promise.reject(new Error("log write failed")) : actual.record(tx, entry)) };
});

import { runRetention } from "../../src/services/retention.service.js";

const prisma = getTestPrisma();
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);

const run = (org = ORG_A) => runRetention(org, NOW);
const summaryRows = (org = ORG_A) => prisma.activityLog.findMany({ where: { org_id: org, action: "RETENTION_CLEANUP" }, orderBy: { createdAt: "asc" } });

beforeEach(async () => {
  settings.override = { RETENTION_DRY_RUN: false };
  await resetDb(prisma);
  await seedTwoOrgs(prisma);
  await prisma.user.createMany({
    data: [
      { id: "admin_a", org_id: ORG_A, userType: "STAFF", name: "Administrator", role: "ADMINISTRATOR", loginEnabled: true, email: "admin.a@example.test" },
      { id: "admin_b", org_id: ORG_B, userType: "STAFF", name: "Administrator", role: "ADMINISTRATOR", loginEnabled: true, email: "admin.b@example.test" },
      { id: "cust_a", org_id: ORG_A, userType: "CUSTOMER", name: "Buyer A", email: "buyer.a@example.test", emailVerifiedAt: ago(100) },
      { id: "cust_b", org_id: ORG_B, userType: "CUSTOMER", name: "Buyer B", email: "buyer.b@example.test", emailVerifiedAt: ago(100) },
    ],
  });
});
afterAll(async () => {
  await closeTestPrisma();
});

const otp = (id: string, org: string, userId: string, expiresAt: Date) =>
  prisma.otpCode.create({ data: { id, org_id: org, userId, purpose: "VERIFY_EMAIL", codeHash: "h", expiresAt } });
const ids = async (rows: Promise<Array<{ id: string }>>) => (await rows).map((r) => r.id).sort();

describe("one-time codes", () => {
  it("removes codes expired more than RETENTION_OTP_DAYS (30) ago and keeps the rest", async () => {
    await otp("old", ORG_A, "cust_a", ago(31));
    await otp("edge_deleted", ORG_A, "cust_a", ago(30, 1000)); // 30 days and one second
    await otp("edge_kept", ORG_A, "cust_a", ago(30, -1000)); // 30 days less one second
    await otp("recent_expired", ORG_A, "cust_a", ago(29));
    await otp("live", ORG_A, "cust_a", new Date(NOW.getTime() + 60_000));
    const counts = await run();
    expect(counts.otpCodes).toBe(2);
    expect(await ids(prisma.otpCode.findMany({ select: { id: true } }))).toEqual(["edge_kept", "live", "recent_expired"]);
  });

  it("never touches another org's codes", async () => {
    await otp("a_old", ORG_A, "cust_a", ago(60));
    await otp("b_old", ORG_B, "cust_b", ago(60));
    await run(ORG_A);
    expect(await ids(prisma.otpCode.findMany({ select: { id: true } }))).toEqual(["b_old"]);
  });
});

describe("sessions (customer and staff)", () => {
  async function seedSessions() {
    const mk = (id: string, expiresAt: Date, revokedAt: Date | null, tokenHash = id) => ({ id, org_id: ORG_A, userId: "cust_a", tokenHash, expiresAt, revokedAt });
    await prisma.customerSession.createMany({
      data: [
        mk("cs_expired_old", ago(31), null),
        mk("cs_expired_recent", ago(29), null),
        mk("cs_revoked_old", ago(-100), ago(31)), // revoked long ago, would not have expired for 100 days
        mk("cs_revoked_recent", ago(-100), ago(29)),
        mk("cs_live", ago(-100), null),
        mk("cs_edge_deleted", ago(30, 1000), null),
        mk("cs_edge_kept", ago(30, -1000), null),
      ],
    });
    await prisma.refreshToken.createMany({
      data: [
        { id: "rt_expired_old", org_id: ORG_A, userId: "admin_a", tokenHash: "t1", expiresAt: ago(31), revokedAt: null },
        { id: "rt_expired_recent", org_id: ORG_A, userId: "admin_a", tokenHash: "t2", expiresAt: ago(29), revokedAt: null },
        { id: "rt_revoked_old", org_id: ORG_A, userId: "admin_a", tokenHash: "t3", expiresAt: ago(-100), revokedAt: ago(31) },
        { id: "rt_revoked_recent", org_id: ORG_A, userId: "admin_a", tokenHash: "t4", expiresAt: ago(-100), revokedAt: ago(29) },
        { id: "rt_live", org_id: ORG_A, userId: "admin_a", tokenHash: "t5", expiresAt: ago(-100), revokedAt: null },
        { id: "rt_other_org_old", org_id: ORG_B, userId: "admin_b", tokenHash: "t6", expiresAt: ago(90), revokedAt: null },
      ],
    });
  }

  it("removes sessions expired or revoked more than RETENTION_SESSION_DAYS (30) ago, from both tables", async () => {
    await seedSessions();
    const counts = await run();
    expect(counts.customerSessions).toBe(3);
    expect(counts.refreshTokens).toBe(2);
    expect(await ids(prisma.customerSession.findMany({ select: { id: true } }))).toEqual(["cs_edge_kept", "cs_expired_recent", "cs_live", "cs_revoked_recent"]);
    expect(await ids(prisma.refreshToken.findMany({ select: { id: true } }))).toEqual(["rt_expired_recent", "rt_live", "rt_other_org_old", "rt_revoked_recent"]);
  });
});

describe("customer alerts", () => {
  it("removes READ customer alerts older than RETENTION_ALERT_DAYS (180); keeps unread, newer, staff and other orgs'", async () => {
    const n = (id: string, over: Record<string, unknown>) => ({ id, org_id: ORG_A, userId: "cust_a", event: "E", title: "t", body: "b", isRead: true, createdAt: ago(200), ...over });
    await prisma.notification.createMany({
      data: [
        n("read_old", {}),
        n("read_edge_deleted", { createdAt: ago(180, 1000) }),
        n("read_edge_kept", { createdAt: ago(180, -1000) }),
        n("read_recent", { createdAt: ago(179) }),
        n("unread_old", { isRead: false, createdAt: ago(400) }),
        n("staff_read_old", { userId: "admin_a", createdAt: ago(400) }),
        n("other_org_read_old", { org_id: ORG_B, userId: "cust_b", createdAt: ago(400) }),
      ],
    });
    const counts = await run();
    expect(counts.readAlerts).toBe(2);
    expect(await ids(prisma.notification.findMany({ select: { id: true } }))).toEqual(["other_org_read_old", "read_edge_kept", "read_recent", "staff_read_old", "unread_old"]);
  });
});

describe("never-verified self-registered customers", () => {
  const person = (id: string, over: Record<string, unknown> = {}) => ({
    id, org_id: ORG_A, userType: "CUSTOMER" as const, name: `Person ${id}`, email: `${id}@example.test`, phone: "0000", companyName: "Co", country: "LK",
    emailVerifiedAt: null, createdAt: ago(15), ...over,
  });
  const registered = (id: string, org = ORG_A) => prisma.activityLog.create({ data: { org_id: org, actorId: id, action: "CUSTOMER_REGISTER", entity: "Customer", entityId: id, createdAt: ago(15) } });

  it("anonymises one that is unverified after UNVERIFIED_ACCOUNT_DAYS (14) with nothing linked, and removes its codes and sessions", async () => {
    await prisma.user.create({ data: person("stale") });
    await registered("stale");
    await otp("stale_otp", ORG_A, "stale", ago(-1));
    await prisma.customerSession.create({ data: { id: "stale_cs", org_id: ORG_A, userId: "stale", tokenHash: "stale_t", expiresAt: ago(-5) } });

    const counts = await run();
    expect(counts.unverifiedAccounts).toBe(1);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: "stale" } });
    expect(row).toMatchObject({ name: "Deleted customer", email: null, phone: null, companyName: null, country: null, password: null, loginEnabled: false });
    expect(row.deletedAt).not.toBeNull();
    expect(await prisma.otpCode.count({ where: { userId: "stale" } })).toBe(0);
    expect(await prisma.customerSession.count({ where: { userId: "stale" } })).toBe(0);
    // The audit trail still points at the (anonymous) row.
    expect(await prisma.activityLog.count({ where: { actorId: "stale", action: "CUSTOMER_REGISTER" } })).toBe(1);
  });

  it("keeps everything it must keep", async () => {
    await prisma.user.createMany({
      data: [
        person("young", { createdAt: ago(13) }), // not old enough
        person("edge_deleted", { createdAt: ago(14, 1000) }),
        person("edge_kept", { createdAt: ago(14, -1000) }),
        person("verified", { emailVerifiedAt: ago(10) }),
        person("staff_made"), // no CUSTOMER_REGISTER row: created by staff
        person("has_vehicle"),
        person("has_chat"),
        person("has_request"),
        person("other_org", { org_id: ORG_B }),
        person("already_gone", { deletedAt: ago(3), name: "Deleted customer", email: null }),
      ],
    });
    for (const id of ["young", "edge_deleted", "edge_kept", "verified", "has_vehicle", "has_chat", "has_request", "already_gone"]) await registered(id);
    await registered("other_org", ORG_B);
    const vehicle = await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 1, { customerId: "has_vehicle" }) });
    await prisma.conversation.create({ data: { org_id: ORG_A, customerId: "has_chat" } });
    await prisma.vehicleLinkRequest.create({ data: { org_id: ORG_A, customerId: "has_request", serialEntered: "FC1", status: "REJECTED" } });

    const counts = await run();
    expect(counts.unverifiedAccounts).toBe(1); // only edge_deleted
    const gone = (await prisma.user.findMany({ where: { name: "Deleted customer", deletedAt: { not: null } }, select: { id: true } })).map((u) => u.id).sort();
    expect(gone).toEqual(["already_gone", "edge_deleted"]);
    const untouched = await prisma.user.findMany({ where: { id: { in: ["young", "edge_kept", "verified", "staff_made", "has_vehicle", "has_chat", "has_request", "other_org"] } }, select: { email: true } });
    expect(untouched.every((u) => u.email !== null)).toBe(true);
    expect(await prisma.vehicle.count({ where: { id: vehicle.id, customerId: "has_vehicle" } })).toBe(1);
  });

  it("never touches a staff account, whatever its age", async () => {
    await prisma.user.update({ where: { id: "admin_a" }, data: { createdAt: ago(900) } });
    await registered("admin_a");
    await run();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "admin_a" } })).deletedAt).toBeNull();
  });
});

describe("what it must NOT delete: chats and enquiries", () => {
  it("keeps an old conversation, its messages and an old enquiry", async () => {
    const conversation = await prisma.conversation.create({ data: { org_id: ORG_A, customerId: "cust_a", createdAt: ago(2000), lastMessageAt: ago(2000) } });
    await prisma.message.create({ data: { org_id: ORG_A, conversationId: conversation.id, senderType: "CUSTOMER", senderId: "cust_a", body: "hello", createdAt: ago(2000) } });
    await prisma.enquiry.create({ data: { org_id: ORG_A, name: "Visitor", email: "visitor@example.test", message: "hi", createdAt: ago(2000) } });
    // ...while the same run really does remove a stale sign-up (so the account step runs to its end).
    await prisma.user.create({ data: { id: "stale_signup", org_id: ORG_A, userType: "CUSTOMER", name: "Stale", email: "stale@example.test", createdAt: ago(40) } });
    await prisma.activityLog.create({ data: { org_id: ORG_A, actorId: "stale_signup", action: "CUSTOMER_REGISTER", entity: "Customer", entityId: "stale_signup", createdAt: ago(40) } });
    expect((await run()).unverifiedAccounts).toBe(1);
    expect(await prisma.conversation.count()).toBe(1);
    expect(await prisma.message.count()).toBe(1);
    expect(await prisma.enquiry.count()).toBe(1);
  });
});

describe("batches, idempotence and the summary row", () => {
  it("removes at most 1000 rows per table per run and finishes over the next runs", async () => {
    await prisma.otpCode.createMany({ data: Array.from({ length: 1005 }, (_, i) => ({ id: `otp_${i}`, org_id: ORG_A, userId: "cust_a", purpose: "VERIFY_EMAIL" as const, codeHash: "h", expiresAt: ago(40) })) });
    expect((await run()).otpCodes).toBe(1000);
    expect(await prisma.otpCode.count()).toBe(5);
    expect((await run()).otpCodes).toBe(5);
    expect((await run()).otpCodes).toBe(0);
    expect(await prisma.otpCode.count()).toBe(0);
  });

  it("a second run right after the first removes nothing and writes no second summary row (idempotent)", async () => {
    await otp("o1", ORG_A, "cust_a", ago(40));
    await run();
    const second = await run();
    expect([second.otpCodes, second.customerSessions, second.refreshTokens, second.readAlerts, second.unverifiedAccounts, second.skipped]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await summaryRows()).toHaveLength(1);
  });

  it("writes ONE summary row per run with counts only (no ids, names or emails), attributed to the org's administrator", async () => {
    await otp("o1", ORG_A, "cust_a", ago(40));
    await otp("o2", ORG_A, "cust_a", ago(41));
    await prisma.customerSession.create({ data: { id: "cs1", org_id: ORG_A, userId: "cust_a", tokenHash: "x", expiresAt: ago(40) } });
    await run();
    const rows = await summaryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: "admin_a", entity: "Retention", entityId: ORG_A });
    expect(rows[0]?.after).toEqual({ otpCodes: 2, customerSessions: 1, refreshTokens: 0, readAlerts: 0, unverifiedAccounts: 0, automated: true });
    expect(JSON.stringify(rows[0])).not.toMatch(/example\.test|cust_a|Buyer/);
  });

  it("no row at all when nothing was removed", async () => {
    await run();
    expect(await summaryRows()).toHaveLength(0);
  });

  it("an org with no administrator is skipped: nothing is removed (a change that cannot be logged is not made)", async () => {
    await prisma.user.update({ where: { id: "admin_a" }, data: { role: "MANAGER" } });
    await otp("o1", ORG_A, "cust_a", ago(40));
    const result = await run();
    expect(result.skipped).toBe(1);
    expect(await prisma.otpCode.count()).toBe(1);
  });

  it("the removals and the summary row are one transaction: a failure to write the row rolls the deletions back", async () => {
    await otp("o1", ORG_A, "cust_a", ago(40));
    failLog.on = true;
    try {
      await expect(run()).rejects.toThrow("log write failed");
    } finally {
      failLog.on = false;
    }
    expect(await prisma.otpCode.count()).toBe(1);
    expect((await run()).otpCodes).toBe(1); // and the next run removes it
  });
});

// ---------------------------------------------------------------------------------------------
describe("each setting drives its own table", () => {
  it("uses RETENTION_OTP_DAYS, RETENTION_SESSION_DAYS, RETENTION_ALERT_DAYS and UNVERIFIED_ACCOUNT_DAYS separately", async () => {
    settings.override = { RETENTION_DRY_RUN: false, RETENTION_OTP_DAYS: 7, RETENTION_SESSION_DAYS: 11, RETENTION_ALERT_DAYS: 21, UNVERIFIED_ACCOUNT_DAYS: 3 };
    await otp("otp_8d", ORG_A, "cust_a", ago(8)); // older than 7: gone
    await otp("otp_6d", ORG_A, "cust_a", ago(6)); // kept
    await prisma.customerSession.createMany({
      data: [
        { id: "cs_12d", org_id: ORG_A, userId: "cust_a", tokenHash: "s1", expiresAt: ago(12) }, // older than 11: gone
        { id: "cs_10d", org_id: ORG_A, userId: "cust_a", tokenHash: "s2", expiresAt: ago(10) }, // kept
      ],
    });
    const n = (id: string, days: number) => ({ id, org_id: ORG_A, userId: "cust_a", event: "E", title: "t", body: "b", isRead: true, createdAt: ago(days) });
    await prisma.notification.createMany({ data: [n("al_22d", 22), n("al_20d", 20)] });
    await prisma.user.createMany({
      data: [
        { id: "su_4d", org_id: ORG_A, userType: "CUSTOMER", name: "S4", email: "s4@example.test", createdAt: ago(4) },
        { id: "su_2d", org_id: ORG_A, userType: "CUSTOMER", name: "S2", email: "s2@example.test", createdAt: ago(2) },
      ],
    });
    for (const id of ["su_4d", "su_2d"]) await prisma.activityLog.create({ data: { org_id: ORG_A, actorId: id, action: "CUSTOMER_REGISTER", entity: "Customer", entityId: id, createdAt: ago(5) } });

    await run();
    expect(await ids(prisma.otpCode.findMany({ select: { id: true } }))).toEqual(["otp_6d"]);
    expect(await ids(prisma.customerSession.findMany({ select: { id: true } }))).toEqual(["cs_10d"]);
    expect(await ids(prisma.notification.findMany({ select: { id: true } }))).toEqual(["al_20d"]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "su_4d" } })).deletedAt).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "su_2d" } })).deletedAt).toBeNull();
  });

  it("a row exactly at the cut-off is kept (older than, not as old as)", async () => {
    await otp("otp_exact", ORG_A, "cust_a", ago(30));
    await prisma.customerSession.create({ data: { id: "cs_exact", org_id: ORG_A, userId: "cust_a", tokenHash: "e1", expiresAt: ago(30) } });
    await prisma.notification.create({ data: { id: "al_exact", org_id: ORG_A, userId: "cust_a", event: "E", title: "t", body: "b", isRead: true, createdAt: ago(180) } });
    await prisma.user.create({ data: { id: "su_exact", org_id: ORG_A, userType: "CUSTOMER", name: "Exact", email: "exact@example.test", createdAt: ago(14) } });
    await prisma.activityLog.create({ data: { org_id: ORG_A, actorId: "su_exact", action: "CUSTOMER_REGISTER", entity: "Customer", entityId: "su_exact", createdAt: ago(14) } });
    const counts = await run();
    expect(counts).toMatchObject({ otpCodes: 0, customerSessions: 0, readAlerts: 0, unverifiedAccounts: 0 });
  });
});

describe("another org's rows never use up this org's batch", () => {
  it("one-time codes", async () => {
    await prisma.otpCode.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `b_otp_${i}`, org_id: ORG_B, userId: "cust_b", purpose: "VERIFY_EMAIL" as const, codeHash: "h", expiresAt: ago(90, i) })) });
    await otp("a_otp", ORG_A, "cust_a", ago(40));
    expect((await run(ORG_A)).otpCodes).toBe(1);
    expect(await prisma.otpCode.count({ where: { org_id: ORG_B } })).toBe(1000);
  });

  it("customer sessions", async () => {
    await prisma.customerSession.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `b_cs_${i}`, org_id: ORG_B, userId: "cust_b", tokenHash: `b_t_${i}`, expiresAt: ago(90), createdAt: ago(100, i) })) });
    await prisma.customerSession.create({ data: { id: "a_cs", org_id: ORG_A, userId: "cust_a", tokenHash: "a_t", expiresAt: ago(40) } });
    expect((await run(ORG_A)).customerSessions).toBe(1);
  });

  it("read alerts", async () => {
    const base = { event: "E", title: "t", body: "b", isRead: true };
    await prisma.notification.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ ...base, id: `b_al_${i}`, org_id: ORG_B, userId: "cust_b", createdAt: ago(400, i) })) });
    await prisma.notification.create({ data: { ...base, id: "a_al", org_id: ORG_A, userId: "cust_a", createdAt: ago(200) } });
    expect((await run(ORG_A)).readAlerts).toBe(1);
  });

  it("unverified accounts", async () => {
    await prisma.user.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `b_u_${i}`, org_id: ORG_B, userType: "CUSTOMER" as const, name: "B", email: `b${i}@example.test`, createdAt: ago(100, i) })) });
    await prisma.activityLog.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ org_id: ORG_B, actorId: `b_u_${i}`, action: "CUSTOMER_REGISTER", entity: "Customer", entityId: `b_u_${i}`, createdAt: ago(100) })) });
    await prisma.user.create({ data: { id: "a_u", org_id: ORG_A, userType: "CUSTOMER", name: "A", email: "a.u@example.test", createdAt: ago(20) } });
    await prisma.activityLog.create({ data: { org_id: ORG_A, actorId: "a_u", action: "CUSTOMER_REGISTER", entity: "Customer", entityId: "a_u", createdAt: ago(20) } });
    expect((await run(ORG_A)).unverifiedAccounts).toBe(1);
  });
});

describe("accounts that must not be selected lose nothing else either", () => {
  const register = (id: string) => prisma.activityLog.create({ data: { org_id: ORG_A, actorId: id, action: "CUSTOMER_REGISTER", entity: "Customer", entityId: id, createdAt: ago(300) } });
  const device = (id: string, userId: string) => prisma.deviceToken.create({ data: { id, org_id: ORG_A, userId, expoPushToken: `ExponentPushToken[${id}]`, platform: "ios" } });
  const alert = (id: string, userId: string) => prisma.notification.create({ data: { id, org_id: ORG_A, userId, event: "E", title: "t", body: "b", isRead: false } });

  it("a staff member, a verified customer and an already-removed customer keep their sessions, devices and alerts", async () => {
    await prisma.user.update({ where: { id: "admin_a" }, data: { createdAt: ago(300) } });
    await prisma.user.update({ where: { id: "cust_a" }, data: { createdAt: ago(300) } }); // verified in beforeEach
    await prisma.user.create({ data: { id: "gone", org_id: ORG_A, userType: "CUSTOMER", name: "Deleted customer", email: null, emailVerifiedAt: null, deletedAt: ago(5), createdAt: ago(300) } });
    for (const id of ["admin_a", "cust_a", "gone"]) {
      await register(id);
      await device(`dev_${id}`, id);
      await alert(`al_${id}`, id);
    }
    await prisma.customerSession.createMany({ data: [{ id: "cs_cust_a", org_id: ORG_A, userId: "cust_a", tokenHash: "k1", expiresAt: ago(-50) }, { id: "cs_gone", org_id: ORG_A, userId: "gone", tokenHash: "k2", expiresAt: ago(-50) }] });

    const counts = await run();
    expect(counts.unverifiedAccounts).toBe(0);
    expect(await prisma.deviceToken.count()).toBe(3);
    expect(await prisma.notification.count()).toBe(3);
    expect(await prisma.customerSession.count()).toBe(2);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "cust_a" } })).email).toBe("buyer.a@example.test");
  });
});

// ---------------------------------------------------------------------------------------------
describe("dry run (the default): count and log, remove nothing", () => {
  async function seedOneOfEach() {
    await otp("old_otp", ORG_A, "cust_a", ago(40));
    await prisma.customerSession.create({ data: { id: "old_cs", org_id: ORG_A, userId: "cust_a", tokenHash: "d1", expiresAt: ago(40) } });
    await prisma.refreshToken.create({ data: { id: "old_rt", org_id: ORG_A, userId: "admin_a", tokenHash: "d2", expiresAt: ago(40) } });
    await prisma.notification.create({ data: { id: "old_al", org_id: ORG_A, userId: "cust_a", event: "E", title: "t", body: "b", isRead: true, createdAt: ago(200) } });
    await prisma.user.create({ data: { id: "old_su", org_id: ORG_A, userType: "CUSTOMER", name: "Stale", email: "stale@example.test", createdAt: ago(40) } });
    await prisma.activityLog.create({ data: { org_id: ORG_A, actorId: "old_su", action: "CUSTOMER_REGISTER", entity: "Customer", entityId: "old_su", createdAt: ago(40) } });
  }
  const everything = async () => ({
    otp: await prisma.otpCode.count(),
    cs: await prisma.customerSession.count(),
    rt: await prisma.refreshToken.count(),
    al: await prisma.notification.count(),
    stale: (await prisma.user.findUniqueOrThrow({ where: { id: "old_su" } })).email,
    logs: await prisma.activityLog.count(),
  });

  it("with RETENTION_DRY_RUN unset the job removes NOTHING, writes no summary row, and still reports what it would remove", async () => {
    settings.override = {}; // the real default
    await seedOneOfEach();
    const before = await everything();
    const result = await run();
    expect(result).toMatchObject({ otpCodes: 1, customerSessions: 1, refreshTokens: 1, readAlerts: 1, unverifiedAccounts: 1, dryRun: true });
    expect(await everything()).toEqual(before);
    expect(await summaryRows()).toHaveLength(0);
  });

  it("with RETENTION_DRY_RUN=true likewise", async () => {
    settings.override = { RETENTION_DRY_RUN: true };
    await seedOneOfEach();
    const before = await everything();
    expect((await run()).dryRun).toBe(true);
    expect(await everything()).toEqual(before);
  });

  it("a dry run needs no administrator and still counts", async () => {
    settings.override = { RETENTION_DRY_RUN: true };
    await prisma.user.update({ where: { id: "admin_a" }, data: { role: "MANAGER" } });
    await otp("o1", ORG_A, "cust_a", ago(40));
    expect(await run()).toMatchObject({ otpCodes: 1, skipped: 0, dryRun: true });
  });

  it("switching it off (RETENTION_DRY_RUN=false) removes exactly what the dry run counted", async () => {
    settings.override = { RETENTION_DRY_RUN: true };
    await seedOneOfEach();
    const dry = await run();
    settings.override = { RETENTION_DRY_RUN: false };
    const real = await run();
    expect({ ...real, dryRun: dry.dryRun }).toEqual({ ...dry, dryRun: dry.dryRun });
    expect(real.dryRun).toBe(false);
    expect(await prisma.otpCode.count()).toBe(0);
    expect(await summaryRows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("how a customer counts as self-registered, and as owning something", () => {
  const stale = (id: string, extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { id, org_id: ORG_A, userType: "CUSTOMER", name: `Person ${id}`, email: `${id}@example.test`, createdAt: ago(100), emailVerifiedAt: null, password: null, ...extra } as never });

  it("a customer a STAFF member created (no vehicle, never verified, no password) is NOT touched: only a registration record counts", async () => {
    // What createCustomerFull writes: a CREATE_CUSTOMER row by the staff member, never CUSTOMER_REGISTER.
    for (const id of ["made_1", "made_2"]) {
      await stale(id);
      await prisma.activityLog.create({ data: { org_id: ORG_A, actorId: "admin_a", action: "CREATE_CUSTOMER", entity: "User", entityId: id, createdAt: ago(100) } });
    }
    await stale("made_no_log"); // an older row with no log at all
    const result = await run();
    expect(result.unverifiedAccounts).toBe(0);
    const rows = await prisma.user.findMany({ where: { id: { in: ["made_1", "made_2", "made_no_log"] } }, select: { email: true, deletedAt: true } });
    expect(rows.every((r) => r.email !== null && r.deletedAt === null)).toBe(true);
  });

  it("the registration record must belong to the customer itself: a CUSTOMER_REGISTER row by someone else does not count", async () => {
    await stale("not_self");
    await prisma.activityLog.create({ data: { org_id: ORG_A, actorId: "admin_a", action: "CUSTOMER_REGISTER", entity: "Customer", entityId: "not_self", createdAt: ago(100) } });
    expect((await run()).unverifiedAccounts).toBe(0);
  });

  it("only the REGISTRATION action counts: a staff-made customer with some other log row of their own is not self-registered", async () => {
    await stale("made_but_active");
    await prisma.activityLog.create({ data: { org_id: ORG_A, actorId: "made_but_active", action: "CUSTOMER_UPDATE_PROFILE", entity: "Customer", entityId: "made_but_active", createdAt: ago(100) } });
    expect((await run()).unverifiedAccounts).toBe(0);
  });

  it("a registration record in another org does not count", async () => {
    await stale("elsewhere");
    await prisma.activityLog.create({ data: { org_id: ORG_B, actorId: "elsewhere", action: "CUSTOMER_REGISTER", entity: "Customer", entityId: "elsewhere", createdAt: ago(100) } });
    expect((await run()).unverifiedAccounts).toBe(0);
  });

  it("owning ANY vehicle keeps the account, even a soft-deleted one (vehicle ownership, not only the link-request table)", async () => {
    for (const id of ["owns_live", "owns_deleted"]) {
      await stale(id);
      await prisma.activityLog.create({ data: { org_id: ORG_A, actorId: id, action: "CUSTOMER_REGISTER", entity: "Customer", entityId: id, createdAt: ago(100) } });
    }
    await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 11, { customerId: "owns_live" }) });
    await prisma.vehicle.create({ data: minimalVehicle(ORG_A, 12, { customerId: "owns_deleted", deletedAt: ago(5) }) });
    expect((await run()).unverifiedAccounts).toBe(0);
  });

  it("a pending link request keeps the account too", async () => {
    await stale("pending");
    await prisma.activityLog.create({ data: { org_id: ORG_A, actorId: "pending", action: "CUSTOMER_REGISTER", entity: "Customer", entityId: "pending", createdAt: ago(100) } });
    await prisma.vehicleLinkRequest.create({ data: { org_id: ORG_A, customerId: "pending", serialEntered: "FC9", status: "PENDING" } });
    expect((await run()).unverifiedAccounts).toBe(0);
  });
});
