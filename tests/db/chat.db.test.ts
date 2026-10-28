// Chat on real Postgres: scoping as SQL, parallel writers, the cascade, and the rejection reason being one atomic step
// with the decision. Fake data only.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { minimalVehicle } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});
vi.mock("../../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import {
  listCustomerConversations,
  listCustomerMessages,
  listInbox,
  listStaffMessages,
  replyAsStaff,
  sendCustomerMessage,
  setConversationHandled,
  startConversation,
} from "../../src/services/chat.service.js";
import { rejectLinkRequest } from "../../src/services/link-request-admin.service.js";
import { deleteCustomerAccount } from "../../src/services/customer-auth.service.js";
import { setCustomerAgent } from "../../src/services/customer-admin.service.js";
import bcrypt from "bcryptjs";

const prisma = getTestPrisma();
const ORG = "org_test_a";
const OTHER_ORG = "org_test_b";
const ME = { id: "cust_1", orgId: ORG, name: "C1" };
const OTHER = { id: "cust_2", orgId: ORG, name: "C2" };
const actor = { id: "staff", orgId: ORG, role: "MANAGER" as const, name: "Staff", email: null };

beforeEach(async () => {
  await resetDb(prisma);
  for (const id of [ORG, OTHER_ORG]) await prisma.organization.create({ data: { id, name: id } });
  await prisma.user.createMany({
    data: [
      { id: "staff", org_id: ORG, userType: "STAFF", name: "Staff", role: "MANAGER", loginEnabled: true },
      { id: "op_a", org_id: ORG, userType: "STAFF", name: "Operator A", role: "OPERATOR", loginEnabled: true },
      { id: "op_b", org_id: ORG, userType: "STAFF", name: "Operator B", role: "OPERATOR", loginEnabled: true },
      { id: "staff_b", org_id: OTHER_ORG, userType: "STAFF", name: "Staff B", role: "MANAGER", loginEnabled: true },
      { id: "viewer", org_id: ORG, userType: "STAFF", name: "Viewer", role: "VIEWER", loginEnabled: true },
      { id: "cust_1", org_id: ORG, userType: "CUSTOMER", name: "C1", email: "c1@example.test", loginEnabled: true, emailVerifiedAt: new Date(), password: bcrypt.hashSync("example-Password-12345", 4) },
      { id: "cust_2", org_id: ORG, userType: "CUSTOMER", name: "C2", email: "c2@example.test", loginEnabled: true, emailVerifiedAt: new Date() },
      { id: "cust_b", org_id: OTHER_ORG, userType: "CUSTOMER", name: "CB", email: "cb@example.test", loginEnabled: true, emailVerifiedAt: new Date() },
    ],
  });
});
afterAll(closeTestPrisma);

