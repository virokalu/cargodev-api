// Transactional email through the Resend HTTP API, with the built-in fetch (no SDK).
//
// This is the ONLY place that knows the Resend address or reads RESEND_API_KEY (a test enforces it).
// With RESEND_API_KEY or EMAIL_FROM unset, sendEmail never makes a network call: it logs a masked
// notice and returns { sent: false, reason: "not_configured" }, so development, tests and CI cannot
// send real mail by accident.
//
// Templates live in one place (src/lib/email-templates.ts, added when the first email is needed).
// Message bodies and full addresses are never logged.

import { loadEnv } from "../config/env.js";
import { isRecipientAllowed, parseAllowList } from "./email-allow-list.js";
import { safeError } from "./redact.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type EmailResult = { sent: true } | { sent: false; reason: "not_configured" | "failed" | "not_allowed" };

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

/** a***@example.test: enough to recognise in a log, not enough to identify. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${address[0]}***${address.slice(at)}`;
}

/** For the start-up line: is email off, restricted to an allow-list, or open to everyone? */
export function emailMode(env: { RESEND_API_KEY?: string | undefined; EMAIL_FROM?: string | undefined; EMAIL_ALLOWED_RECIPIENTS: string }): "off" | "allow-list" | "open" {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return "off";
  return parseAllowList(env.EMAIL_ALLOWED_RECIPIENTS).length > 0 ? "allow-list" : "open";
}

/** Warnings for the start-up log (masked: setting names only). */
export function emailWarnings(env: { APP_ENV: string; RESEND_API_KEY?: string | undefined; EMAIL_FROM?: string | undefined; EMAIL_ALLOWED_RECIPIENTS: string }): string[] {
  const warnings: string[] = [];
  const restricted = parseAllowList(env.EMAIL_ALLOWED_RECIPIENTS).length > 0;
  if (env.APP_ENV === "production" && restricted) warnings.push("EMAIL_ALLOWED_RECIPIENTS is set in production: only matching addresses will receive email (remove it to email everyone)");
  if (env.RESEND_API_KEY && !env.EMAIL_FROM) warnings.push("the mail key is set but EMAIL_FROM is not: no email will be sent");
  return warnings;
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const { RESEND_API_KEY, EMAIL_FROM, EMAIL_ALLOWED_RECIPIENTS } = loadEnv();
  // Email safety: with an allow-list, anyone else's message is dropped BEFORE anything else happens. Not an error: the request that
  // queued it succeeds exactly as it would have, so the answer never reveals which addresses are on the list.
  if (!isRecipientAllowed(message.to, parseAllowList(EMAIL_ALLOWED_RECIPIENTS))) {
    console.warn(`email dropped (recipient is not on EMAIL_ALLOWED_RECIPIENTS): to=${maskEmail(message.to)}`);
    return { sent: false, reason: "not_allowed" };
  }
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    console.warn(`email not sent (RESEND_API_KEY or EMAIL_FROM is not set): to=${maskEmail(message.to)}`);
    return { sent: false, reason: "not_configured" };
  }

  try {
    const response = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [message.to], subject: message.subject, text: message.text }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`email send failed: status=${response.status} to=${maskEmail(message.to)}`);
      return { sent: false, reason: "failed" };
    }
    return { sent: true };
  } catch (error) {
    console.error(`email send failed: to=${maskEmail(message.to)}`, safeError(error));
    return { sent: false, reason: "failed" };
  }
}
