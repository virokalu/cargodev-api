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

export const profileDetailsSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
});

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
