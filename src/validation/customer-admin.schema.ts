// Bodies and queries for the staff tools for customers. Strict: an unknown field is a 400.

import { z } from "zod";
import { rejectionReasonSchema } from "./chat.schema.js";
import { DOCUMENT_TYPES } from "./file.schema.js";

const id = z.string("an id is required").regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");

export const loginAccessBodySchema = z.object({ loginEnabled: z.boolean("loginEnabled must be true or false") }).strict();
export const agentBodySchema = z.object({ agentId: id.nullable() }).strict();
export const visibilityBodySchema = z.object({ customerVisible: z.boolean("customerVisible must be true or false") }).strict();

const shortText = z
  .string()
  .trim()
  .max(100, "Must be 100 characters or fewer")
  .nullable()
  .transform((v) => (v ? v : null));

export const customerInfoBodySchema = z
  .object({
    portOfLoading: shortText.optional(),
    portOfDischarge: shortText.optional(),
    voyageNo: shortText.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Send at least one field to change" });

export const documentReleaseBodySchema = z
  .object({ documentType: z.enum(DOCUMENT_TYPES).optional(), visibleToCustomer: z.boolean().optional() })
  .strict()
  .refine((v) => v.documentType !== undefined || v.visibleToCustomer !== undefined, { message: "Send at least one field to change" });

export const photoReleaseBodySchema = z.object({ visibleToCustomer: z.boolean("visibleToCustomer must be true or false") }).strict();
export const photosBulkBodySchema = z
  .object({ visibleToCustomer: z.boolean("visibleToCustomer must be true or false"), photoIds: z.array(id).min(1).max(200) })
  .strict();

export const linkRequestListQuerySchema = z
  .object({
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const linkApproveBodySchema = z.object({ vehicleId: id.optional() }).strict();
export const emptyBodySchema = z.object({}).strict();
/** Rejecting a link request: an optional reason, which reaches the customer as a chat message from staff. */
export const rejectBodySchema = z.object({ reason: rejectionReasonSchema.optional() }).strict();

const faqText = (max: number, label: string) => z.string(`${label} is required`).trim().min(1, `${label} is required`).max(max, `Must be ${max} characters or fewer`);
export const faqCreateSchema = z
  .object({
    question: faqText(500, "Question"),
    answer: faqText(5000, "Answer"),
    sortOrder: z.number().int().min(0).max(10000).default(0),
    published: z.boolean().default(true),
  })
  .strict();
export const faqUpdateSchema = z
  .object({
    question: faqText(500, "Question").optional(),
    answer: faqText(5000, "Answer").optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    published: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Send at least one field to change" });
