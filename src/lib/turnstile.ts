// Cloudflare Turnstile verification for the public enquiry form. With TURNSTILE_SECRET unset the check is skipped.
// With it set, a missing, wrong or unverifiable token fails closed. The token and the secret are never logged.

import { loadEnv } from "../config/env.js";
import { safeError } from "./redact.js";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5_000;

export function turnstileEnabled(): boolean {
  return loadEnv().TURNSTILE_SECRET !== undefined;
}

export async function verifyTurnstile(token: string | undefined, ip: string | undefined): Promise<boolean> {
  const secret = loadEnv().TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  try {
    const response = await fetch(VERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
  } catch (error) {
    console.error("turnstile check failed", safeError(error));
    return false;
  }
}
