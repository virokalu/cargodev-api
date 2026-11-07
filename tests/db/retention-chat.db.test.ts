// Chat and enquiry retention on REAL Postgres: RETENTION_CHAT_DAYS and RETENTION_ENQUIRY_DAYS (0 = never, the default). What is deleted, what is kept,
// the exact cut-off, the dry run, the 1000-row batch, organisation scoping, idempotence and the counts-only summary row. Fake data only.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { ORG_A, ORG_B, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});
const settings = vi.hoisted(() => ({ override: {} as Record<string, number | boolean> }));
vi.mock("../../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...settings.override }) };
});

import { runRetention } from "../../src/services/retention.service.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const prisma = getTestPrisma();
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);
const run = (org = ORG_A) => runRetention(org, NOW);
const summaryRows = (org = ORG_A) => prisma.activityLog.findMany({ where: { org_id: org, action: "RETENTION_CLEANUP" } });

const conversation = (id: string, org: string, customerId: string, lastMessageAt: Date, messages = 2) =>
  prisma.conversation
    .create({ data: { id, org_id: org, customerId, lastMessageAt, createdAt: ago(3000) } })
    .then(() => prisma.message.createMany({ data: Array.from({ length: messages }, (_, i) => ({ id: `${id}_m${i}`, org_id: org, conversationId: id, senderType: "CUSTOMER" as const, senderId: customerId, body: `message ${i}`, createdAt: lastMessageAt })) }));
const enquiry = (id: string, org: string, createdAt: Date, handledAt: Date | null = null) =>
  prisma.enquiry.create({ data: { id, org_id: org, name: "Visitor", email: "visitor@example.test", message: "hello", createdAt, handledAt } });
const ids = async (rows: Promise<Array<{ id: string }>>) => (await rows).map((r) => r.id).sort();
const convIds = () => ids(prisma.conversation.findMany({ select: { id: true } }));
const enqIds = () => ids(prisma.enquiry.findMany({ select: { id: true } }));

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
afterAll(closeTestPrisma);

describe("the default, 0, means NEVER", () => {
  it("deletes nothing however old, and counts nothing", async () => {
    await conversation("ancient", ORG_A, "cust_a", ago(3650));
    await enquiry("ancient_enquiry", ORG_A, ago(3650));
    const counts = await run();
    expect([counts.chatConversations, counts.chatMessages, counts.enquiries]).toEqual([0, 0, 0]);
    expect(await convIds()).toEqual(["ancient"]);
    expect(await enqIds()).toEqual(["ancient_enquiry"]);
    expect(await prisma.message.count()).toBe(2);
    expect(await summaryRows()).toHaveLength(0);
  });

  it("an explicit 0 is the same, and one setting does not switch on the other", async () => {
    settings.override = { RETENTION_DRY_RUN: false, RETENTION_CHAT_DAYS: 0, RETENTION_ENQUIRY_DAYS: 30 };
    await conversation("old_chat", ORG_A, "cust_a", ago(900));
    await enquiry("old_enquiry", ORG_A, ago(900));
    const counts = await run();
    expect([counts.chatConversations, counts.enquiries]).toEqual([0, 1]);
    expect(await convIds()).toEqual(["old_chat"]);
    expect(await enqIds()).toEqual([]);
    settings.override = { RETENTION_DRY_RUN: false, RETENTION_CHAT_DAYS: 365, RETENTION_ENQUIRY_DAYS: 0 };
    await enquiry("old_enquiry_2", ORG_A, ago(900));
    const second = await run();
    expect([second.chatConversations, second.enquiries]).toEqual([1, 0]);
    expect(await convIds()).toEqual([]);
    expect(await enqIds()).toEqual(["old_enquiry_2"]);
  });
});

