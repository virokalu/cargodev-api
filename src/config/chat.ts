// Chat settings in one place. Plain text only, no attachments in this phase.

/** The longest message, in characters, after trimming. */
export const MAX_MESSAGE_LENGTH = 2000;

/** The longest reason staff can attach to a rejected link request. */
export const MAX_REJECTION_REASON_LENGTH = 500;

/** A new alert for a burst of messages is sent at most this often per conversation and recipient. */
export const CHAT_ALERT_COALESCE_MS = 5 * 60_000;

/** The most conversations one customer can have (a guard against a client creating them in a loop). */
export const MAX_CONVERSATIONS_PER_CUSTOMER = 50;

/** Shown in the app as tap-to-ask starters. Static: nothing in here comes from the database. */
export const SUGGESTED_QUESTIONS: readonly string[] = [
  "Where is my vehicle now?",
  "When will my vehicle ship?",
  "When will my vehicle arrive?",
  "Can I get a copy of my export certificate?",
  "Can I get a copy of my bill of lading?",
  "How do I pay for my vehicle?",
];
