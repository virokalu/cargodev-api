// Retention: the daily job removes data that has outlived its purpose. Per org, in ONE transaction, at most BATCH rows per table
// per run (a big backlog is worked off over several days and never holds a long lock):
//
//   OtpCode              expired more than RETENTION_OTP_DAYS ago
//   CustomerSession      expired, or revoked, more than RETENTION_SESSION_DAYS ago
//   RefreshToken         the same, for staff mobile sessions
//   Notification         customers' alerts that are READ and older than RETENTION_ALERT_DAYS (staff notifications are untouched)
//   Unverified accounts  self-registered customers who never verified their email within UNVERIFIED_ACCOUNT_DAYS and own nothing:
//                        no vehicle, no chat, no link request. They are anonymised exactly like an account the customer
//                        deleted (their name and address are gone, the row stays because the audit trail points at it)
//
// NOT touched, on purpose: chats (Conversation, Message) and enquiries. How long they are kept is an open question for the
// business (docs/privacy-checklist.md).
//
// DRY RUN (RETENTION_DRY_RUN, true unless set to false): the same queries run and the counts are returned, but NOTHING is
// removed and no summary row is written. The deploy that adds retention therefore changes no data until it is switched on.
//
// Idempotent: a second run finds nothing. The advisory lock around the daily job keeps two instances from running it together.
// Every deletion is scoped by org_id in its own where clause. One summary ActivityLog row per org per run carries COUNTS ONLY
// (no ids, no names, no emails), and is written only when something was removed.

import type { Prisma } from "@prisma/client";
import { loadEnv } from "../config/env.js";
import { getPrisma } from "../lib/prisma.js";
import * as activityLog from "./activity-log.service.js";
import { anonymisedCustomerData } from "./customer-auth.service.js";

export const RETENTION_BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionCounts {
  otpCodes: number;
  customerSessions: number;
  refreshTokens: number;
  readAlerts: number;
  unverifiedAccounts: number;
}

export const NOTHING_REMOVED: RetentionCounts = { otpCodes: 0, customerSessions: 0, refreshTokens: 0, readAlerts: 0, unverifiedAccounts: 0 };

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

type Tx = Prisma.TransactionClient;

/**
 * `skipped` is 1 when the org has no administrator to attribute the summary row to (nothing is removed then).
 * `dryRun` true means the counts are what WOULD be removed; nothing was.
 */