describe("chats (RETENTION_CHAT_DAYS = 365)", () => {
  beforeEach(() => {
    settings.override = { RETENTION_DRY_RUN: false, RETENTION_CHAT_DAYS: 365 };
  });

  it("deletes conversations idle for more than 365 days WITH their messages, and keeps the rest, at the exact cut-off", async () => {
    await conversation("idle", ORG_A, "cust_a", ago(400), 3);
    await conversation("edge_deleted", ORG_A, "cust_a", ago(365, 1000), 2); // one second past
    await conversation("edge_kept", ORG_A, "cust_a", ago(365, -1000), 2); // one second short
    await conversation("recent", ORG_A, "cust_a", ago(10), 4);
    const counts = await run();
    expect([counts.chatConversations, counts.chatMessages]).toEqual([2, 5]);
    expect(await convIds()).toEqual(["edge_kept", "recent"]);
    expect(await prisma.message.count({ where: { conversationId: { in: ["idle", "edge_deleted"] } } })).toBe(0);
    expect(await prisma.message.count({ where: { conversationId: { in: ["edge_kept", "recent"] } } })).toBe(6);
  });

  it("the age of the CONVERSATION decides, not the age of one message: an old conversation with a recent message is kept whole", async () => {
    await conversation("long_running", ORG_A, "cust_a", ago(5), 3);
    await prisma.message.update({ where: { id: "long_running_m0" }, data: { createdAt: ago(1500) } }); // a very old first message
    await run();
    expect(await convIds()).toEqual(["long_running"]);
    expect(await prisma.message.count({ where: { conversationId: "long_running" } })).toBe(3);
  });

  it("handled or not makes no difference: an idle open conversation goes too, a recent handled one stays", async () => {
    await conversation("idle_open", ORG_A, "cust_a", ago(500));
    await conversation("idle_handled", ORG_A, "cust_a", ago(500));
    await prisma.conversation.update({ where: { id: "idle_handled" }, data: { handledAt: ago(499), handledById: "admin_a" } });
    await conversation("recent_handled", ORG_A, "cust_a", ago(2));
    await prisma.conversation.update({ where: { id: "recent_handled" }, data: { handledAt: ago(1), handledById: "admin_a" } });
    expect((await run()).chatConversations).toBe(2);
    expect(await convIds()).toEqual(["recent_handled"]);
  });

  it("never touches the customer, the vehicle or other organisations; each organisation is handled by its own run", async () => {
    await conversation("a_idle", ORG_A, "cust_a", ago(500));
    await conversation("b_idle", ORG_B, "cust_b", ago(500));
    await run(ORG_A);
    expect(await convIds()).toEqual(["b_idle"]); // organisation B's conversation survives A's run
    expect(await prisma.message.count({ where: { org_id: ORG_B } })).toBe(2);
    expect(await prisma.user.count({ where: { id: { in: ["cust_a", "cust_b"] } } })).toBe(2);
    await run(ORG_B);
    expect(await convIds()).toEqual([]);
  });

  it("works in batches of 1000 conversations per run, with a second run for the rest", async () => {
    await prisma.conversation.createMany({ data: Array.from({ length: 1005 }, (_, i) => ({ id: `bulk_${String(i).padStart(4, "0")}`, org_id: ORG_A, customerId: "cust_a", lastMessageAt: ago(400, i), createdAt: ago(2000) })) });
    await prisma.message.createMany({ data: Array.from({ length: 1005 }, (_, i) => ({ id: `bulk_msg_${i}`, org_id: ORG_A, conversationId: `bulk_${String(i).padStart(4, "0")}`, senderType: "CUSTOMER" as const, senderId: "cust_a", body: "x" })) });
    const first = await run();
    expect([first.chatConversations, first.chatMessages]).toEqual([1000, 1000]);
    expect(await prisma.conversation.count()).toBe(5);
    const second = await run();
    expect([second.chatConversations, second.chatMessages]).toEqual([5, 5]);
    expect((await run()).chatConversations).toBe(0);
  });

  it("a DRY RUN counts only this organisation's conversations and enquiries, even when another organisation has matching ones", async () => {
    settings.override = { RETENTION_DRY_RUN: true, RETENTION_CHAT_DAYS: 365, RETENTION_ENQUIRY_DAYS: 30 };
    await conversation("a_idle", ORG_A, "cust_a", ago(500), 2);
    await conversation("b_idle", ORG_B, "cust_b", ago(500), 5);
    await enquiry("a_old", ORG_A, ago(60));
    await enquiry("b_old1", ORG_B, ago(60));
    await enquiry("b_old2", ORG_B, ago(60));
    const counts = await run(ORG_A);
    expect([counts.chatConversations, counts.chatMessages, counts.enquiries]).toEqual([1, 2, 1]);
  });

  it("a DRY RUN counts what would go and removes nothing, and writes no summary row", async () => {
    settings.override = { RETENTION_DRY_RUN: true, RETENTION_CHAT_DAYS: 365 };
    await conversation("idle", ORG_A, "cust_a", ago(500), 3);
    const counts = await run();
    expect([counts.dryRun, counts.chatConversations, counts.chatMessages]).toEqual([true, 1, 3]);
    expect(await convIds()).toEqual(["idle"]);
    expect(await prisma.message.count()).toBe(3);
    expect(await summaryRows()).toHaveLength(0);
  });

  it("is idempotent and writes ONE counts-only summary row, with no message text, name or e-mail", async () => {
    await conversation("idle", ORG_A, "cust_a", ago(500), 2);
    await run();
    const second = await run();
    expect([second.chatConversations, second.chatMessages]).toEqual([0, 0]);
    const rows = await summaryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toMatchObject({ chatConversations: 1, chatMessages: 2, enquiries: 0, system: true, job: "retention" });
    expect(JSON.stringify(rows[0])).not.toMatch(/message \d|Buyer|example\.test|cust_a/);
  });

  it("does not run when the organisation has no administrator to attribute the summary to (nothing is removed)", async () => {
    await prisma.user.delete({ where: { id: "admin_a" } });
    await conversation("idle", ORG_A, "cust_a", ago(500));
    const counts = await run();
    expect(counts.skipped).toBe(1);
    expect(await convIds()).toEqual(["idle"]);
  });
});

