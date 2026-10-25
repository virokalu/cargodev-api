// Sends email AFTER the response, so a request takes the same time whether or not an email is sent
// (which would otherwise reveal whether an address has an account). sendEmail never throws.

import { sendEmail, type EmailMessage } from "./email.js";

const inFlight = new Set<Promise<unknown>>();

export function queueEmail(message: EmailMessage): void {
  const task = sendEmail(message).finally(() => inFlight.delete(task));
  inFlight.add(task);
}

/** Waits for queued sends to finish. Tests and graceful shutdown. */
export async function drainEmailQueue(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}
