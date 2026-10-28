// Enquiries from the public website form, and the staff inbox for them.
//
// The form has no account behind it, so: the org is the server's default org, bots are turned away quietly (hidden
// field, Turnstile when configured), the rows are tiny and bounded, and NOTHING the visitor typed is ever written to a
// log, a notification, an email or an error. Staff are told that an enquiry arrived and by whom (a name, cut short), never what it says.

import { getDefaultOrgId } from "../config/default-org.js";
import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import type { SessionUser } from "../lib/session-user.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { enquiryBodySchema, enquiryHandledSchema, enquiryListQuerySchema } from "../validation/stock.schema.js";
import * as activityLog from "./activity-log.service.js";
import { emit, listNotifiableStaffIds, notifyRealtime, type EmitParams } from "./notification.service.js";
import { publishedSlugOrNull } from "./stock.service.js";

const INVALID = "Please fix the highlighted fields.";
const NAME_IN_ALERT = 60;

/** The one answer to the form, whatever happened (stored, dropped as a bot, or a listing that no longer exists). */
export const ENQUIRY_ACCEPTED = { accepted: true } as const;

export async function createEnquiry(rawBody: unknown, meta: { ip?: string }): Promise<typeof ENQUIRY_ACCEPTED> {
  const input = parseInput(enquiryBodySchema, rawBody, INVALID);

  // A visitor never sees a hidden field. A bot that fills it gets the normal answer and nothing is kept.
  if (input.website !== undefined && input.website.trim() !== "") return ENQUIRY_ACCEPTED;

  if (!(await verifyTurnstile(input.turnstileToken, meta.ip))) {
    throw new ServiceError("VALIDATION", "Verification failed. Please try again.");
  }

  const orgId = getDefaultOrgId();
  // A listing that is not published (or never existed) is dropped from the enquiry, not an error.
  const stockSlug = await publishedSlugOrNull(orgId, input.stockSlug);

  const alert = await getPrisma().$transaction(async (tx) => {
    await tx.enquiry.create({
      data: { org_id: orgId, name: input.name, email: input.email, phone: input.phone ?? null, message: input.message, stockSlug },
    });
    const recipientUserIds = await listNotifiableStaffIds(tx, orgId);
    const params: EmitParams = {
      orgId,
      event: "ENQUIRY_RECEIVED",
      title: "New website enquiry",
      body: `From ${input.name.length > NAME_IN_ALERT ? `${input.name.slice(0, NAME_IN_ALERT - 1)}…` : input.name}. Open the enquiries inbox to read it.`,
      recipientUserIds,
    };
    await emit(tx, params);
    return params;
  });
  notifyRealtime(alert);
  return ENQUIRY_ACCEPTED;
}

// ---------------------------------------------------------------------------------------------
// Staff inbox

export interface EnquiryRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  stockSlug: string | null;
  handled: boolean;
  createdAt: string;
}

export async function listEnquiries(orgId: string, rawQuery: unknown): Promise<{ rows: EnquiryRow[]; total: number; page: number; pageSize: number }> {
  const q = parseInput(enquiryListQuerySchema, rawQuery);
  const prisma = getPrisma();
  const where = { org_id: orgId, ...(q.status === "open" ? { handledAt: null } : q.status === "handled" ? { handledAt: { not: null } } : {}) };
  const [total, rows] = await Promise.all([
    prisma.enquiry.count({ where }),
    prisma.enquiry.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, name: true, email: true, phone: true, message: true, stockSlug: true, handledAt: true, createdAt: true },
    }),
  ]);
  return {
    rows: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, message: r.message, stockSlug: r.stockSlug, handled: r.handledAt !== null, createdAt: r.createdAt.toISOString() })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function setEnquiryHandled(actor: SessionUser, id: string, rawBody: unknown): Promise<{ id: string; handled: boolean }> {
  const { handled } = parseInput(enquiryHandledSchema, rawBody, INVALID);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ServiceError("NOT_FOUND", "Enquiry not found.");
  await getPrisma().$transaction(async (tx) => {
    const enquiry = await tx.enquiry.findFirst({ where: { id, org_id: actor.orgId }, select: { id: true, handledAt: true } });
    if (!enquiry) throw new ServiceError("NOT_FOUND", "Enquiry not found.");
    await tx.enquiry.updateMany({ where: { id: enquiry.id, org_id: actor.orgId }, data: { handledAt: handled ? new Date() : null } });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: handled ? "HANDLE_ENQUIRY" : "REOPEN_ENQUIRY",
      entity: "Enquiry",
      entityId: enquiry.id,
      before: { handled: enquiry.handledAt !== null },
      after: { handled },
    });
  });
  return { id, handled };
}
