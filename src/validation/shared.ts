// Small helpers shared by every zod schema in lib/validation/*.

import { z } from "zod";

/** Flattens zod's nested error tree into one message per field, for form display. */
export function flattenFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}

// Field primitives reused across staff, customer, and profile schemas — one
// definition each so a rule change (e.g. max length) never has to be copied
// to every schema that touches a name/phone/password.

export const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(150, "Must be 150 characters or fewer");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Email is required")
  .email("Enter a valid email address")
  .max(150, "Must be 150 characters or fewer");

export const phoneSchema = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : null))
  .refine((v) => v === null || v.length <= 30, {
    message: "Must be 30 characters or fewer",
  });

export const MIN_PASSWORD_LENGTH = 12;

// bcrypt only uses the first 72 BYTES of a password and silently ignores the
// rest, so a longer one would give a false sense of strength. Reject it instead.
export const MAX_PASSWORD_BYTES = 72;

export function fitsBcryptLimit(value: string): boolean {
  return new TextEncoder().encode(value).length <= MAX_PASSWORD_BYTES;
}

// Applies to NEW passwords only. Login (mobile-auth.schema) stays lenient so
// passwords set under an older, weaker policy keep working until changed.
export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .refine(fitsBcryptLimit, { message: `Must be ${MAX_PASSWORD_BYTES} bytes or fewer` });
