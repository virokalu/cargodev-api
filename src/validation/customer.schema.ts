// Zod schemas for customer (userType = CUSTOMER) records. Per Tech Doc §5,
// name is the only required field — a sale can be recorded the moment it's
// agreed, with the rest filled in later.

import { z } from "zod";

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const optionalText = (maxLength: number) =>
  z
    .string()
    .nullable()
    .optional()
    .transform(emptyToNull)
    .refine((v) => v === null || v.length <= maxLength, {
      message: `Must be ${maxLength} characters or fewer`,
    });

const optionalEmail = z
  .string()
  .nullable()
  .optional()
  .transform(emptyToNull)
  .transform((v) => (v ? v.toLowerCase() : v))
  .refine((v) => v === null || z.string().email().safeParse(v).success, {
    message: "Enter a valid email address",
  });

export const customerCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(150, "Must be 150 characters or fewer"),
  email: optionalEmail,
  phone: optionalText(30),
  country: optionalText(100),
  address: optionalText(300),
});

export const customerUpdateSchema = customerCreateSchema;

export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;

// ── GET /api/v1/customers query params ─────────────────────────────
export const customerListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
});

export const customerSearchQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
});
