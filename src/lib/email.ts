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
import { safeError } from "./redact.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type EmailResult = { sent: true } | { sent: false; reason: "not_configured" | "failed" };

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

/** a***@example.test: enough to recognise in a log, not enough to identify. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${address[0]}***${address.slice(at)}`;
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const { RESEND_API_KEY, EMAIL_FROM } = loadEnv();
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
