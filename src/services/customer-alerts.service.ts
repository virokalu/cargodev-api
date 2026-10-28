// What a customer sees and controls about their own notifications: the alert list (grouped by day), marking alerts
// read, notification preferences, push devices, and the presence heartbeat. Every query filters by org AND the
// customer's own id, both from the verified token. Responses are built field by field.

import { Expo } from "expo-server-sdk";
import {
  DEFAULT_DEPARTURE_LEAD_DAYS,
  TOGGLEABLE_EVENTS,
} from "../config/customer-events.js";
import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import {
  alertListQuerySchema,
  deviceBodySchema,
  markReadBodySchema,
  preferencesBodySchema,
} from "../validation/customer-notifications.schema.js";
import * as activityLog from "./activity-log.service.js";
import { customerVehicleWhere, type CustomerPrincipalLike } from "./customer-data.service.js";

const INVALID_INPUT = "Please fix the highlighted fields.";

// ---------------------------------------------------------------------------------------------
// Alerts

export interface CustomerAlert {
  id: string;
  event: string;
  title: string;
  body: string;
  isRead: boolean;
  vehicleId: string | null;
  createdAt: string;
}

export interface AlertDay {
  /** Calendar day in UTC, YYYY-MM-DD. */
  date: string;
  alerts: CustomerAlert[];
}

export interface AlertsPage {
  days: AlertDay[];
  unreadCount: number;
  total: number;
  page: number;
  pageSize: number;
}

export async function listAlerts(customer: CustomerPrincipalLike, rawQuery: unknown): Promise<AlertsPage> {
  const { page, pageSize } = parseInput(alertListQuerySchema, rawQuery);
  const prisma = getPrisma();
  const where = { org_id: customer.orgId, userId: customer.id };

  const [total, unreadCount, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, isRead: false } }),
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, event: true, title: true, body: true, isRead: true, vehicleId: true, createdAt: true },
    }),
  ]);

  // A vehicle id is shown only while the customer may still see that vehicle (it can be hidden or cancelled later).
  const vehicleIds = [...new Set(rows.map((r) => r.vehicleId).filter((id): id is string => id !== null))];
  const visible = vehicleIds.length
    ? new Set(
        (
          await prisma.vehicle.findMany({
            where: { AND: [customerVehicleWhere(customer), { id: { in: vehicleIds } }] },
            select: { id: true },
          })
        ).map((v) => v.id)
      )
    : new Set<string>();

  const days: AlertDay[] = [];
  for (const row of rows) {
    const date = row.createdAt.toISOString().slice(0, 10);
    let day = days[days.length - 1];
    if (!day || day.date !== date) {
      day = { date, alerts: [] };
      days.push(day);
    }
    day.alerts.push({
      id: row.id,
      event: row.event,
      title: row.title,
      body: row.body,
      isRead: row.isRead,
      vehicleId: row.vehicleId && visible.has(row.vehicleId) ? row.vehicleId : null,
      createdAt: row.createdAt.toISOString(),
    });
  }
  return { days, unreadCount, total, page, pageSize };
}

/** Marks the customer's OWN alerts read. An id that is not theirs changes nothing and is not an error (idempotent, reveals nothing). */
export async function markAlertsRead(customer: CustomerPrincipalLike, rawBody: unknown): Promise<{ updated: number }> {
  const body = parseInput(markReadBodySchema, rawBody, INVALID_INPUT);
  const scope = { org_id: customer.orgId, userId: customer.id, isRead: false };
  const result = await getPrisma().notification.updateMany({
    where: "ids" in body ? { org_id: customer.orgId, userId: customer.id, isRead: false, id: { in: body.ids } } : scope,
    data: { isRead: true },
  });
  return { updated: result.count };
}

// ---------------------------------------------------------------------------------------------
// Preferences

export interface CustomerPreferences {
  events: Record<string, boolean>;
  departureLeadDays: number;
  pushEnabled: boolean;
  emailEnabled: boolean;
  whatsappEnabled: boolean;
}

function toPreferences(row: { events: unknown; departureLeadDays: number; pushEnabled: boolean; emailEnabled: boolean; whatsappEnabled: boolean } | null): CustomerPreferences {
  const stored = row && typeof row.events === "object" && row.events !== null ? (row.events as Record<string, unknown>) : {};
  return {
    // every switchable event is listed, "on" unless the customer turned it off
    events: Object.fromEntries(TOGGLEABLE_EVENTS.map((event) => [event, stored[event] !== false])),
    departureLeadDays: row?.departureLeadDays ?? DEFAULT_DEPARTURE_LEAD_DAYS,
    pushEnabled: row?.pushEnabled ?? true,
    emailEnabled: row?.emailEnabled ?? true,
    whatsappEnabled: row?.whatsappEnabled ?? false,
  };
}

const PREFERENCE_SELECT = { events: true, departureLeadDays: true, pushEnabled: true, emailEnabled: true, whatsappEnabled: true } as const;

