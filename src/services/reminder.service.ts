// Daily reminder checks — called once a day from
// app/api/cron/daily-vehicle-checks, which is a thin wrapper (CLAUDE.md rule
// 2): every query/decision lives here. `runDailyVehicleChecks` is the single
// entry point the route calls; everything else in this file is private.
//
// Every check excludes soft-deleted vehicles and vehicles whose row colour
// status is a cancel status ("Unit Canceled" / "Resold in Auction") — a
// fallen-through deal doesn't need staff chasing payment/transport/LC/docs
// for it anymore.
//
// Idempotency: the Notification table has no unique/dedup constraint, so
// every reminder below is guarded by an in-memory check against "was this
// exact vehicle+event combination already sent today" — loaded once per run
// (loadAlreadySentToday), not once per check, so a retry or a second
// same-day trigger of the whole cron never double-sends.

import type { Prisma } from "@prisma/client";
import { getPrisma } from "../lib/prisma.js";
import * as notificationService from "./notification.service.js";
import type { NotificationEvent } from "./notification.service.js";
import * as vehicleService from "./vehicle.service.js";
import { todayAtMidnight, CANCEL_SHIPMENT_ROW_COLOUR_NAMES } from "../lib/shipment-status.js";
import { LC_OPEN_DESTINATIONS } from "../lib/shipment-milestones.js";
import { loadEnv } from "../config/env.js";
import { buildTrackWhere } from "../lib/vehicle-track.js";

const NOT_CANCELLED: Prisma.VehicleWhereInput = {
  NOT: { rowColourStatus: { name: { in: [...CANCEL_SHIPMENT_ROW_COLOUR_NAMES] } } },
};

// Effective track (lib/vehicle-track.ts) — an FL vehicle converted to
// export needs LC/ETD-approaching/missing-document reminders too, same as
// any FC vehicle, from the moment it's converted.
const TRACK_FC_OR_CONVERTED: Prisma.VehicleWhereInput = {
  OR: [{ serialPrefix: "FC" }, { convertedToExport: true }],
};

const CRON_EVENTS: NotificationEvent[] = [
  "PAYMENT_REMINDER",
  "RIKSO_REMINDER",
  "LC_REMINDER",
  "ETD_APPROACHING",
  "MISSING_DOCUMENTS",
  "ARRIVAL_NOT_RECORDED",
];

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

/** One query per run instead of one per check — every cron-emitted
 * notification already sent today for this org, keyed "vehicleId:event". */
async function loadAlreadySentToday(orgId: string): Promise<Set<string>> {
  const rows = await getPrisma().notification.findMany({
    where: {
      org_id: orgId,
      event: { in: CRON_EVENTS },
      createdAt: { gte: todayAtMidnight() },
      vehicleId: { not: null },
    },
    select: { vehicleId: true, event: true },
  });
  return new Set(rows.map((row) => `${row.vehicleId}:${row.event}`));
}

/** Shared by every check below — skips (and doesn't even write) a
 * reminder already sent today, then marks it sent in `alreadySent` so a
 * second candidate resolving to the same key within *this* run (e.g. a
 * container-group notification revisited) doesn't double-send either. */
async function emitReminder(
  orgId: string,
  recipientUserIds: string[],
  vehicleId: string,
  event: NotificationEvent,
  title: string,
  body: string,
  alreadySent: Set<string>
): Promise<boolean> {
  const key = `${vehicleId}:${event}`;
  if (alreadySent.has(key)) return false;
  const params: notificationService.EmitParams = { orgId, event, title, body, vehicleId, recipientUserIds };
  await notificationService.emit(getPrisma(), params);
  notificationService.notifyRealtime(params);
  alreadySent.add(key);
  return true;
}

const PAYMENT_REMINDER_DAYS = new Set([2, 4, 6]);

/** "Pay within a week" — every 2 days across the first week (days 2/4/6
 * after purchase), then every day once a week has passed without payment. */
