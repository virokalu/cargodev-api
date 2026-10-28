// Chat between a customer and staff. Plain text only, no attachments.
//
// Customer side: every query filters by org AND the token's own customer id, so another customer's conversation is a
// 404. A conversation may be about one vehicle, which must be a vehicle the customer may see. Staff side: ADMINISTRATOR
// and MANAGER see the org's inbox, reply and mark conversations handled; a reply writes an ActivityLog row.
//
// After the transaction commits, the OTHER party (and only them) gets a live "message" event (ids only, never the
// text) and, at most once per burst, an alert (and push and email if their settings allow). Alerts never contain the
// message text, so nothing a customer wrote or staff answered ever travels by email or push.

import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { CHAT_FULL_ROLES, CHAT_ROLES, chatScopeFor } from "../config/roles.js";
import { CHAT_ALERT_COALESCE_MS, MAX_CONVERSATIONS_PER_CUSTOMER, SUGGESTED_QUESTIONS } from "../config/chat.js";
import { getEventBus } from "../lib/events.js";
import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import { safeError } from "../lib/redact.js";
import type { SessionUser } from "../lib/session-user.js";
import {
  conversationListQuerySchema,
  handledBodySchema,
  messageListQuerySchema,
  sendMessageBodySchema,
  staffInboxQuerySchema,
  startConversationBodySchema,
} from "../validation/chat.schema.js";
import * as activityLog from "./activity-log.service.js";
import { customerVehicleWhere, type CustomerPrincipalLike, type Page } from "./customer-data.service.js";
import { emit, notifyRealtime, type EmitParams } from "./notification.service.js";

type TxClient = Prisma.TransactionClient;

const INVALID = "Please fix the highlighted fields.";
const conversationNotFound = () => new ServiceError("NOT_FOUND", "Conversation not found.");
const vehicleNotFound = () => new ServiceError("NOT_FOUND", "Vehicle not found.");
const SNIPPET_LENGTH = 120;

type Sender = "CUSTOMER" | "STAFF";

export interface MessageDto {
  id: string;
  senderType: Sender;
  body: string;
  createdAt: string;
}

/** What to do once the transaction has committed. */
interface Delivery {
  events: { userId: string; conversationId: string; messageId: string; senderType: Sender; createdAt: Date; orgId: string }[];
  alerts: EmitParams[];
}

function publishDelivery(delivery: Delivery): void {
  try {
    const bus = getEventBus();
    for (const event of delivery.events) {
      bus.publish({
        type: "message",
        orgId: event.orgId,
        userId: event.userId,
        id: randomUUID(),
        payload: { conversationId: event.conversationId, messageId: event.messageId, senderType: event.senderType, createdAt: event.createdAt.toISOString() },
      });
    }
  } catch (error) {
    console.error("Chat event publish failed", safeError(error));
  }
  for (const alert of delivery.alerts) notifyRealtime(alert);
}

const snippet = (body: string) => (body.length > SNIPPET_LENGTH ? `${body.slice(0, SNIPPET_LENGTH - 1)}…` : body);

/**
 * Staff who are told about a customer message (alert and live event), read from the database NOW:
 *  - the customer's assigned agent, if they are an active staff member of this org whose role may open chat;
 *  - otherwise (no agent assigned, or the agent cannot open chat) the active administrators and managers.
 * A user who could not open the conversation is never told about it. The text of a message is never in the alert.
 */
