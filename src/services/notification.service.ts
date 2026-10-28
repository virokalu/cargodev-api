// Notifications — in-app fan-out core. emit() writes Notification rows inside
// the caller's transaction (same reasoning as activity-log.service.ts's
// record(): a mutation that "succeeds" without its notification, or vice
// versa, would leave staff unaware of things that actually happened).
// Mobile push happens separately, after the transaction has committed — Expo
// is an external network call and has no place inside a DB transaction
// (best-effort, called right after the transaction resolves, never blocks
// the user-visible action). There is no Pusher channel in this API; clients
// read missed notifications through the REST endpoints.

import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { getEventBus } from "../lib/events.js";
import { safeError } from "../lib/redact.js";
import { getPrisma } from "../lib/prisma.js";
import { sendExpoPushNotifications } from "../lib/expo-push.js";
import { listDeviceTokensForUsers } from "./device-token.service.js";
import { CUSTOMER_EVENTS, isCustomerEvent } from "../config/customer-events.js";
import { queueEmail } from "../lib/email-queue.js";
import { notificationEmail } from "../lib/email-templates.js";

type TxClient = Prisma.TransactionClient;

// Full set per prisma/schema.prisma:447. `event` is deliberately a plain
// String column, not a Prisma enum — new values here never need a migration.
//
// Event-driven (fired synchronously from vehicle.service.ts mutations):
//   BOOKING_RECEIVED, SHIPMENT_REVERTED_TO_PENDING, SHIPPED,
//   VEHICLE_PURCHASED, AUCTION_BILL_PAID, DOCUMENT_UPLOADED
// Cron-driven (lib/services/reminder.service.ts, app/api/cron/daily-vehicle-
// checks): PAYMENT_REMINDER, RIKSO_REMINDER, LC_REMINDER, ETD_APPROACHING,
// MISSING_DOCUMENTS
// Reserved, not emitted by anything yet: NAME_CHANGE_DEADLINE
export type NotificationEvent =
  | "VEHICLE_LINK_REQUESTED"
  | "LINK_REQUEST_APPROVED"
  | "LINK_REQUEST_REJECTED"
  | "ARRIVAL_NOT_RECORDED"
  | "PHOTOS_ADDED"
  | "DOCUMENTS_READY"
  | "DEPARTURE_REMINDER"
  | "NEW_STOCK"
  | "ENQUIRY_RECEIVED"
  | "CHAT_MESSAGE"
  | "BOOKING_RECEIVED"
  | "SHIPMENT_REVERTED_TO_PENDING"
  | "SHIPPED"
  | "NAME_CHANGE_DEADLINE"
  | "DOCUMENT_UPLOADED"
  | "VEHICLE_PURCHASED"
  | "AUCTION_BILL_PAID"
  | "PAYMENT_REMINDER"
  | "RIKSO_REMINDER"
  | "LC_REMINDER"
  | "ETD_APPROACHING"
  | "MISSING_DOCUMENTS";

export interface EmitParams {
  orgId: string;
  event: NotificationEvent;
  title: string;
  body: string;
  vehicleId?: string;
  recipientUserIds: string[];
  // Populated by emit() itself (userId -> that recipient's own Notification
  // row id) — never set by callers. Every call site builds one EmitParams
  // object and passes that *same reference* to both emit(tx, params) and,
  // once the transaction commits, notifyRealtime(params); stashing the
  // created ids back onto it here is how notifyRealtime's mobile-push branch
  // later learns the id it needs without every call site having to thread it
  // through separately.
  recipientNotificationIds?: Record<string, string>;
}

/** Admin/Manager staff in the org, minus whoever caused the event (no point
 * notifying someone about their own action). loginEnabled filters out
 * deactivated accounts, same guard used everywhere else staff are listed. */
