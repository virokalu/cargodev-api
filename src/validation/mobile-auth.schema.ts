// Body schemas for the /api/v1/auth/* endpoints.

import { z } from "zod";
import { emailSchema, flattenFieldErrors } from "./shared.js";

export const mobileLoginSchema = z.object({
  email: emailSchema,
  // Not newPasswordSchema — login must accept any password that was ever
  // valid under an older minimum-length policy, not today's rule.
  password: z.string().min(1, "Password is required"),
});

export const mobileRefreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

export const mobileLogoutSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

export { flattenFieldErrors };