async function staffRecipients(tx: TxClient, orgId: string, customerId: string): Promise<string[]> {
  const customer = await tx.user.findFirst({ where: { id: customerId, org_id: orgId }, select: { assignedAgentId: true } });
  if (customer?.assignedAgentId) {
    const agent = await tx.user.findFirst({
      where: { id: customer.assignedAgentId, org_id: orgId, userType: "STAFF", loginEnabled: true, role: { in: [...CHAT_ROLES] } },
      select: { id: true },
    });
    if (agent) return [agent.id];
  }
  const managers = await tx.user.findMany({
    where: { org_id: orgId, userType: "STAFF", loginEnabled: true, role: { in: [...CHAT_FULL_ROLES] } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return managers.map((m) => m.id);
}

// ---------------------------------------------------------------------------------------------
// Who may open which conversation (staff). The rule lives in config/roles.ts (chatScopeFor); this applies it.

/** What the acting staff member may reach, decided from the DATABASE on every request (never from the token alone). */
export type ChatScope = { kind: "ALL" } | { kind: "ASSIGNED"; agentId: string };

async function resolveScope(actor: SessionUser): Promise<ChatScope> {
  const user = await getPrisma().user.findFirst({
    where: { id: actor.id, org_id: actor.orgId, userType: "STAFF", loginEnabled: true },
    select: { id: true, role: true },
  });
  // Deactivated, deleted or not this org's: no access. The role is the CURRENT one, not the one the token was issued with.
  const kind = user ? chatScopeFor(user.role) : null;
  if (!user || !kind) throw new ServiceError("FORBIDDEN", "You don't have permission to access this resource.");
  return kind === "ALL" ? { kind: "ALL" } : { kind: "ASSIGNED", agentId: user.id };
}

/** The where-clause every staff chat query starts from: this org, and for an operator only customers assigned to them. */
function conversationScopeWhere(orgId: string, scope: ChatScope): Prisma.ConversationWhereInput {
  return scope.kind === "ALL" ? { org_id: orgId } : { org_id: orgId, customer: { assignedAgentId: scope.agentId } };
}

/**
 * Appends one message and updates the conversation, inside the caller's transaction. Returns the row and what to deliver
 * after commit. An alert is raised only when this message starts a burst: the first one, a change of sender, or a gap.
 */
async function appendMessage(
  tx: TxClient,
  input: { orgId: string; conversationId: string; customerId: string; customerName: string; vehicleId: string | null; senderType: Sender; senderId: string; body: string }
): Promise<{ message: MessageDto; delivery: Delivery }> {
  const previous = await tx.message.findFirst({
    where: { org_id: input.orgId, conversationId: input.conversationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { senderType: true, createdAt: true },
  });

  const row = await tx.message.create({
    data: { org_id: input.orgId, conversationId: input.conversationId, senderType: input.senderType, senderId: input.senderId, body: input.body },
    select: { id: true, senderType: true, body: true, createdAt: true },
  });
  // The last-message time only ever moves forward, so two messages committed out of order cannot leave it behind.
  await tx.conversation.updateMany({
    where: { id: input.conversationId, org_id: input.orgId, lastMessageAt: { lt: row.createdAt } },
    data: { lastMessageAt: row.createdAt },
  });
  // A customer's message reopens a conversation that staff had marked handled.
  if (input.senderType === "CUSTOMER") {
    await tx.conversation.updateMany({ where: { id: input.conversationId, org_id: input.orgId }, data: { handledAt: null, handledById: null } });
  }

  const startsBurst = !previous || previous.senderType !== input.senderType || row.createdAt.getTime() - previous.createdAt.getTime() > CHAT_ALERT_COALESCE_MS;
  const delivery: Delivery = { events: [], alerts: [] };

  if (input.senderType === "CUSTOMER") {
    const recipients = await staffRecipients(tx, input.orgId, input.customerId);
    for (const userId of recipients) {
      delivery.events.push({ userId, orgId: input.orgId, conversationId: input.conversationId, messageId: row.id, senderType: "CUSTOMER", createdAt: row.createdAt });
    }
    if (startsBurst && recipients.length > 0) {
      const alert: EmitParams = {
        orgId: input.orgId,
        event: "CHAT_MESSAGE",
        title: `New message from ${input.customerName}`,
        body: "Open the chat inbox to read and reply.",
        ...(input.vehicleId ? { vehicleId: input.vehicleId } : {}),
        recipientUserIds: recipients,
      };
      await emit(tx, alert);
      delivery.alerts.push(alert);
    }
  } else {
    delivery.events.push({ userId: input.customerId, orgId: input.orgId, conversationId: input.conversationId, messageId: row.id, senderType: "STAFF", createdAt: row.createdAt });
    if (startsBurst) {
      const alert: EmitParams = {
        orgId: input.orgId,
        event: "CHAT_MESSAGE",
        title: "New message",
        body: "You have a new message from the CargoDev team.",
        ...(input.vehicleId ? { vehicleId: input.vehicleId } : {}),
        recipientUserIds: [input.customerId],
      };
      await emit(tx, alert);
      delivery.alerts.push(alert);
    }
  }
  return { message: { id: row.id, senderType: row.senderType, body: row.body, createdAt: row.createdAt.toISOString() }, delivery };
}

// ---------------------------------------------------------------------------------------------
// Customer

export function suggestedQuestions(): { questions: string[] } {
  return { questions: [...SUGGESTED_QUESTIONS] };
}

export interface CustomerConversation {
  id: string;
  vehicle: { id: string; serial: string } | null;
  lastMessageAt: string;
  lastMessage: { senderType: Sender; snippet: string; createdAt: string } | null;
}

/** The customer's own conversations, most recent first. A vehicle is named only while the customer may still see it. */
export async function listCustomerConversations(customer: CustomerPrincipalLike, rawQuery: unknown): Promise<Page<CustomerConversation>> {
  const { page, pageSize } = parseInput(conversationListQuerySchema, rawQuery);
  const prisma = getPrisma();
  const where = { org_id: customer.orgId, customerId: customer.id };
  const [total, rows] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, vehicleId: true, lastMessageAt: true },
    }),
  ]);

  const vehicleIds = [...new Set(rows.map((r) => r.vehicleId).filter((id): id is string => id !== null))];
  const visible = vehicleIds.length
    ? new Map(
        (
          await prisma.vehicle.findMany({ where: { AND: [customerVehicleWhere(customer), { id: { in: vehicleIds } }] }, select: { id: true, serial: true } })
        ).map((v) => [v.id, v.serial])
      )
    : new Map<string, string>();

  const last = await Promise.all(
    rows.map((row) =>
      prisma.message.findFirst({
        where: { org_id: customer.orgId, conversationId: row.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { senderType: true, body: true, createdAt: true },
      })
    )
  );

  return {
    rows: rows.map((row, i) => ({
      id: row.id,
      vehicle: row.vehicleId && visible.has(row.vehicleId) ? { id: row.vehicleId, serial: visible.get(row.vehicleId)! } : null,
      lastMessageAt: row.lastMessageAt.toISOString(),
      lastMessage: last[i] ? { senderType: last[i]!.senderType, snippet: snippet(last[i]!.body), createdAt: last[i]!.createdAt.toISOString() } : null,
    })),
    total,
    page,
    pageSize,
  };
}

