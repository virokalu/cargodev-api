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
import { getPrisma } from "../lib/prisma.js";
import { sendExpoPushNotifications } from "../lib/expo-push.js";
import { listDeviceTokensForUsers } from "./device-token.service.js";

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

/** Post-commit, best-effort mobile push — never awaited by callers, never
 * throws into the request path. The notification is already durably saved by
 * emit() regardless of whether this succeeds; a delivery failure just means
 * the recipient sees it on next refresh instead of as an OS push. */
export function notifyRealtime(params: EmitParams): void {
  sendMobilePush(params).catch((e: unknown) => console.error("Expo push failed", e));
}

async function sendMobilePush(params: EmitParams): Promise<void> {
  const tokens = await listDeviceTokensForUsers(params.orgId, params.recipientUserIds);
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