export async function listNotifiableStaffIds(
  tx: TxClient,
  orgId: string,
  excludeUserId?: string
): Promise<string[]> {
  const staff = await tx.user.findMany({
    where: {
      org_id: orgId,
      userType: "STAFF",
      role: { in: ["ADMINISTRATOR", "MANAGER"] },
      loginEnabled: true,
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
    select: { id: true },
  });
  return staff.map((u) => u.id);
}

/** Writes one Notification row per recipient, inside the caller's
 * transaction. No-ops if there are no recipients. Call notifyRealtime with
 * the same params once the transaction has actually committed. */
export async function emit(tx: TxClient, params: EmitParams): Promise<void> {
  if (params.recipientUserIds.length === 0) return;
  // A customer who switched this event off gets no alert row, no push and no email (the list is narrowed in place,
  // so notifyRealtime below only ever targets recipients that really got a row).
  params.recipientUserIds = await withoutOptedOutCustomers(tx, params);
  if (params.recipientUserIds.length === 0) return;
  // createManyAndReturn (not plain createMany) so each row's own id is known
  // here — notifyRealtime's mobile-push branch needs it per recipient, see
  // EmitParams.recipientNotificationIds above.
  const created = await tx.notification.createManyAndReturn({
    data: params.recipientUserIds.map((userId) => ({
      org_id: params.orgId,
      userId,
      event: params.event,
      title: params.title,
      body: params.body,
      vehicleId: params.vehicleId ?? null,
    })),
    select: { id: true, userId: true },
  });
  params.recipientNotificationIds = Object.fromEntries(created.map((row) => [row.userId, row.id]));
}

/** Preferences are stored as { "<event>": boolean }; a missing key means "on". Events a customer cannot switch off are always on. */
function eventIsOff(events: unknown, event: string): boolean {
  if (!isCustomerEvent(event) || !CUSTOMER_EVENTS[event].toggleable) return false;
  return typeof events === "object" && events !== null && (events as Record<string, unknown>)[event] === false;
}

async function withoutOptedOutCustomers(tx: TxClient, params: EmitParams): Promise<string[]> {
  const customers = await tx.user.findMany({
    where: { org_id: params.orgId, id: { in: params.recipientUserIds }, userType: "CUSTOMER" },
    select: { id: true },
  });
  if (customers.length === 0) return params.recipientUserIds;
  const preferences = await tx.notificationPreference.findMany({
    where: { org_id: params.orgId, userId: { in: customers.map((c) => c.id) } },
    select: { userId: true, events: true },
  });
  const off = new Set(preferences.filter((p) => eventIsOff(p.events, params.event)).map((p) => p.userId));
  return params.recipientUserIds.filter((id) => !off.has(id));
}

/** Post-commit, best-effort delivery. Call it AFTER the transaction that ran emit()
 * has committed, with the same params object. It never throws and is never awaited:
 * the notification is already durably saved by emit(), so a delivery failure only
 * means the recipient sees it on their next read instead of live.
 *
 * Two channels: (1) one event per recipient on the event bus, which feeds any open
 * GET /notifications/stream connection; (2) Expo push to their registered devices. */
export function notifyRealtime(params: EmitParams): void {
  publishNotificationEvents(params);
  sendMobilePush(params).catch((e: unknown) => console.error("Expo push failed", safeError(e)));
  sendCustomerEmails(params).catch((e: unknown) => console.error("Customer email failed", safeError(e)));
}

/** Customers whose own settings switch a channel off. Staff have no settings row, so they are always on. */
async function customersWithChannelOff(orgId: string, userIds: string[], channel: "pushEnabled" | "emailEnabled"): Promise<Set<string>> {
  const rows = await getPrisma().notificationPreference.findMany({
    where: { org_id: orgId, userId: { in: userIds }, [channel]: false },
    select: { userId: true },
  });
  return new Set(rows.map((row) => row.userId));
}

/** Email for customer events, after the response (queueEmail), only to a verified, enabled, undeleted customer who has not switched email off. */
async function sendCustomerEmails(params: EmitParams): Promise<void> {
  if (!isCustomerEvent(params.event)) return;
  const prisma = getPrisma();
  const customers = await prisma.user.findMany({
    where: {
      org_id: params.orgId,
      id: { in: params.recipientUserIds },
      userType: "CUSTOMER",
      loginEnabled: true,
      deletedAt: null,
      emailVerifiedAt: { not: null },
      email: { not: null },
    },
    select: { id: true, email: true },
  });
  if (customers.length === 0) return;
  const off = await customersWithChannelOff(params.orgId, customers.map((c) => c.id), "emailEnabled");
  for (const customer of customers) {
    if (!customer.email || off.has(customer.id)) continue;
    queueEmail(notificationEmail(customer.email, params.title, params.body));
  }
}

/** Plain, whitelisted fields only: this is what leaves the server over a stream. */
function publishNotificationEvents(params: EmitParams): void {
  try {
    const bus = getEventBus();
    const createdAt = new Date().toISOString();
    for (const userId of params.recipientUserIds) {
      const notificationId = params.recipientNotificationIds?.[userId] ?? null;
      bus.publish({
        type: "notification",
        orgId: params.orgId,
        userId,
        id: notificationId ?? randomUUID(),
        payload: {
          id: notificationId,
          event: params.event,
          title: params.title,
          body: params.body,
          vehicleId: params.vehicleId ?? null,
          createdAt,
        },
      });
    }
  } catch (error) {
    // Publishing must never reach the caller.
    console.error("Notification event publish failed", safeError(error));
  }
}

async function sendMobilePush(params: EmitParams): Promise<void> {
  const allTokens = await listDeviceTokensForUsers(params.orgId, params.recipientUserIds);
  const pushOff = allTokens.length ? await customersWithChannelOff(params.orgId, [...new Set(allTokens.map((t) => t.userId))], "pushEnabled") : new Set<string>();
  const tokens = allTokens.filter((token) => !pushOff.has(token.userId));
  if (tokens.length === 0) return;

  // Same vehicleSerial the REST GET /notifications response resolves
  // (attachVehicleSerials below, off the same vehicleId) — resolved fresh
  // here since EmitParams only carries the vehicleId. One lookup covers
  // every recipient: a single emit() call always targets at most one
  // vehicle, never a different one per recipient.
  const vehicleSerial = params.vehicleId
    ? ((await getPrisma().vehicle.findFirst({
        where: { id: params.vehicleId, org_id: params.orgId },
        select: { serial: true },
      }))?.serial ?? null)
    : null;

  await sendExpoPushNotifications(
    tokens.map((token) => ({
      expoPushToken: token.expoPushToken,
      // notificationId is this recipient's own Notification row (set by
      // emit() above) — the mobile app marks it read on tap. Falls back to
      // null only if this device's user somehow isn't in
      // recipientNotificationIds (emit() never ran, or ran with zero
      // recipients) — shouldn't happen since sendMobilePush is only ever
      // called after emit() for the same recipient list, but a push must
      // never throw into its fire-and-forget caller over a missing id.
      data: { vehicleSerial, notificationId: params.recipientNotificationIds?.[token.userId] ?? null },
    })),
    {
      title: params.title,
      body: params.body,
      data: { event: params.event, vehicleId: params.vehicleId ?? null },
    }
  );
}

export interface NotificationListItem {
  id: string;
  event: string;
  title: string;
  body: string;
  isRead: boolean;
  vehicleId: string | null;
  // The read-only detail page is routed by serial, not id (/vehicles/[serial])
  // — resolved here, not via a Prisma relation, since Notification.vehicleId
  // has none (same reasoning/shape as vehicle.service.ts's
  // listVehicleStatusHistory resolving StatusHistory.triggeredBy to a name).
  // Null when there's no linked vehicle, or it's since been deleted.
  vehicleSerial: string | null;
  createdAt: Date;
}

const NOTIFICATION_SELECT = {
  id: true,
  event: true,
  title: true,
  body: true,
  isRead: true,
  vehicleId: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof NOTIFICATION_SELECT }>;

/** Resolves each row's vehicleId to a serial (Notification.vehicleId has no
 * Prisma relation — see NotificationListItem's vehicleSerial doc above) in
 * one batched lookup. */
async function attachVehicleSerials(orgId: string, rows: NotificationRow[]): Promise<NotificationListItem[]> {
  const vehicleIds = [...new Set(rows.map((r) => r.vehicleId).filter((id): id is string => id !== null))];
  const vehicles = vehicleIds.length
    ? await getPrisma().vehicle.findMany({
        where: { id: { in: vehicleIds }, org_id: orgId },
        select: { id: true, serial: true },
      })
    : [];
  const serialById = new Map(vehicles.map((v) => [v.id, v.serial]));

  return rows.map((row) => ({
    ...row,
    vehicleSerial: row.vehicleId ? (serialById.get(row.vehicleId) ?? null) : null,
  }));
}

// Shared by the web Notifications page (app/(dashboard)/notifications) and
// its "Load More" Server Action — one page's worth of rows per fetch,
// rather than the old capped-at-50-with-no-way-to-reach-more design.
export const NOTIFICATIONS_PAGE_SIZE = 20;

export interface NotificationListParams {
  page: number;
  pageSize: number;
}

export interface NotificationListResult {
  rows: NotificationListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Same shape as listActivityLog/listVehicles — real page/skip pagination.
 * Used by both the web app's Notifications page (page 1 on first load, then
 * one page per "Load More" click) and the mobile API. */
export async function listNotificationsPaginated(
  orgId: string,
  userId: string,
  params: NotificationListParams
): Promise<NotificationListResult> {
  const skip = (params.page - 1) * params.pageSize;

  const [total, rows] = await Promise.all([
    getPrisma().notification.count({ where: { org_id: orgId, userId } }),
    getPrisma().notification.findMany({
      where: { org_id: orgId, userId },
      orderBy: { createdAt: "desc" },
      skip,
      take: params.pageSize,
      select: NOTIFICATION_SELECT,
    }),
  ]);

  return {
    rows: await attachVehicleSerials(orgId, rows),
    total,
    page: params.page,
    pageSize: params.pageSize,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}

export async function countUnread(orgId: string, userId: string): Promise<number> {
  return getPrisma().notification.count({ where: { org_id: orgId, userId, isRead: false } });
}

/** Compound where (id + org_id + userId) enforces ownership without a
 * separate fetch-then-check round trip — an id that doesn't belong to this
 * user/org just updates zero rows, same as marking an already-read
 * notification read again. Idempotent either way, so there's nothing to
 * throw on. */
export async function markRead(orgId: string, userId: string, id: string): Promise<void> {
  await getPrisma().notification.updateMany({
    where: { id, org_id: orgId, userId },
    data: { isRead: true },
  });
}

export async function markAllRead(orgId: string, userId: string): Promise<void> {
  await getPrisma().notification.updateMany({
    where: { org_id: orgId, userId, isRead: false },
    data: { isRead: true },
  });
}