export async function startConversation(customer: CustomerPrincipalLike & { name: string }, rawBody: unknown): Promise<{ conversation: { id: string; vehicleId: string | null }; message: MessageDto }> {
  const input = parseInput(startConversationBodySchema, rawBody, INVALID);
  const prisma = getPrisma();

  // The vehicle must be one the customer may see: another customer's, an unreleased and an unknown one are the same 404.
  if (input.vehicleId) {
    const vehicle = await prisma.vehicle.findFirst({ where: { AND: [customerVehicleWhere(customer), { id: input.vehicleId }] }, select: { id: true } });
    if (!vehicle) throw vehicleNotFound();
  }
  if ((await prisma.conversation.count({ where: { org_id: customer.orgId, customerId: customer.id } })) >= MAX_CONVERSATIONS_PER_CUSTOMER) {
    throw new ServiceError("CONFLICT", "You have reached the maximum number of conversations.");
  }

  const result = await prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: { org_id: customer.orgId, customerId: customer.id, vehicleId: input.vehicleId ?? null, lastMessageAt: new Date() },
      select: { id: true, vehicleId: true },
    });
    const appended = await appendMessage(tx, {
      orgId: customer.orgId,
      conversationId: conversation.id,
      customerId: customer.id,
      customerName: customer.name,
      vehicleId: conversation.vehicleId,
      senderType: "CUSTOMER",
      senderId: customer.id,
      body: input.body,
    });
    await activityLog.record(tx, { orgId: customer.orgId, actorId: customer.id, action: "START_CONVERSATION", entity: "Conversation", entityId: conversation.id, after: { vehicleId: conversation.vehicleId } });
    return { conversation, ...appended };
  });
  publishDelivery(result.delivery);
  return { conversation: { id: result.conversation.id, vehicleId: result.conversation.vehicleId }, message: result.message };
}

async function ownConversation(customer: CustomerPrincipalLike, conversationId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) throw conversationNotFound();
  const conversation = await getPrisma().conversation.findFirst({
    where: { id: conversationId, org_id: customer.orgId, customerId: customer.id },
    select: { id: true, vehicleId: true },
  });
  if (!conversation) throw conversationNotFound();
  return conversation;
}

export async function listCustomerMessages(customer: CustomerPrincipalLike, conversationId: string, rawQuery: unknown): Promise<Page<MessageDto>> {
  const { page, pageSize } = parseInput(messageListQuerySchema, rawQuery);
  const conversation = await ownConversation(customer, conversationId);
  const prisma = getPrisma();
  const where = { org_id: customer.orgId, conversationId: conversation.id };
  const [total, rows] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, senderType: true, body: true, createdAt: true },
    }),
  ]);
  return { rows: rows.map((m) => ({ id: m.id, senderType: m.senderType, body: m.body, createdAt: m.createdAt.toISOString() })), total, page, pageSize };
}

