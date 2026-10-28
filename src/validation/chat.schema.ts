// Bodies and queries for chat. Strict: an unknown field is a 400, so a client can never name a sender, a customer or an org.
// A message is plain text: trimmed, 1 to MAX_MESSAGE_LENGTH characters, no control characters except line breaks and tabs.
// It is stored exactly as typed (never stripped or escaped) and only ever returned inside JSON.

import { z } from "zod";
import { MAX_MESSAGE_LENGTH, MAX_REJECTION_REASON_LENGTH } from "../config/chat.js";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function plainText(max: number, what = "Message") {
  return z
    .string(`${what} is required`)
    .transform((value) => value.replace(/\r\n?/g, "\n").trim())
    .pipe(
      z
        .string()
        .min(1, `${what} cannot be empty`)
        .max(max, `${what} must be ${max} characters or fewer`)
        .refine((value) => !CONTROL_CHARACTERS.test(value), `${what} contains characters that are not allowed`)
    );
}

const id = z.string("an id is required").regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");

export const sendMessageBodySchema = z.object({ body: plainText(MAX_MESSAGE_LENGTH) }).strict();

export const startConversationBodySchema = z.object({ vehicleId: id.optional(), body: plainText(MAX_MESSAGE_LENGTH) }).strict();

export const rejectionReasonSchema = plainText(MAX_REJECTION_REASON_LENGTH, "Reason");

const page = z.coerce.number().int().min(1).max(100000).default(1);
const pageSize = z.coerce.number().int().min(1).max(50).default(20);

export const messageListQuerySchema = z.object({ page, pageSize }).strict();

export const conversationListQuerySchema = z.object({ page, pageSize }).strict();

export const staffInboxQuerySchema = z
  .object({ page, pageSize, status: z.enum(["open", "handled", "all"]).default("open") })
  .strict();

export const handledBodySchema = z.object({ handled: z.boolean("handled must be true or false") }).strict();
