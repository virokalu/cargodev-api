// Every rate limit for the customer API, in one place (and tested: tests/customer-rate-limits.test.ts).
//
// `ip` limits go to @fastify/rate-limit per route. `identifier` limits are keyed on the normalised email
// (or user id) and apply whether or not that email exists, so a limit never reveals an account.
// Windows are in milliseconds.

const MINUTE = 60_000;

export interface Limit {
  max: number;
  windowMs: number;
}

export interface RouteLimits {
  ip: Limit;
  identifier?: Limit;
}

export const CUSTOMER_RATE_LIMITS = {
  register: { ip: { max: 5, windowMs: MINUTE }, identifier: { max: 3, windowMs: 60 * MINUTE } },
  verifyEmail: { ip: { max: 10, windowMs: MINUTE }, identifier: { max: 10, windowMs: 10 * MINUTE } },
  resendVerification: { ip: { max: 5, windowMs: MINUTE }, identifier: { max: 3, windowMs: 10 * MINUTE } },
  login: { ip: { max: 10, windowMs: MINUTE }, identifier: { max: 20, windowMs: 15 * MINUTE } },
  refresh: { ip: { max: 30, windowMs: MINUTE } },
  logout: { ip: { max: 30, windowMs: MINUTE } },
  forgotPassword: { ip: { max: 5, windowMs: MINUTE }, identifier: { max: 3, windowMs: 60 * MINUTE } },
  resetPassword: { ip: { max: 10, windowMs: MINUTE }, identifier: { max: 10, windowMs: 10 * MINUTE } },
  deleteAccount: { ip: { max: 5, windowMs: MINUTE }, identifier: { max: 5, windowMs: 60 * MINUTE } },
  me: { ip: { max: 60, windowMs: MINUTE } },
  // Reading the customer's own data (home, vehicles, timeline, documents, FAQs).
  read: { ip: { max: 120, windowMs: MINUTE }, identifier: { max: 240, windowMs: MINUTE } },
  // Asking to be linked to a vehicle by serial number.
  linkRequest: { ip: { max: 10, windowMs: MINUTE }, identifier: { max: 5, windowMs: 60 * MINUTE } },
  // The app version check runs before sign-in.
  appConfig: { ip: { max: 60, windowMs: MINUTE } },
  // Photos and documents streamed by the API: a list screen loads many thumbnails at once.
  fileDownload: { ip: { max: 300, windowMs: MINUTE }, identifier: { max: 120, windowMs: MINUTE } },
} as const satisfies Record<string, RouteLimits>;

export type CustomerLimitName = keyof typeof CUSTOMER_RATE_LIMITS;