export async function sendCustomerMessage(customer: CustomerPrincipalLike & { name: string }, conversationId: string, rawBody: unknown): Promise<MessageDto> {
  const { body } = parseInput(sendMessageBodySchema, rawBody, INVALID);
  const conversation = await ownConversation(customer, conversationId);

  const result = await getPrisma().$transaction(async (tx) => {
    const appended = await appendMessage(tx, {
      orgId: customer.orgId,
      conversationId: conversation.id,
      customerId: customer.id,
      customerName: customer.name,
      vehicleId: conversation.vehicleId,
      senderType: "CUSTOMER",
      senderId: customer.id,
      body,
    });
    await activityLog.record(tx, { orgId: customer.orgId, actorId: customer.id, action: "SEND_CHAT_MESSAGE", entity: "Conversation", entityId: conversation.id, after: { messageId: appended.message.id } });
    return appended;
  });
  publishDelivery(result.delivery);
  return result.message;
}

// ---------------------------------------------------------------------------------------------
// Staff

export interface InboxRow {
  id: string;
  customer: { id: string; name: string; companyName: string | null };
  vehicle: { id: string; serial: string } | null;
  lastMessageAt: string;
  handled: boolean;
  lastMessage: { senderType: Sender; snippet: string; createdAt: string } | null;
}

export async function listInbox(actor: SessionUser, rawQuery: unknown): Promise<Page<InboxRow>> {
  const { page, pageSize, status } = parseInput(staffInboxQuerySchema, rawQuery);
  const orgId = actor.orgId;
  const scope = await resolveScope(actor);
  const prisma = getPrisma();
  const where: Prisma.ConversationWhereInput = { ...conversationScopeWhere(orgId, scope), ...(status === "open" ? { handledAt: null } : status === "handled" ? { handledAt: { not: null } } : {}) };
  const [total, rows] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, customerId: true, vehicleId: true, lastMessageAt: true, handledAt: true },
    }),
  ]);

  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const vehicleIds = [...new Set(rows.map((r) => r.vehicleId).filter((id): id is string => id !== null))];
  const [customers, vehicles, last] = await Promise.all([
    customerIds.length ? prisma.user.findMany({ where: { org_id: orgId, id: { in: customerIds } }, select: { id: true, name: true, companyName: true } }) : [],
    vehicleIds.length ? prisma.vehicle.findMany({ where: { org_id: orgId, deletedAt: null, id: { in: vehicleIds } }, select: { id: true, serial: true } }) : [],
    Promise.all(
      rows.map((row) =>
        prisma.message.findFirst({
          where: { org_id: orgId, conversationId: row.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { senderType: true, body: true, createdAt: true },
        })
      )
    ),
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

  return {
    rows: rows.map((row, i) => {
      const customer = customerById.get(row.customerId);
      const vehicle = row.vehicleId ? vehicleById.get(row.vehicleId) : undefined;
      return {
        id: row.id,
        customer: { id: row.customerId, name: customer?.name ?? "Unknown", companyName: customer?.companyName ?? null },
        vehicle: vehicle ? { id: vehicle.id, serial: vehicle.serial } : null,
        lastMessageAt: row.lastMessageAt.toISOString(),
        handled: row.handledAt !== null,
        lastMessage: last[i] ? { senderType: last[i]!.senderType, snippet: snippet(last[i]!.body), createdAt: last[i]!.createdAt.toISOString() } : null,
      };
    }),
    total,
    page,
    pageSize,
  };
}

async function orgConversation(actor: SessionUser, conversationId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) throw conversationNotFound();
  const scope = await resolveScope(actor);
  // Not in scope (another agent's customer, an unassigned customer, another org) is indistinguishable from not existing.
  const conversation = await getPrisma().conversation.findFirst({
    where: { AND: [conversationScopeWhere(actor.orgId, scope), { id: conversationId }] },
    select: { id: true, customerId: true, vehicleId: true, handledAt: true },
  });
  if (!conversation) throw conversationNotFound();
  return conversation;
}

export interface StaffMessageDto extends MessageDto {
  /** The staff member's name for staff messages; null for the customer's. */
  senderName: string | null;
}

export async function listStaffMessages(
  actor: SessionUser,
  conversationId: string,
  rawQuery: unknown
): Promise<Page<StaffMessageDto> & { conversation: { id: string; customer: { id: string; name: string }; vehicle: { id: string; serial: string } | null; handled: boolean } }> {
  const { page, pageSize } = parseInput(messageListQuerySchema, rawQuery);
  const orgId = actor.orgId;
  const conversation = await orgConversation(actor, conversationId);
  const prisma = getPrisma();
  const where = { org_id: orgId, conversationId: conversation.id };
  const [total, rows, customer, vehicle] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, senderType: true, senderId: true, body: true, createdAt: true },
    }),
    prisma.user.findFirst({ where: { id: conversation.customerId, org_id: orgId }, select: { id: true, name: true } }),
    conversation.vehicleId ? prisma.vehicle.findFirst({ where: { id: conversation.vehicleId, org_id: orgId, deletedAt: null }, select: { id: true, serial: true } }) : null,
  ]);
  const staffIds = [...new Set(rows.filter((m) => m.senderType === "STAFF").map((m) => m.senderId))];
  const staff = staffIds.length ? await prisma.user.findMany({ where: { org_id: orgId, id: { in: staffIds } }, select: { id: true, name: true } }) : [];
  const nameById = new Map(staff.map((s) => [s.id, s.name]));

  return {
    conversation: {
      id: conversation.id,
      customer: { id: conversation.customerId, name: customer?.name ?? "Unknown" },
      vehicle: vehicle ? { id: vehicle.id, serial: vehicle.serial } : null,
      handled: conversation.handledAt !== null,
    },
    rows: rows.map((m) => ({
      id: m.id,
      senderType: m.senderType,
      senderName: m.senderType === "STAFF" ? (nameById.get(m.senderId) ?? null) : null,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  };
}

export async function replyAsStaff(actor: SessionUser, conversationId: string, rawBody: unknown): Promise<MessageDto> {
  const { body } = parseInput(sendMessageBodySchema, rawBody, INVALID);
  const conversation = await orgConversation(actor, conversationId);

  const result = await getPrisma().$transaction(async (tx) => {
    const customer = await tx.user.findFirst({ where: { id: conversation.customerId, org_id: actor.orgId, userType: "CUSTOMER", deletedAt: null }, select: { id: true, name: true } });
    if (!customer) throw conversationNotFound();
    const appended = await appendMessage(tx, {
      orgId: actor.orgId,
      conversationId: conversation.id,
      customerId: customer.id,
      customerName: customer.name,
      vehicleId: conversation.vehicleId,
      senderType: "STAFF",
      senderId: actor.id,
      body,
    });
    await activityLog.record(tx, { orgId: actor.orgId, actorId: actor.id, action: "REPLY_CHAT_MESSAGE", entity: "Conversation", entityId: conversation.id, after: { messageId: appended.message.id, customerId: customer.id } });
    return appended;
  });
  publishDelivery(result.delivery);
  return result.message;
}

export async function setConversationHandled(actor: SessionUser, conversationId: string, rawBody: unknown): Promise<{ id: string; handled: boolean }> {
  const { handled } = parseInput(handledBodySchema, rawBody, INVALID);
  const conversation = await orgConversation(actor, conversationId);
  await getPrisma().$transaction(async (tx) => {
    await tx.conversation.updateMany({
      where: { id: conversation.id, org_id: actor.orgId },
      data: handled ? { handledAt: new Date(), handledById: actor.id } : { handledAt: null, handledById: null },
    });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: handled ? "MARK_CONVERSATION_HANDLED" : "REOPEN_CONVERSATION",
      entity: "Conversation",
      entityId: conversation.id,
      before: { handled: conversation.handledAt !== null },
      after: { handled },
    });
  });
  return { id: conversation.id, handled };
}

