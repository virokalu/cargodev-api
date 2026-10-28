// Sends email AFTER the HTTP response has been sent (see lib/post-response.ts), so a request takes the same time and
// gives the same answer whether or not an email is sent (which would otherwise reveal whether an address has an
// account). sendEmail never throws and logs only masked data, so a failed or slow send changes nothing.

import { sendEmail, type EmailMessage } from "./email.js";
import { afterResponse, drainAfterResponse } from "./post-response.js";

export function queueEmail(message: EmailMessage): void {
  afterResponse(async () => {
    await sendEmail(message);
  });
}

/** Waits for queued sends to finish. Tests and graceful shutdown. */
export async function drainEmailQueue(): Promise<void> {
  await drainAfterResponse();
}
