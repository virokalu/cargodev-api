// How many one-time codes may be REQUESTED per hour (register, resend verification, forgot password together).
// Counted whether or not the address has an account, and over the cap the caller gets the same answer as ever but no
// code is issued and no email is sent, so the cap itself reveals nothing. Tested: tests/otp-hardening.test.ts.

const HOUR = 60 * 60_000;

export const OTP_REQUEST_LIMITS = {
  /** Per email address: protects one mailbox from being flooded with codes. */
  perAddress: { max: 5, windowMs: HOUR },
  /** Per client IP: protects against one machine working through many addresses. */
  perIp: { max: 20, windowMs: HOUR },
} as const;
