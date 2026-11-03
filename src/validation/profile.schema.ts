// Zod schemas for the "edit your own profile" screen (Settings → Profile,
// US-03) — shape-level validation only. Whether `currentPassword` actually
// matches depends on the database, so that check lives in
// user.service.ts's changeOwnPassword, which has the Prisma client.

import { z } from "zod";
import {
  nameSchema,
  emailSchema,
  phoneSchema,
  newPasswordSchema,
} from "./shared.js";

// PATCH semantics: only the fields sent change (absent = unchanged; phone: explicit null or blank clears it); unknown fields are a 400.
export const profileDetailsSchema = z
  .object({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    phone: z
      .string()
      .nullable()
      .optional()
      .transform((v) => (v === undefined ? undefined : v && v.trim() !== "" ? v.trim() : null))
      .refine((v) => v === undefined || v === null || v.length <= 30, { message: "Must be 30 characters or fewer" }),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Send at least one field to change" });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: newPasswordSchema,
    confirmPassword: z.string().min(1, "Confirm your new password"),
  })
  .superRefine((data, ctx) => {
    if (data.newPassword !== data.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmPassword"],
        message: "Passwords do not match",
      });
    }
  });

export type ProfileDetailsInput = z.infer<typeof profileDetailsSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