async function runPaymentReminders(
  orgId: string,
  recipientUserIds: string[],
  alreadySent: Set<string>
): Promise<number> {
  const today = todayAtMidnight();
  const vehicles = await getPrisma().vehicle.findMany({
    where: {
      org_id: orgId,
      deletedAt: null,
      purchaseDate: { not: null },
      OR: [{ auctionBillPaid: null }, { auctionBillPaid: false }],
      ...NOT_CANCELLED,
    },
    select: { id: true, serial: true, purchaseDate: true },
  });

  let sent = 0;
  for (const vehicle of vehicles) {
    const daysSincePurchase = daysBetween(vehicle.purchaseDate!, today);
    const due = daysSincePurchase > 7 || PAYMENT_REMINDER_DAYS.has(daysSincePurchase);
    if (!due) continue;
    const body =
      daysSincePurchase > 7
        ? `${vehicle.serial}'s auction bill is still unpaid, ${daysSincePurchase} days after purchase.`
        : `${vehicle.serial}'s auction bill is due within the week — ${daysSincePurchase} day${daysSincePurchase === 1 ? "" : "s"} since purchase.`;
    if (await emitReminder(orgId, recipientUserIds, vehicle.id, "PAYMENT_REMINDER", "Payment Reminder", body, alreadySent)) {
      sent++;
    }
  }
  return sent;
}

/** Once the bill's paid, remind daily until a transport company ("Rikso")
 * is assigned. */
async function runRiksoReminders(
  orgId: string,
  recipientUserIds: string[],
  alreadySent: Set<string>
): Promise<number> {
  const vehicles = await getPrisma().vehicle.findMany({
    where: { org_id: orgId, deletedAt: null, auctionBillPaid: true, transportById: null, ...NOT_CANCELLED },
    select: { id: true, serial: true },
  });

  let sent = 0;
  for (const vehicle of vehicles) {
    const body = `${vehicle.serial} still needs a transport company (Rikso) assigned.`;
    if (await emitReminder(orgId, recipientUserIds, vehicle.id, "RIKSO_REMINDER", "Rikso Reminder", body, alreadySent)) {
      sent++;
    }
  }
  return sent;
}

/** FC vehicles shipping to Sri Lanka/Bangladesh need an LC opened — remind
 * daily until an LC document is uploaded. */
async function runLcReminders(
  orgId: string,
  recipientUserIds: string[],
  alreadySent: Set<string>
): Promise<number> {
  const vehicles = await getPrisma().vehicle.findMany({
    where: {
      org_id: orgId,
      deletedAt: null,
      ...TRACK_FC_OR_CONVERTED,
      etd: { not: null },
      destination: { in: [...LC_OPEN_DESTINATIONS] },
      ...NOT_CANCELLED,
    },
    select: {
      id: true,
      serial: true,
      documents: { where: { documentType: "LC" }, select: { id: true }, take: 1 },
    },
  });

  let sent = 0;
  for (const vehicle of vehicles) {
    if (vehicle.documents.length > 0) continue;
    const body = `${vehicle.serial} needs its LC (Letter of Credit) opened.`;
    if (await emitReminder(orgId, recipientUserIds, vehicle.id, "LC_REMINDER", "LC Reminder", body, alreadySent)) {
      sent++;
    }
  }
  return sent;
}

/** 3 days before ETD: RORO vehicles get their own notification each;
 * Container vehicles sharing the same Container Number + ETD are on the same
 * container, so they share one notification instead of one each. */
