// Shared staff credential verification — extracted from lib/auth.ts's
// NextAuth authorize() so the web login and the new mobile login
// (app/api/v1/auth/login/route.ts) share one implementation instead of two
// copies of the email-normalize/bcrypt-compare/loginEnabled+userType filter
// logic (CLAUDE.md rule 2: business logic lives in lib/services/, not
// inlined in the NextAuth config).
//
// Also owns the login throttle (failedLoginAttempts/lockoutUntil on User) —
// this benefits both callers for free since neither duplicates the check.

import bcrypt from "bcryptjs";
import type { StaffRole } from "@prisma/client";
import { getPrisma } from "../lib/prisma.js";
import { getDefaultOrgId } from "../config/default-org.js";
import { ServiceError } from "../lib/errors.js";
import { isShadowLocked, recordShadowFailure } from "../lib/shadow-lockout.js";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const LOCKED_MESSAGE =
  "This account is temporarily locked after repeated failed sign-in attempts. Try again in a few minutes.";

// Compared against when no account matches, so a miss costs the same bcrypt
// work as a real wrong password and timing does not reveal which emails exist.
// Same cost factor as real hashes (user.service PASSWORD_SALT_ROUNDS).
let dummyHash: string | undefined;
async function burnBcryptTime(password: string): Promise<void> {
  dummyHash ??= await bcrypt.hash("not-a-real-password", 10);
  await bcrypt.compare(password, dummyHash);
}

export interface VerifiedStaffUser {
  id: string;
  name: string;
  email: string | null;
  role: StaffRole;
  orgId: string;
}

/**
 * Verifies an email/password pair against a STAFF, login-enabled user.
 * Returns null for "invalid credentials" (matches NextAuth's authorize()
 * null-means-reject contract). Throws ServiceError("FORBIDDEN", ...) only
 * for an active lockout — a distinguishable case the mobile login route can
 * surface to the client; the web login form collapses it back to a generic
 * failure, same as it always has.
 */
export async function verifyStaffCredentials(
  rawEmail: string,
  password: string
): Promise<VerifiedStaffUser | null> {
  // Emails are always stored lowercase (zod's emailSchema normalizes on
  // every write) — normalize the login input the same way so
  // "User@Example.com" matches the "user@example.com" row in the database.
  const email = rawEmail.trim().toLowerCase();

  const user = await getPrisma().user.findFirst({
    where: {
      org_id: getDefaultOrgId(),
      email,
      userType: "STAFF",
      loginEnabled: true,
    },
    select: {
      id: true,
      name: true,
      email: true,
      password: true,
      role: true,
      org_id: true,
      failedLoginAttempts: true,
      lockoutUntil: true,
    },
  });

  // `role` is nullable in the schema (customers have no role) but we already
  // filter userType=STAFF above, so null here means data integrity issue — reject.
  if (!user || !user.password || !user.role) {
    // No eligible account. Behave exactly like a real one would: the same lock
    // after repeated failures, and the same bcrypt cost on a miss, so neither
    // the response nor the timing reveals whether this email exists.
    if (isShadowLocked(email)) throw new ServiceError("FORBIDDEN", LOCKED_MESSAGE);
    await burnBcryptTime(password);
    recordShadowFailure(email);
    return null;
  }

  if (user.lockoutUntil && user.lockoutUntil > new Date()) {
    throw new ServiceError("FORBIDDEN", LOCKED_MESSAGE);
  }

  const passwordValid = await bcrypt.compare(password, user.password);
  if (!passwordValid) {
    await recordFailedLoginAttempt(user.id, user.failedLoginAttempts);
    return null;
  }

  await resetFailedLoginAttempts(user.id);

  // Record the login timestamp (non-blocking — don't await, don't let a
  // failed timestamp update block login).
  getPrisma().user
    .update({ where: { id: user.id }, data: { lastActiveAt: new Date() } })
    .catch(() => {
      // Intentionally ignore.
    });

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    orgId: user.org_id,
  };
}

async function recordFailedLoginAttempt(userId: string, currentAttempts: number): Promise<void> {
  const attempts = currentAttempts + 1;
  const data: { failedLoginAttempts: number; lockoutUntil?: Date } = {
    failedLoginAttempts: attempts,
  };
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    data.lockoutUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
  }
  // Bookkeeping failure must not surface as a different login error than
  // "invalid credentials" — swallow it, same treatment as lastActiveAt above.
  await getPrisma().user.update({ where: { id: userId }, data }).catch(() => {});
}

async function resetFailedLoginAttempts(userId: string): Promise<void> {
  await getPrisma().user
    .update({ where: { id: userId }, data: { failedLoginAttempts: 0, lockoutUntil: null } })
    .catch(() => {});
}