export async function runRetention(orgId: string, now: Date = new Date()): Promise<RetentionCounts & { skipped: number; dryRun: boolean }> {
  const env = loadEnv();
  const dryRun = env.RETENTION_DRY_RUN;
  const otpCutoff = daysAgo(now, env.RETENTION_OTP_DAYS);
  const sessionCutoff = daysAgo(now, env.RETENTION_SESSION_DAYS);
  const alertCutoff = daysAgo(now, env.RETENTION_ALERT_DAYS);
  const unverifiedCutoff = daysAgo(now, env.UNVERIFIED_ACCOUNT_DAYS);

  const prisma = getPrisma();
  // The summary row needs a user to be attributed to (the audit trail points at a user). The org's oldest administrator stands in
  // for the system. Without one, nothing is removed: a change that cannot be logged is not made.
  const actor = await prisma.user.findFirst({
    where: { org_id: orgId, userType: "STAFF", role: "ADMINISTRATOR" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!actor && !dryRun) return { ...NOTHING_REMOVED, skipped: 1, dryRun };

  return prisma.$transaction(async (tx) => {
    const counts: RetentionCounts = {
      otpCodes: await removeExpiredOtps(tx, orgId, otpCutoff, dryRun),
      customerSessions: await removeOldSessions(tx, orgId, sessionCutoff, "customerSession", dryRun),
      refreshTokens: await removeOldSessions(tx, orgId, sessionCutoff, "refreshToken", dryRun),
      readAlerts: await removeReadAlerts(tx, orgId, alertCutoff, dryRun),
      unverifiedAccounts: await anonymiseUnverified(tx, orgId, unverifiedCutoff, now, dryRun),
    };

    if (!dryRun && actor && Object.values(counts).some((n) => n > 0)) {
      await activityLog.record(tx, {
        orgId,
        actorId: actor.id,
        action: "RETENTION_CLEANUP",
        entity: "Retention",
        entityId: orgId,
        after: { ...counts, automated: true },
      });
    }
    return { ...counts, skipped: 0, dryRun };
  });
}

async function removeExpiredOtps(tx: Tx, orgId: string, cutoff: Date, dryRun: boolean): Promise<number> {
  const rows = await tx.otpCode.findMany({ where: { org_id: orgId, expiresAt: { lt: cutoff } }, select: { id: true }, orderBy: { expiresAt: "asc" }, take: RETENTION_BATCH });
  if (rows.length === 0) return 0;
  if (dryRun) return rows.length;
  return (await tx.otpCode.deleteMany({ where: { org_id: orgId, id: { in: rows.map((r) => r.id) } } })).count;
}

async function removeOldSessions(tx: Tx, orgId: string, cutoff: Date, table: "customerSession" | "refreshToken", dryRun: boolean): Promise<number> {
  // Expired, or revoked, longer ago than the cutoff. A session that is still valid, or was revoked recently, stays.
  const old = [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }];
  const ids = (
    table === "customerSession"
      ? await tx.customerSession.findMany({ where: { org_id: orgId, OR: old }, select: { id: true }, orderBy: { createdAt: "asc" }, take: RETENTION_BATCH })
      : await tx.refreshToken.findMany({ where: { org_id: orgId, OR: old }, select: { id: true }, orderBy: { createdAt: "asc" }, take: RETENTION_BATCH })
  ).map((r) => r.id);
  if (ids.length === 0) return 0;
  if (dryRun) return ids.length;
  return (
    table === "customerSession"
      ? await tx.customerSession.deleteMany({ where: { org_id: orgId, id: { in: ids } } })
      : await tx.refreshToken.deleteMany({ where: { org_id: orgId, id: { in: ids } } })
  ).count;
}

async function removeReadAlerts(tx: Tx, orgId: string, cutoff: Date, dryRun: boolean): Promise<number> {
  const rows = await tx.notification.findMany({
    where: { org_id: orgId, isRead: true, createdAt: { lt: cutoff }, user: { userType: "CUSTOMER" } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: RETENTION_BATCH,
  });
  if (rows.length === 0) return 0;
  if (dryRun) return rows.length;
  return (await tx.notification.deleteMany({ where: { org_id: orgId, id: { in: rows.map((r) => r.id) } } })).count;
}

async function anonymiseUnverified(tx: Tx, orgId: string, cutoff: Date, now: Date, dryRun: boolean): Promise<number> {
  const candidates = await tx.user.findMany({
    where: {
      org_id: orgId,
      userType: "CUSTOMER",
      deletedAt: null,
      emailVerifiedAt: null,
      createdAt: { lt: cutoff },
      // Self-registered: the register step wrote this log row. A customer staff created is never touched.
      activityLogs: { some: { org_id: orgId, action: "CUSTOMER_REGISTER" } },
      // Owns nothing: no vehicle, no chat, no link request (pending or decided).
      vehicles: { none: {} },
      conversations: { none: {} },
      linkRequests: { none: {} },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: RETENTION_BATCH,
  });
  if (candidates.length === 0) return 0;
  if (dryRun) return candidates.length;
  const ids = candidates.map((c) => c.id);

  const anonymised = await tx.user.updateMany({
    where: { org_id: orgId, userType: "CUSTOMER", deletedAt: null, emailVerifiedAt: null, id: { in: ids } },
    data: anonymisedCustomerData(now),
  });
  // Whatever else held their address or a way to sign in.
  await tx.otpCode.deleteMany({ where: { org_id: orgId, userId: { in: ids } } });
  await tx.customerSession.deleteMany({ where: { org_id: orgId, userId: { in: ids } } });
  await tx.deviceToken.deleteMany({ where: { org_id: orgId, userId: { in: ids } } });
  await tx.notification.deleteMany({ where: { org_id: orgId, userId: { in: ids } } });
  await tx.notificationPreference.deleteMany({ where: { org_id: orgId, userId: { in: ids } } });
  return anonymised.count;
}