async function runEtdApproachingReminders(
  orgId: string,
  recipientUserIds: string[],
  alreadySent: Set<string>
): Promise<number> {
  const target = addDays(todayAtMidnight(), 3);
  const dayAfterTarget = addDays(target, 1);
  const vehicles = await getPrisma().vehicle.findMany({
    where: {
      org_id: orgId,
      deletedAt: null,
      ...TRACK_FC_OR_CONVERTED,
      etd: { gte: target, lt: dayAfterTarget },
      ...NOT_CANCELLED,
    },
    select: { id: true, serial: true, shippingMethod: true, containerNumber: true, etd: true },
  });

  const containerGroups = new Map<string, (typeof vehicles)[number][]>();
  const singles: (typeof vehicles)[number][] = [];
  for (const vehicle of vehicles) {
    if (vehicle.shippingMethod === "CONTAINER" && vehicle.containerNumber) {
      const key = `${vehicle.containerNumber}:${vehicle.etd!.toISOString()}`;
      const group = containerGroups.get(key) ?? [];
      group.push(vehicle);
      containerGroups.set(key, group);
    } else {
      singles.push(vehicle);
    }
  }

  let sent = 0;
  for (const vehicle of singles) {
    const body = `${vehicle.serial}'s ETD is in 3 days (${vehicle.etd!.toISOString().slice(0, 10)}).`;
    if (await emitReminder(orgId, recipientUserIds, vehicle.id, "ETD_APPROACHING", "ETD Approaching", body, alreadySent)) {
      sent++;
    }
  }
  for (const group of containerGroups.values()) {
    const [first, ...rest] = group;
    if (!first) continue;
    const body =
      rest.length > 0
        ? `${group.map((v) => v.serial).join(", ")} are on the same container (ETD ${first.etd!.toISOString().slice(0, 10)}, in 3 days).`
        : `${first.serial}'s ETD is in 3 days (${first.etd!.toISOString().slice(0, 10)}).`;
    // Linked to the first vehicle in the group — a notification can only
    // point at one vehicle, so clicking it opens one of the container-mates.
    if (await emitReminder(orgId, recipientUserIds, first.id, "ETD_APPROACHING", "ETD Approaching", body, alreadySent)) {
      sent++;
    }
  }
  return sent;
}

/** Same 3-days-before-ETD trigger as the check above, but always
 * per-vehicle — a container-mate's document status can differ from its
 * neighbours', so this one is never grouped. Checks EC (all FC), LC
 * (Sri Lanka/Bangladesh only), and Inspection Report (only when the
 * vehicle's own Inspection flag is Yes — a vehicle marked "No" never gets
 * an Inspection Report upload slot in the form at all, so it can never
 * satisfy this check and shouldn't be nagged about it). */
async function runMissingDocumentReminders(
  orgId: string,
  recipientUserIds: string[],
  alreadySent: Set<string>
): Promise<number> {
  const target = addDays(todayAtMidnight(), 3);
  const dayAfterTarget = addDays(target, 1);
  const vehicles = await getPrisma().vehicle.findMany({
    where: {
      org_id: orgId,
      deletedAt: null,
      ...TRACK_FC_OR_CONVERTED,
      etd: { gte: target, lt: dayAfterTarget },
      ...NOT_CANCELLED,
    },
    select: {
      id: true,
      serial: true,
      destination: true,
      hasInspection: true,
      documents: { select: { documentType: true } },
    },
  });

  let sent = 0;
  for (const vehicle of vehicles) {
    const uploadedTypes = new Set(vehicle.documents.map((doc) => doc.documentType));
    const missing: string[] = [];
    if (!uploadedTypes.has("EC")) missing.push("EC document");
    if (vehicle.destination && LC_OPEN_DESTINATIONS.has(vehicle.destination) && !uploadedTypes.has("LC")) {
      missing.push("LC document");
    }
    if (vehicle.hasInspection && !uploadedTypes.has("INSPECTION_REPORT")) missing.push("Inspection report");
    if (missing.length === 0) continue;

    const body = `${vehicle.serial}'s ETD is in 3 days — still missing: ${missing.join(", ")}.`;
    if (
      await emitReminder(orgId, recipientUserIds, vehicle.id, "MISSING_DOCUMENTS", "Missing Documents", body, alreadySent)
    ) {
      sent++;
    }
  }
  return sent;
}

/**
 * Vehicles that shipped a long time ago and still have no ARRIVED (or DELIVERED) milestone: staff are reminded to mark them
 * arrived. First on the day the threshold (ARRIVAL_REMINDER_DAYS) is reached, then once a week, so it nags without flooding.
 * Only export-track vehicles that are not cancelled or deleted. Once a day per vehicle at most (alreadySent).
 */
