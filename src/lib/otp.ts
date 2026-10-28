// One-time codes: 6 digits from crypto.randomInt, stored only as an HMAC-SHA256 keyed by the server secret OTP_PEPPER
// (the code space is tiny, so an unkeyed hash would be reversible in an instant). Compared in constant time.

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { loadEnv } from "../config/env.js";

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** The server-side pepper. A separate secret from both JWT secrets, so leaking one never exposes the others. */
function key(): string {
  const pepper = loadEnv().OTP_PEPPER;
  if (!pepper) throw new Error("The customer API is not configured.");
  return pepper;
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
