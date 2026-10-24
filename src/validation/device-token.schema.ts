// Zod schemas for /api/v1/device-tokens — shape-level validation only.
// Whether expoPushToken is actually a *valid* Expo push token (not just a
// non-empty string) is a business rule checked against expo-server-sdk's
// own Expo.isExpoPushToken() in device-token.service.ts, not here — same
// shape-vs-business split every other schema in this directory follows.

import { z } from "zod";
import { flattenFieldErrors } from "./shared.js";

export { flattenFieldErrors };

export const registerDeviceTokenSchema = z.object({
  expoPushToken: z.string().trim().min(1, "expoPushToken is required"),
  platform: z.enum(["ios", "android"]),
});

export const unregisterDeviceTokenSchema = z.object({
  expoPushToken: z.string().trim().min(1, "expoPushToken is required"),
});

export type RegisterDeviceTokenInput = z.infer<typeof registerDeviceTokenSchema>;
