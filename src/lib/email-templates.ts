// Every customer-facing email, in one place. Plain text only.

import type { EmailMessage } from "./email.js";

export function verificationEmail(to: string, code: string): EmailMessage {
  return {
    to,
    subject: "Your verification code",
    text: `Your verification code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
  };
}

export function passwordResetEmail(to: string, code: string): EmailMessage {
  return {
    to,
    subject: "Your password reset code",
    text: `Your password reset code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email: your password has not changed.`,
  };
}

export function alreadyRegisteredEmail(to: string): EmailMessage {
  return {
    to,
    subject: "You already have an account",
    text: "Someone tried to register with this email address, but an account already exists. If it was you, sign in, or use \"Forgot password\" in the app. If not, ignore this email.",
  };
}

/** An alert the customer asked to receive by email. Title and body only: nothing else about the account. */
export function notificationEmail(to: string, title: string, body: string): EmailMessage {
  return { to, subject: title, text: `${body}

You can change which emails you get in the app, under notification settings.` };
}
