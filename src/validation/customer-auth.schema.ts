// Body schemas for /api/customer/v1. All strict: unknown keys are rejected, so a client can never slip in
// an orgId, a role, loginEnabled or any other field the server owns.

import { z } from "zod";
import { emailSchema, nameSchema, newPasswordSchema, phoneSchema } from "./shared.js";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const code = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");
const refreshToken = z.string().min(1, "Refresh token is required").max(200);

export const customerRegisterSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    phone: phoneSchema,
    companyName: optionalText(150),
    country: optionalText(100),
  })
  .strict();

// The password is chosen here, with the code, never at register: whoever can read the mailbox is the only
// one who can set it, so nobody can pre-register someone else's address with a password they know.
export const customerVerifyEmailSchema = z.object({ email: emailSchema, code, password: newPasswordSchema }).strict();

export const customerEmailOnlySchema = z.object({ email: emailSchema }).strict();

export const customerLoginSchema = z
  .object({
    email: emailSchema,
    // Not newPasswordSchema: login accepts whatever was valid when it was set.
    password: z.string().min(1, "Password is required").max(1000),
  })
  .strict();

export const customerRefreshSchema = z.object({ refreshToken }).strict();
export const customerLogoutSchema = z.object({ refreshToken }).strict();

export const customerResetPasswordSchema = z.object({ email: emailSchema, code, newPassword: newPasswordSchema }).strict();

export const customerDeleteAccountSchema = z.object({ password: z.string().min(1, "Password is required").max(1000) }).strict();

export const customerUpdateMeSchema = z
  .object({
    name: nameSchema.optional(),
    phone: phoneSchema.optional(),
    companyName: optionalText(150).optional(),
    country: optionalText(100).optional(),
    destinationPort: optionalText(100).optional(),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, "Use a language code such as en")
      .optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Send at least one field to change" });