export async function getPreferences(customer: CustomerPrincipalLike): Promise<CustomerPreferences> {
  const row = await getPrisma().notificationPreference.findFirst({ where: { org_id: customer.orgId, userId: customer.id }, select: PREFERENCE_SELECT });
  return toPreferences(row);
}

export async function updatePreferences(customer: CustomerPrincipalLike, rawBody: unknown): Promise<CustomerPreferences> {
  const body = parseInput(preferencesBodySchema, rawBody, INVALID_INPUT);
  return getPrisma().$transaction(async (tx) => {
    const existing = await tx.notificationPreference.findFirst({ where: { org_id: customer.orgId, userId: customer.id }, select: PREFERENCE_SELECT });
    const before = toPreferences(existing);
    const after: CustomerPreferences = {
      events: { ...before.events, ...(body.events ?? {}) } as Record<string, boolean>,
      departureLeadDays: body.departureLeadDays ?? before.departureLeadDays,
      pushEnabled: body.pushEnabled ?? before.pushEnabled,
      emailEnabled: body.emailEnabled ?? before.emailEnabled,
      whatsappEnabled: body.whatsappEnabled ?? before.whatsappEnabled,
    };
    const data = { ...after, events: after.events };
    await tx.notificationPreference.upsert({
      where: { userId: customer.id, org_id: customer.orgId },
      create: { org_id: customer.orgId, userId: customer.id, ...data },
      update: data,
    });
    await activityLog.record(tx, {
      orgId: customer.orgId,
      actorId: customer.id,
      action: "UPDATE_NOTIFICATION_PREFERENCES",
      entity: "Customer",
      entityId: customer.id,
      before,
      after,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------------------------
// Push devices

export const MAX_DEVICES_PER_CUSTOMER = 10;

export interface CustomerDevice {
  id: string;
  platform: string;
  lastSeenAt: string;
}

/** Registers or refreshes this customer's device. The token is never echoed back. */
export async function registerCustomerDevice(customer: CustomerPrincipalLike, rawBody: unknown): Promise<CustomerDevice> {
  const { expoPushToken, platform, appVersion } = parseInput(deviceBodySchema, rawBody, "Please provide a valid Expo push token.");
  const invalid = () => new ServiceError("VALIDATION", "Not a valid Expo push token.", { expoPushToken: "Not a valid Expo push token" });
  if (!Expo.isExpoPushToken(expoPushToken)) throw invalid();

  const prisma = getPrisma();
  const existing = await prisma.deviceToken.findFirst({ where: { expoPushToken }, select: { id: true, userId: true, org_id: true } });
  if (existing && existing.userId !== customer.id) {
    // A token that belongs to a staff member's device is never taken over by a customer account.
    const holder = await prisma.user.findFirst({ where: { id: existing.userId, org_id: existing.org_id }, select: { userType: true } });
    if (holder?.userType !== "CUSTOMER") throw invalid();
  }

  const saved = await prisma.$transaction(async (tx) => {
    if (!existing) {
      const mine = await tx.deviceToken.findMany({ where: { org_id: customer.orgId, userId: customer.id }, orderBy: { lastSeenAt: "asc" }, select: { id: true } });
      const surplus = mine.length - (MAX_DEVICES_PER_CUSTOMER - 1);
      if (surplus > 0) await tx.deviceToken.deleteMany({ where: { org_id: customer.orgId, userId: customer.id, id: { in: mine.slice(0, surplus).map((d) => d.id) } } });
    }
    return tx.deviceToken.upsert({
      where: { expoPushToken },
      create: { org_id: customer.orgId, userId: customer.id, expoPushToken, platform, appVersion: appVersion ?? null },
      update: { org_id: customer.orgId, userId: customer.id, platform, appVersion: appVersion ?? null, lastSeenAt: new Date() },
    });
  });
  return { id: saved.id, platform: saved.platform, lastSeenAt: saved.lastSeenAt.toISOString() };
}

/** Removes one of the customer's own devices. Another customer's device (or an unknown id) is the same 404. */
export async function deleteCustomerDevice(customer: CustomerPrincipalLike, deviceId: string): Promise<void> {
  const result = await getPrisma().deviceToken.deleteMany({ where: { id: deviceId, org_id: customer.orgId, userId: customer.id } });
  if (result.count === 0) throw new ServiceError("NOT_FOUND", "Device not found.");
}

// ---------------------------------------------------------------------------------------------
// Presence

/** The stored value is only rewritten when it is older than this, so a chatty client cannot cause a write storm. */
export const PRESENCE_MIN_WRITE_INTERVAL_MS = 60_000;

/** Records "seen now". Answers the same whether or not a write happened. */
export async function recordHeartbeat(customer: CustomerPrincipalLike, now = new Date()): Promise<{ ok: true }> {
  await getPrisma().user.updateMany({
    where: {
      id: customer.id,
      org_id: customer.orgId,
      userType: "CUSTOMER",
      OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: new Date(now.getTime() - PRESENCE_MIN_WRITE_INTERVAL_MS) } }],
    },
    data: { lastActiveAt: now },
  });
  return { ok: true };
}
