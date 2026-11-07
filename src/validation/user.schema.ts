// Zod schemas for staff (userType = STAFF) accounts — shape-level validation
// only. Whether the actor is allowed to change a role, and email-uniqueness,
// depend on the database and the caller's own role — those checks live in
// user.service.ts, which has the Prisma client and the session user.

import { z } from "zod";
import {
  nameSchema as name,
  emailSchema as email,
  phoneSchema as phone,
  newPasswordSchema as newPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  fitsBcryptLimit,
} from "./shared.js";

const role = z.enum(["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"]);

// On update, a blank password means "leave it unchanged" — only validate
// length when the admin actually typed something.
const optionalPassword = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined))
  .refine((v) => v === undefined || v.length >= MIN_PASSWORD_LENGTH, {
    message: `Must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  .refine((v) => v === undefined || fitsBcryptLimit(v), {
    message: `Must be ${MAX_PASSWORD_BYTES} bytes or fewer`,
  });

export const staffCreateSchema = z.object({
  name,
  email,
  phone,
  role,
  password: newPassword,
});

// PATCH semantics: only the fields sent change (absent = unchanged; phone: explicit null or blank clears it); a blank or null password
// leaves the password alone; unknown fields are a 400; an empty body is a 400.
const patchPhone = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v && v.trim() !== "" ? v.trim() : null))
  .refine((v) => v === undefined || v === null || v.length <= 30, { message: "Must be 30 characters or fewer" });

export const staffUpdateSchema = z
  .object({
    name: name.optional(),
    email: email.optional(),
    phone: patchPhone,
    role: role.optional(),
    active: z.boolean().optional(),
    password: optionalPassword,
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Send at least one field to change" });

export type StaffCreateInput = z.infer<typeof staffCreateSchema>;
export type StaffUpdateInput = z.infer<typeof staffUpdateSchema>;

// ── GET /api/v1/staff query params ─────────────────────────────────
export const staffListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
});