describe("enquiries (RETENTION_ENQUIRY_DAYS = 30)", () => {
  beforeEach(() => {
    settings.override = { RETENTION_DRY_RUN: false, RETENTION_ENQUIRY_DAYS: 30 };
  });

  it("deletes enquiries created more than 30 days ago, handled or not, and keeps the rest, at the exact cut-off", async () => {
    await enquiry("old_open", ORG_A, ago(60));
    await enquiry("old_handled", ORG_A, ago(60), ago(59));
    await enquiry("edge_deleted", ORG_A, ago(30, 1000));
    await enquiry("edge_kept", ORG_A, ago(30, -1000));
    await enquiry("recent", ORG_A, ago(1));
    const counts = await run();
    expect(counts.enquiries).toBe(3);
    expect(await enqIds()).toEqual(["edge_kept", "recent"]);
  });

  it("does not touch chats, customers or other organisations", async () => {
    await enquiry("a_old", ORG_A, ago(60));
    await enquiry("b_old", ORG_B, ago(60));
    await conversation("old_chat", ORG_A, "cust_a", ago(900));
    await run(ORG_A);
    expect(await enqIds()).toEqual(["b_old"]);
    expect(await convIds()).toEqual(["old_chat"]);
  });

  it("batches of 1000, dry run, idempotence", async () => {
    await prisma.enquiry.createMany({ data: Array.from({ length: 1003 }, (_, i) => ({ id: `e_${String(i).padStart(4, "0")}`, org_id: ORG_A, name: "V", email: "v@example.test", message: "m", createdAt: ago(60, i) })) });
    settings.override = { RETENTION_DRY_RUN: true, RETENTION_ENQUIRY_DAYS: 30 };
    expect((await run()).enquiries).toBe(1000); // a dry run counts at most one batch too
    expect(await prisma.enquiry.count()).toBe(1003);
    settings.override = { RETENTION_DRY_RUN: false, RETENTION_ENQUIRY_DAYS: 30 };
    expect((await run()).enquiries).toBe(1000);
    expect((await run()).enquiries).toBe(3);
    expect((await run()).enquiries).toBe(0);
    expect(await prisma.enquiry.count()).toBe(0);
  });

  it("the summary row has counts only: no name, e-mail or message", async () => {
    await enquiry("old", ORG_A, ago(60));
    await run();
    const rows = await summaryRows();
    expect(rows[0]?.after).toMatchObject({ enquiries: 1, chatConversations: 0, chatMessages: 0 });
    expect(JSON.stringify(rows[0])).not.toMatch(/Visitor|visitor@|hello/);
  });
});

describe("both together", () => {
  it("one run removes chats and enquiries and the summary row carries all the counts", async () => {
    settings.override = { RETENTION_DRY_RUN: false, RETENTION_CHAT_DAYS: 100, RETENTION_ENQUIRY_DAYS: 100 };
    await conversation("idle", ORG_A, "cust_a", ago(200), 2);
    await enquiry("old", ORG_A, ago(200));
    await run();
    expect((await summaryRows())[0]?.after).toMatchObject({ chatConversations: 1, chatMessages: 2, enquiries: 1 });
  });
});
