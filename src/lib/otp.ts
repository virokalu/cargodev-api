// One-time codes: 6 digits from crypto.randomInt, stored only as an HMAC (the code space is tiny, so a
// plain hash would be reversible in an instant). Compared in constant time.

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { loadEnv } from "../config/env.js";

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function key(): string {
  const secret = loadEnv().CUSTOMER_JWT_SECRET;
  if (!secret) throw new Error("The customer API is not configured.");
  return secret;
}

/** Binds the code to the org, user and purpose, so a code for one thing cannot be used for another. */
export function hashOtp(orgId: string, userId: string, purpose: string, code: string): string {
  return createHmac("sha256", key()).update(`otp:${orgId}:${userId}:${purpose}:${code}`).digest("hex");
}

export function otpMatches(expectedHash: string, orgId: string, userId: string, purpose: string, code: string): boolean {
  const actual = Buffer.from(hashOtp(orgId, userId, purpose, code), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