// ---------------------------------------------------------------------------------------------
// Used by the link request rejection: the reason reaches the customer as a staff message.

/**
 * Posts `body` from `staffId` to the customer's most recent general conversation (one with no vehicle), creating it if
 * there is none. Runs in the caller's transaction; call `publishDelivery`-equivalent via the returned function after commit.
 */
export async function postStaffMessageToCustomer(
  tx: TxClient,
  input: { orgId: string; staffId: string; customerId: string; body: string }
): Promise<() => void> {
  const customer = await tx.user.findFirst({ where: { id: input.customerId, org_id: input.orgId, userType: "CUSTOMER", deletedAt: null }, select: { id: true, name: true } });
  if (!customer) return () => undefined;

  let conversation = await tx.conversation.findFirst({
    where: { org_id: input.orgId, customerId: customer.id, vehicleId: null },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    select: { id: true, vehicleId: true },
  });
  if (!conversation) {
    conversation = await tx.conversation.create({ data: { org_id: input.orgId, customerId: customer.id, vehicleId: null, lastMessageAt: new Date() }, select: { id: true, vehicleId: true } });
  }
  const appended = await appendMessage(tx, {
    orgId: input.orgId,
    conversationId: conversation.id,
    customerId: customer.id,
    customerName: customer.name,
    vehicleId: null,
    senderType: "STAFF",
    senderId: input.staffId,
    body: input.body,
  });
  return () => publishDelivery(appended.delivery);
}