describe("scoping as SQL", () => {
  it("a customer sees only their own conversations and messages; another customer's id is a 404", async () => {
    const mine = await startConversation(ME, { body: "mine" });
    const theirs = await startConversation(OTHER, { body: "theirs" });
    expect((await listCustomerConversations(ME, {})).rows.map((r) => r.id)).toEqual([mine.conversation.id]);
    await expect(listCustomerMessages(ME, theirs.conversation.id, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sendCustomerMessage(ME, theirs.conversation.id, { body: "intruder" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.message.count({ where: { conversationId: theirs.conversation.id } })).toBe(1);
  });

  it("the staff inbox is the staff member's org only, and filters handled / open in SQL", async () => {
    const a = await startConversation(ME, { body: "a" });
    await startConversation(OTHER, { body: "b" });
    await startConversation({ id: "cust_b", orgId: OTHER_ORG, name: "CB" }, { body: "other org" });
    await setConversationHandled(actor, a.conversation.id, { handled: true });
    expect((await listInbox(actor, { status: "open" })).rows).toHaveLength(1);
    expect((await listInbox(actor, { status: "handled" })).rows.map((r) => r.id)).toEqual([a.conversation.id]);
    expect((await listInbox(actor, { status: "all" })).total).toBe(2);
    await expect(setConversationHandled({ ...actor, id: "staff_b", orgId: OTHER_ORG }, a.conversation.id, { handled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a conversation about a vehicle needs a vehicle the customer owns and may see", async () => {
    const own = await prisma.vehicle.create({ data: minimalVehicle(ORG, 1, { customerId: ME.id, customerVisible: true }) });
    const hidden = await prisma.vehicle.create({ data: minimalVehicle(ORG, 2, { customerId: ME.id, customerVisible: false }) });
    const theirs = await prisma.vehicle.create({ data: minimalVehicle(ORG, 3, { customerId: OTHER.id, customerVisible: true }) });
    expect((await startConversation(ME, { vehicleId: own.id, body: "ok" })).conversation.vehicleId).toBe(own.id);
    for (const v of [hidden, theirs]) await expect(startConversation(ME, { vehicleId: v.id, body: "no" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.conversation.count()).toBe(1);
  });
});

const opA = { id: "op_a", orgId: ORG, role: "OPERATOR" as const, name: "Operator A", email: null };
const opB = { id: "op_b", orgId: ORG, role: "OPERATOR" as const, name: "Operator B", email: null };
const viewer = { id: "viewer", orgId: ORG, role: "VIEWER" as const, name: "Viewer", email: null };

describe("operator scope on real SQL", () => {
  it("an operator lists, reads, replies to and handles only conversations of customers assigned to them; everything else is a 404", async () => {
    await prisma.user.update({ where: { id: ME.id }, data: { assignedAgentId: "op_a" } });
    await prisma.user.update({ where: { id: OTHER.id }, data: { assignedAgentId: "op_b" } });
    const mine = await startConversation(ME, { body: "mine" });
    const theirs = await startConversation(OTHER, { body: "theirs" });
    expect((await listInbox(opA, { status: "all" })).rows.map((r) => r.id)).toEqual([mine.conversation.id]);
    expect((await listInbox(opB, { status: "all" })).rows.map((r) => r.id)).toEqual([theirs.conversation.id]);
    expect((await listInbox(actor, { status: "all" })).total).toBe(2);
    await expect(listStaffMessages(opA, mine.conversation.id, {})).resolves.toBeTruthy();
    for (const attempt of [
      () => listStaffMessages(opA, theirs.conversation.id, {}),
      () => replyAsStaff(opA, theirs.conversation.id, { body: "x" }),
      () => setConversationHandled(opA, theirs.conversation.id, { handled: true }),
    ]) await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.message.count({ where: { conversationId: theirs.conversation.id } })).toBe(1);
  });

  it("an operator of another org who is assigned to an org A customer by bad data still reaches nothing", async () => {
    await prisma.user.update({ where: { id: "staff_b" }, data: { role: "OPERATOR" } });
    await prisma.user.update({ where: { id: ME.id }, data: { assignedAgentId: "staff_b" } });
    const mine = await startConversation(ME, { body: "mine" });
    const foreignOperator = { id: "staff_b", orgId: OTHER_ORG, role: "OPERATOR" as const, name: "Staff B", email: null };
    await expect(listStaffMessages(foreignOperator, mine.conversation.id, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(replyAsStaff(foreignOperator, mine.conversation.id, { body: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listInbox(foreignOperator, { status: "all" })).rows).toEqual([]);
  });

  it("a viewer and a deactivated operator are refused on every route", async () => {
    await prisma.user.update({ where: { id: ME.id }, data: { assignedAgentId: "op_a" } });
    const mine = await startConversation(ME, { body: "mine" });
    await expect(listInbox(viewer, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listStaffMessages(viewer, mine.conversation.id, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await prisma.user.update({ where: { id: "op_a" }, data: { loginEnabled: false } });
    await expect(listInbox(opA, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(replyAsStaff(opA, mine.conversation.id, { body: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("with no assigned agent the alert goes to managers only, with an assigned operator to that operator only", async () => {
    const free = await startConversation(ME, { body: "first" });
    expect((await prisma.notification.findMany({ where: { event: "CHAT_MESSAGE" } })).map((n) => n.userId)).toEqual(["staff"]);
    expect(free.conversation.id).toBeTruthy();
    await prisma.notification.deleteMany();
    await prisma.user.update({ where: { id: OTHER.id }, data: { assignedAgentId: "op_b" } });
    await startConversation(OTHER, { body: "second" });
    expect((await prisma.notification.findMany({ where: { event: "CHAT_MESSAGE" } })).map((n) => n.userId)).toEqual(["op_b"]);
  });

  it("15 rounds of reassigning a customer while they start a conversation and the old agent reads: no errors, alerts only to the old or the new agent, and afterwards only the new agent has access", async () => {
    for (let round = 0; round < 15; round += 1) {
      await prisma.user.update({ where: { id: ME.id }, data: { assignedAgentId: "op_a" } });
      const seed = await startConversation(ME, { body: `seed ${round}` });
      await prisma.notification.deleteMany();

      const results = await Promise.allSettled([
        setCustomerAgent(actor, ME.id, { agentId: "op_b" }),
        startConversation(ME, { body: `during ${round}` }),
        listStaffMessages(opA, seed.conversation.id, {}),
        sendCustomerMessage(ME, seed.conversation.id, { body: `more ${round}` }),
      ]);
      for (const [i, r] of results.entries()) {
        if (r.status === "rejected") expect((r.reason as { code?: string }).code, `round ${round} call ${i}`).toBe("NOT_FOUND"); // only the old agent's read may fail
      }
      expect(results[0]!.status).toBe("fulfilled");
      expect(results[1]!.status).toBe("fulfilled");
      expect(results[3]!.status).toBe("fulfilled");

      const alerted = (await prisma.notification.findMany({ where: { event: "CHAT_MESSAGE" } })).map((n) => n.userId);
      for (const userId of alerted) expect(["op_a", "op_b"], `round ${round}`).toContain(userId);
      expect(alerted).not.toContain("staff");

      await expect(listStaffMessages(opA, seed.conversation.id, {}), `round ${round}`).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(listStaffMessages(opB, seed.conversation.id, {})).resolves.toBeTruthy();
    }
  });
});

describe("parallel writers", () => {
  it("20 messages at once from the customer and staff are all stored, in a stable order, with the right last time", async () => {
    const { conversation } = await startConversation(ME, { body: "start" });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? sendCustomerMessage(ME, conversation.id, { body: `c${i}` }) : replyAsStaff(actor, conversation.id, { body: `s${i}` })))
    );
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(21);
    const last = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row.lastMessageAt.getTime()).toBeGreaterThanOrEqual(last.createdAt.getTime() - 5);
    const page1 = await listCustomerMessages(ME, conversation.id, { pageSize: 10, page: 1 });
    const page2 = await listCustomerMessages(ME, conversation.id, { pageSize: 10, page: 2 });
    const ids = [...page1.rows, ...page2.rows].map((m) => m.id);
    expect(new Set(ids).size).toBe(20); // no row repeated or skipped between pages
  });
});

describe("the cascade and account deletion", () => {
  it("deleting a conversation deletes its messages (foreign key), and nothing else", async () => {
    const a = await startConversation(ME, { body: "a" });
    const b = await startConversation(OTHER, { body: "b" });
    await prisma.conversation.delete({ where: { id: a.conversation.id } });
    expect((await prisma.message.findMany()).map((m) => m.conversationId)).toEqual([b.conversation.id]);
  });

  it("deleting an account removes that customer's conversations, messages, alerts and settings only", async () => {
    const a = await startConversation(ME, { body: "a" });
    await startConversation(OTHER, { body: "b" });
    await replyAsStaff(actor, a.conversation.id, { body: "reply" });
    await prisma.notificationPreference.create({ data: { org_id: ORG, userId: ME.id } });
    await deleteCustomerAccount({ id: ME.id, orgId: ORG }, { password: "example-Password-12345" });
    expect((await prisma.conversation.findMany()).map((c) => c.customerId)).toEqual([OTHER.id]);
    expect(await prisma.message.count()).toBe(1);
    expect(await prisma.notification.count({ where: { userId: ME.id } })).toBe(0);
    expect(await prisma.notificationPreference.count({ where: { userId: ME.id } })).toBe(0);
  });
});

describe("a rejection reason is one atomic step with the decision", () => {
  it("three parallel rejections with a reason leave one decision and exactly one message", async () => {
    await prisma.vehicleLinkRequest.create({ data: { id: "lr1", org_id: ORG, customerId: ME.id, serialEntered: "FC999" } });
    const results = await Promise.allSettled([
      rejectLinkRequest(actor, "lr1", { reason: "Not ours." }),
      rejectLinkRequest(actor, "lr1", { reason: "Not ours." }),
      rejectLinkRequest(actor, "lr1", { reason: "Not ours." }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await prisma.vehicleLinkRequest.findUniqueOrThrow({ where: { id: "lr1" } })).status).toBe("REJECTED");
    expect(await prisma.message.count()).toBe(1);
    expect(await prisma.conversation.count()).toBe(1);
  });

  it("a reason that cannot be stored undoes the rejection", async () => {
    await prisma.vehicleLinkRequest.create({ data: { id: "lr2", org_id: ORG, customerId: ME.id, serialEntered: "FC998" } });
    // a body longer than the validator allows never reaches the database; this proves the 400 leaves the request pending
    await expect(rejectLinkRequest(actor, "lr2", { reason: "x".repeat(501) })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await prisma.vehicleLinkRequest.findUniqueOrThrow({ where: { id: "lr2" } })).status).toBe("PENDING");
    expect(await prisma.message.count()).toBe(0);
  });
});