async function runArrivalReminders(orgId: string, recipientUserIds: string[], alreadySent: Set<string>): Promise<number> {
  const threshold = loadEnv().ARRIVAL_REMINDER_DAYS;
  const today = todayAtMidnight();
  const cutoff = addDays(today, -threshold);

  const prisma = getPrisma();
  const shippedRows = await prisma.vehicleMilestone.findMany({
    where: { org_id: orgId, type: "SHIPPED", occurredAt: { lte: cutoff } },
    select: { vehicleId: true, occurredAt: true },
  });
  if (shippedRows.length === 0) return 0;
  const shippedIds = shippedRows.map((m) => m.vehicleId);
  const doneRows = await prisma.vehicleMilestone.findMany({
    where: { org_id: orgId, vehicleId: { in: shippedIds }, type: { in: ["ARRIVED", "DELIVERED"] } },
    select: { vehicleId: true },
  });
  const done = new Set(doneRows.map((m) => m.vehicleId));
  const shippedAtById = new Map(shippedRows.map((m) => [m.vehicleId, m.occurredAt]));
  const openIds = shippedIds.filter((id) => !done.has(id));

  const vehicles = await prisma.vehicle.findMany({
    where: { AND: [{ org_id: orgId, deletedAt: null, id: { in: openIds } }, buildTrackWhere("FC"), NOT_CANCELLED] },
    select: { id: true, serial: true },
  });

  let sent = 0;
  for (const vehicle of vehicles) {
    const shippedAt = shippedAtById.get(vehicle.id);
    if (!shippedAt) continue;
    const days = daysBetween(shippedAt, today);
    // The threshold day, then every 7th day after it.
    if (days < threshold || (days - threshold) % 7 !== 0) continue;
    const body = `${vehicle.serial} shipped ${days} days ago and has no arrival recorded.`;
    if (await emitReminder(orgId, recipientUserIds, vehicle.id, "ARRIVAL_NOT_RECORDED", "Arrival not recorded", body, alreadySent)) sent++;
  }
  return sent;
}

export interface DailyCheckSummary {
  shippedTransitions: number;
  paymentReminders: number;
  riksoReminders: number;
  lcReminders: number;
  etdApproachingReminders: number;
  missingDocumentReminders: number;
  arrivalReminders: number;
  errors: string[];
}

/** The cron route's single entry point. Each check is isolated in its own
 * try/catch so one failing check (a bad row, a transient DB hiccup) never
 * blocks the rest — the summary's `errors` array reports what happened. */
export async function runDailyVehicleChecks(orgId: string): Promise<DailyCheckSummary> {
  const errors: string[] = [];
  const summary: DailyCheckSummary = {
    shippedTransitions: 0,
    paymentReminders: 0,
    riksoReminders: 0,
    lcReminders: 0,
    etdApproachingReminders: 0,
    missingDocumentReminders: 0,
    arrivalReminders: 0,
    errors,
  };

  // Runs first — a vehicle that flips to Shipped this run shouldn't also
  // pick up an ETD-approaching reminder a moment later in the same run.
  try {
    summary.shippedTransitions = await vehicleService.runDailyShipmentStatusTransitions(orgId);
  } catch (error) {
    errors.push(`shippedTransitions: ${String(error)}`);
  }

  const recipientUserIds = await notificationService.listNotifiableStaffIds(getPrisma(), orgId);
  const alreadySent = await loadAlreadySentToday(orgId);

  try {
    summary.paymentReminders = await runPaymentReminders(orgId, recipientUserIds, alreadySent);
  } catch (error) {
    errors.push(`paymentReminders: ${String(error)}`);
  }

  try {
    summary.riksoReminders = await runRiksoReminders(orgId, recipientUserIds, alreadySent);
  } catch (error) {
    errors.push(`riksoReminders: ${String(error)}`);
  }

  try {
    summary.lcReminders = await runLcReminders(orgId, recipientUserIds, alreadySent);
  } catch (error) {
    errors.push(`lcReminders: ${String(error)}`);
  }

  try {
    summary.etdApproachingReminders = await runEtdApproachingReminders(orgId, recipientUserIds, alreadySent);
  } catch (error) {
    errors.push(`etdApproachingReminders: ${String(error)}`);
  }

  try {
    summary.missingDocumentReminders = await runMissingDocumentReminders(orgId, recipientUserIds, alreadySent);
  } catch (error) {
    errors.push(`missingDocumentReminders: ${String(error)}`);
  }

  try {
    summary.arrivalReminders = await runArrivalReminders(orgId, recipientUserIds, alreadySent);
  } catch (error) {
    errors.push(`arrivalReminders: ${String(error)}`);
  }

  return summary;
}
