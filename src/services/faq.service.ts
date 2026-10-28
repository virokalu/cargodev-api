// Help articles shown to customers (GET /help/faqs). Staff manage them here, including drafts.

import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import type { SessionUser } from "../lib/session-user.js";
import { faqCreateSchema, faqUpdateSchema } from "../validation/customer-admin.schema.js";
import * as activityLog from "./activity-log.service.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOT_FOUND = () => new ServiceError("NOT_FOUND", "FAQ not found.");

export interface StaffFaq {
  id: string;
  question: string;
  answer: string;
  sortOrder: number;
  published: boolean;
}

const select = { id: true, question: true, answer: true, sortOrder: true, published: true } as const;
const toDto = (r: StaffFaq): StaffFaq => ({ id: r.id, question: r.question, answer: r.answer, sortOrder: r.sortOrder, published: r.published });

export async function listStaffFaqs(orgId: string): Promise<StaffFaq[]> {
  const rows = await getPrisma().faq.findMany({ where: { org_id: orgId }, select, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }], take: 500 });
  return rows.map(toDto);
}

export async function createFaq(actor: SessionUser, rawBody: unknown): Promise<StaffFaq> {
  const input = parseInput(faqCreateSchema, rawBody, "Please fix the highlighted fields.");
  return getPrisma().$transaction(async (tx) => {
    const created = await tx.faq.create({ data: { org_id: actor.orgId, ...input }, select });
    await activityLog.record(tx, { orgId: actor.orgId, actorId: actor.id, action: "CREATE_FAQ", entity: "Faq", entityId: created.id, after: toDto(created) });
    return toDto(created);
  });
}

export async function updateFaq(actor: SessionUser, id: string, rawBody: unknown): Promise<StaffFaq> {
  const changes = parseInput(faqUpdateSchema, rawBody, "Please fix the highlighted fields.");
  if (!ID.test(id)) throw NOT_FOUND();
  const data = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));

  return getPrisma().$transaction(async (tx) => {
    const before = await tx.faq.findFirst({ where: { id, org_id: actor.orgId }, select });
    if (!before) throw NOT_FOUND();
    // The write carries org_id itself (not only the read above): another org's id changes nothing.
    const written = await tx.faq.updateMany({ where: { id, org_id: actor.orgId }, data });
    if (written.count !== 1) throw NOT_FOUND();
    const updated = await tx.faq.findFirst({ where: { id, org_id: actor.orgId }, select });
    if (!updated) throw NOT_FOUND();
    await activityLog.record(tx, { orgId: actor.orgId, actorId: actor.id, action: "UPDATE_FAQ", entity: "Faq", entityId: id, before: toDto(before), after: toDto(updated) });
    return toDto(updated);
  });
}

export async function deleteFaq(actor: SessionUser, id: string): Promise<void> {
  if (!ID.test(id)) throw NOT_FOUND();
  await getPrisma().$transaction(async (tx) => {
    const before = await tx.faq.findFirst({ where: { id, org_id: actor.orgId }, select });
    if (!before) throw NOT_FOUND();
    const removed = await tx.faq.deleteMany({ where: { id, org_id: actor.orgId } });
    if (removed.count !== 1) throw NOT_FOUND();
    await activityLog.record(tx, { orgId: actor.orgId, actorId: actor.id, action: "DELETE_FAQ", entity: "Faq", entityId: id, before: toDto(before) });
  });
}
