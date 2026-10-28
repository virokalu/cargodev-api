// Customer accounts: register, verify email, login, refresh, logout, forgot/reset password, delete account.
// A separate zone from staff (own token audience, secret and session table), same security patterns:
//   - responses never reveal whether an email has an account (same shape, same timing),
//   - opaque refresh tokens stored only as sha256, rotated atomically, reuse revokes every session,
//   - lockout after 5 failures (real accounts in the database, everything else in memory),
//   - the org always comes from the server (ORG_ID) before a token exists, and from the token afterwards.

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { getDefaultOrgId } from "../config/default-org.js";
import { loadEnv } from "../config/env.js";
import { CUSTOMER_ACCESS_TOKEN_TTL_SECONDS, signCustomerToken } from "../lib/customer-jwt.js";
import { canCustomerLogin, selfSignupAllowed, verificationEnablesLogin } from "../lib/customer-access.js";
import { alreadyRegisteredEmail, passwordResetEmail, verificationEmail } from "../lib/email-templates.js";
import { queueEmail } from "../lib/email-queue.js";
import { ServiceError } from "../lib/errors.js";
import { withResponseFloor } from "../lib/min-duration.js";
import { otpRequestAllowed } from "../lib/otp-request-limit.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import { isShadowLocked, recordShadowFailure } from "../lib/shadow-lockout.js";
import {
  customerDeleteAccountSchema,
  customerEmailOnlySchema,
  customerLoginSchema,
  customerLogoutSchema,
  customerRefreshSchema,
  customerRegisterSchema,
  customerResetPasswordSchema,
  customerVerifyEmailSchema,
} from "../validation/customer-auth.schema.js";
import * as activityLog from "./activity-log.service.js";
import { burnOtpWork, consumeOtp, issueOtp } from "./customer-otp.service.js";

const PASSWORD_SALT_ROUNDS = 10;
const REFRESH_TOKEN_TTL_DAYS = 30;
// Same retry-versus-theft rule as staff sessions.
const REUSE_GRACE_MS = 10_000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const INVALID_INPUT = "Please fix the highlighted fields.";
const INVALID_CODE = "That code is invalid or has expired.";
const INVALID_LOGIN = "Invalid email or password.";
const LOCKED = "This account is temporarily locked after repeated failed sign-in attempts. Try again in a few minutes.";
const SESSION_EXPIRED = "Session expired. Please sign in again.";
const INCORRECT_PASSWORD = "Incorrect password.";

/** The one answer for register, resend and forgot, whatever the address. */
export const GENERIC_ACCEPTED = { accepted: true } as const;

class SessionAlreadyUsed extends Error {}

export interface RequestMeta {
  userAgent?: string;
  /** The client IP as the server sees it (never taken from a body). Used by the hourly code-request cap. */
  ip?: string;
}

export interface CustomerSessionResult {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; name: string; email: string | null };
}

const opaqueToken = () => randomBytes(32).toString("base64url");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

let dummyHash: string | undefined;
/** The bcrypt work of a real password check, for requests that have no real account behind them. */
async function burnBcrypt(password: string): Promise<void> {
  dummyHash ??= await bcrypt.hash("not-a-real-password", PASSWORD_SALT_ROUNDS);
  await bcrypt.compare(password, dummyHash);
}

const shadowKey = (email: string) => `customer:${email}`;

const accountSelect = {
  id: true,
  org_id: true,
  name: true,
  email: true,
  userType: true,
  password: true,
  loginEnabled: true,
  emailVerifiedAt: true,
  deletedAt: true,
  failedLoginAttempts: true,
  lockoutUntil: true,
} satisfies Prisma.UserSelect;

async function findByEmail(orgId: string, email: string) {
  return getPrisma().user.findFirst({ where: { org_id: orgId, email }, select: accountSelect });
}

// ---------------------------------------------------------------------------------------------
// Register

/** Creates the unverified, passwordless customer with its first code, in one transaction. Returns the plain code. */
async function createPendingCustomer(orgId: string, input: ReturnType<typeof customerRegisterSchema.parse>): Promise<string> {
  return getPrisma().$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        org_id: orgId,
        userType: "CUSTOMER",
        name: input.name,
        email: input.email,
        phone: input.phone,
        companyName: input.companyName,
        country: input.country,
      },
      select: { id: true },
    });
    const issued = await issueOtp(tx, orgId, created.id, "VERIFY_EMAIL");
    await activityLog.record(tx, { orgId, actorId: created.id, action: "CUSTOMER_REGISTER", entity: "Customer", entityId: created.id });
    return issued;
  });
}

export async function registerCustomer(rawBody: unknown, meta: RequestMeta = {}): Promise<typeof GENERIC_ACCEPTED> {
  return withResponseFloor(async () => {
    const input = parseInput(customerRegisterSchema, rawBody, INVALID_INPUT);
    if (!selfSignupAllowed(loadEnv().CUSTOMER_SELF_SIGNUP)) return GENERIC_ACCEPTED;
    if (!otpRequestAllowed(input.email, meta.ip)) return GENERIC_ACCEPTED;

    const orgId = getDefaultOrgId();
    const existing = await findByEmail(orgId, input.email);

    if (!existing) {
      let code: string;
      try {
        code = await createPendingCustomer(orgId, input);
      } catch (error) {
        // Two parallel registrations of the same new address: the unique (org, email) index let one win.
        if ((error as { code?: string }).code === "P2002") return GENERIC_ACCEPTED;
        throw error;
      }
      queueEmail(verificationEmail(input.email, code));
      return GENERIC_ACCEPTED;
    }
    const pending = existing.userType === "CUSTOMER" && existing.deletedAt === null && existing.emailVerifiedAt === null && existing.password === null;
    if (pending) {
      // Someone registered this address and has not verified yet: send a fresh code, change nothing else.
      const code = await getPrisma().$transaction((tx) => issueOtp(tx, orgId, existing.id, "VERIFY_EMAIL"));
      queueEmail(verificationEmail(input.email, code));
    } else if (existing.userType === "CUSTOMER" && existing.deletedAt === null) {
      // A real account exists. Tell the mailbox owner, not the caller.
      queueEmail(alreadyRegisteredEmail(input.email));
    }
    // A staff address, or an anonymised row: nothing is sent and nothing changes.
    return GENERIC_ACCEPTED;
  });
}

export async function resendVerification(rawBody: unknown, meta: RequestMeta = {}): Promise<typeof GENERIC_ACCEPTED> {
  return withResponseFloor(async () => {
    const { email } = parseInput(customerEmailOnlySchema, rawBody, INVALID_INPUT);
    if (!otpRequestAllowed(email, meta.ip)) return GENERIC_ACCEPTED;
    const orgId = getDefaultOrgId();
    const user = await findByEmail(orgId, email);
    if (user && user.userType === "CUSTOMER" && user.deletedAt === null && user.emailVerifiedAt === null && user.password === null) {
      const code = await getPrisma().$transaction((tx) => issueOtp(tx, orgId, user.id, "VERIFY_EMAIL"));
      queueEmail(verificationEmail(email, code));
    }
    return GENERIC_ACCEPTED;
  });
}

// ---------------------------------------------------------------------------------------------
// Verify email (and choose the password)

export async function verifyEmail(rawBody: unknown): Promise<{ verified: true }> {
  const input = parseInput(customerVerifyEmailSchema, rawBody, INVALID_INPUT);
  // The same bcrypt work whether or not the address, the code or the account is real.
  const passwordHash = await bcrypt.hash(input.password, PASSWORD_SALT_ROUNDS);

  const orgId = getDefaultOrgId();
  const user = await findByEmail(orgId, input.email);
  const eligible = user && user.userType === "CUSTOMER" && user.deletedAt === null && user.emailVerifiedAt === null && user.password === null;

  if (!eligible) {
    burnOtpWork(input.code);
    throw new ServiceError("VALIDATION", INVALID_CODE);
  }
  if (!(await consumeOtp(orgId, user.id, "VERIFY_EMAIL", input.code))) {
    throw new ServiceError("VALIDATION", INVALID_CODE);
  }

  await getPrisma().$transaction(async (tx) => {
    // Conditional on still being unverified: two parallel verifications cannot both set a password.
    const updated = await tx.user.updateMany({
      where: { id: user.id, org_id: orgId, userType: "CUSTOMER", emailVerifiedAt: null, deletedAt: null },
      data: {
        password: passwordHash,
        emailVerifiedAt: new Date(),
        ...(verificationEnablesLogin(loadEnv().CUSTOMER_SELF_SIGNUP) ? { loginEnabled: true } : {}),
      },
    });
    if (updated.count === 0) throw new ServiceError("VALIDATION", INVALID_CODE);
    await activityLog.record(tx, { orgId, actorId: user.id, action: "CUSTOMER_VERIFY_EMAIL", entity: "Customer", entityId: user.id });
  });
  return { verified: true };
}

// ---------------------------------------------------------------------------------------------
// Login, refresh, logout

async function issueSession(
  user: { id: string; org_id: string; name: string; email: string | null },
  meta: RequestMeta
): Promise<CustomerSessionResult> {
  const accessToken = await signCustomerToken({ sub: user.id, orgId: user.org_id });
  const refreshToken = opaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await getPrisma().customerSession.create({
    data: { org_id: user.org_id, userId: user.id, tokenHash: hashToken(refreshToken), userAgent: meta.userAgent ?? null, expiresAt },
  });
  return {
    accessToken,
    accessTokenExpiresIn: CUSTOMER_ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
    refreshTokenExpiresAt: expiresAt.toISOString(),
    user: { id: user.id, name: user.name, email: user.email },
  };
}

export async function loginCustomer(rawBody: unknown, meta: RequestMeta): Promise<CustomerSessionResult> {
  const input = parseInput(customerLoginSchema, rawBody, "Please check your email and password.");
  const orgId = getDefaultOrgId();
  const user = await findByEmail(orgId, input.email);

  // An address with no usable account (unknown, unverified, disabled, deleted, staff) behaves exactly like a
  // real one with a wrong password: same lock after repeated failures, same bcrypt work, same answer.
  if (!user || !canCustomerLogin(user) || !user.password) {
    if (isShadowLocked(shadowKey(input.email))) throw new ServiceError("FORBIDDEN", LOCKED);
    await burnBcrypt(input.password);
    recordShadowFailure(shadowKey(input.email));
    throw new ServiceError("VALIDATION", INVALID_LOGIN);
  }

  if (user.lockoutUntil && user.lockoutUntil > new Date()) throw new ServiceError("FORBIDDEN", LOCKED);

  if (!(await bcrypt.compare(input.password, user.password))) {
    await recordFailedLogin(user.id, user.failedLoginAttempts);
    throw new ServiceError("VALIDATION", INVALID_LOGIN);
  }

  await getPrisma().user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockoutUntil: null, lastActiveAt: new Date() } }).catch(() => {});
  return issueSession({ id: user.id, org_id: user.org_id, name: user.name, email: user.email }, meta);
}

async function recordFailedLogin(userId: string, current: number): Promise<void> {
  const attempts = current + 1;
  const data: { failedLoginAttempts: number; lockoutUntil?: Date } = { failedLoginAttempts: attempts };
  if (attempts >= MAX_FAILED_ATTEMPTS) data.lockoutUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
  await getPrisma().user.update({ where: { id: userId }, data }).catch(() => {});
}

export async function refreshCustomerSession(rawBody: unknown, meta: RequestMeta): Promise<CustomerSessionResult> {
  const { refreshToken } = parseInput(customerRefreshSchema, rawBody, "A refresh token is required.");
  const prisma = getPrisma();
  const existing = await prisma.customerSession.findUnique({ where: { tokenHash: hashToken(refreshToken) } });

  if (!existing || existing.expiresAt <= new Date()) throw new ServiceError("FORBIDDEN", SESSION_EXPIRED);

  if (existing.revokedAt) {
    // Rotated and shown again well after the fact: theft. Every session of this customer ends.
    if (existing.replacedByTokenId && Date.now() - existing.revokedAt.getTime() > REUSE_GRACE_MS) {
      await revokeAllCustomerSessions(prisma, existing.org_id, existing.userId);
    }
    throw new ServiceError("FORBIDDEN", SESSION_EXPIRED);
  }

  // Fresh from the database on every rotation: a disabled, unverified or deleted account stops here.
  const dbUser = await prisma.user.findFirst({ where: { id: existing.userId, org_id: existing.org_id }, select: accountSelect });
  if (!dbUser || !canCustomerLogin(dbUser)) throw new ServiceError("FORBIDDEN", SESSION_EXPIRED);

  const newRefresh = opaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  try {
    await prisma.$transaction(async (tx) => {
      // Atomic claim: if a parallel request already rotated this token, count is 0 and everything rolls back.
      const claimed = await tx.customerSession.updateMany({ where: { id: existing.id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (claimed.count === 0) throw new SessionAlreadyUsed();
      const created = await tx.customerSession.create({
        data: { org_id: existing.org_id, userId: existing.userId, tokenHash: hashToken(newRefresh), userAgent: meta.userAgent ?? null, expiresAt },
      });
      await tx.customerSession.update({ where: { id: existing.id }, data: { replacedByTokenId: created.id } });
    });
  } catch (error) {
    if (error instanceof SessionAlreadyUsed) throw new ServiceError("FORBIDDEN", SESSION_EXPIRED);
    throw error;
  }

  return {
    accessToken: await signCustomerToken({ sub: dbUser.id, orgId: dbUser.org_id }),
    accessTokenExpiresIn: CUSTOMER_ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: newRefresh,
    refreshTokenExpiresAt: expiresAt.toISOString(),
    user: { id: dbUser.id, name: dbUser.name, email: dbUser.email },
  };
}

export async function logoutCustomer(rawBody: unknown): Promise<void> {
  const { refreshToken } = parseInput(customerLogoutSchema, rawBody, "A refresh token is required.");
  // Idempotent: an unknown or already-revoked token is not an error.
  await getPrisma().customerSession.updateMany({ where: { tokenHash: hashToken(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Ends every session of one customer. Call inside the transaction of whatever triggered it. */
export async function revokeAllCustomerSessions(tx: Prisma.TransactionClient | ReturnType<typeof getPrisma>, orgId: string, userId: string): Promise<void> {
  await tx.customerSession.updateMany({ where: { org_id: orgId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

// ---------------------------------------------------------------------------------------------
// Forgot / reset password

export async function forgotPassword(rawBody: unknown, meta: RequestMeta = {}): Promise<typeof GENERIC_ACCEPTED> {
  return withResponseFloor(async () => {
    const { email } = parseInput(customerEmailOnlySchema, rawBody, INVALID_INPUT);
    if (!otpRequestAllowed(email, meta.ip)) return GENERIC_ACCEPTED;
    const orgId = getDefaultOrgId();
    const user = await findByEmail(orgId, email);
    // Staff-created customers have no password yet and no verified email: this is how they get in.
    if (user && user.userType === "CUSTOMER" && user.deletedAt === null && user.loginEnabled) {
      const code = await getPrisma().$transaction((tx) => issueOtp(tx, orgId, user.id, "RESET"));
      queueEmail(passwordResetEmail(email, code));
    }
    return GENERIC_ACCEPTED;
  });
}

export async function resetPassword(rawBody: unknown): Promise<{ reset: true }> {
  const input = parseInput(customerResetPasswordSchema, rawBody, INVALID_INPUT);
  const passwordHash = await bcrypt.hash(input.newPassword, PASSWORD_SALT_ROUNDS);

  const orgId = getDefaultOrgId();
  const user = await findByEmail(orgId, input.email);
  const eligible = user && user.userType === "CUSTOMER" && user.deletedAt === null && user.loginEnabled;

  if (!eligible) {
    burnOtpWork(input.code);
    throw new ServiceError("VALIDATION", INVALID_CODE);
  }
  if (!(await consumeOtp(orgId, user.id, "RESET", input.code))) throw new ServiceError("VALIDATION", INVALID_CODE);

  await getPrisma().$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      // Being able to read the mailbox proves the address, so a staff-created customer is verified here.
      data: { password: passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date(), failedLoginAttempts: 0, lockoutUntil: null },
    });
    await revokeAllCustomerSessions(tx, orgId, user.id);
    await activityLog.record(tx, { orgId, actorId: user.id, action: "CUSTOMER_RESET_PASSWORD", entity: "Customer", entityId: user.id });
  });
  return { reset: true };
}

// ---------------------------------------------------------------------------------------------
// Delete account

/** Removes personal data and ends access. Vehicles and other business records stay, pointing at an anonymous row. */
export async function deleteCustomerAccount(customer: { id: string; orgId: string }, rawBody: unknown): Promise<{ deleted: true }> {
  const { password } = parseInput(customerDeleteAccountSchema, rawBody, INVALID_INPUT);
  const prisma = getPrisma();
  const user = await prisma.user.findFirst({
    where: { id: customer.id, org_id: customer.orgId, userType: "CUSTOMER", deletedAt: null },
    select: accountSelect,
  });
  if (!user || !user.password) throw new ServiceError("NOT_FOUND", "Account not found.");

  if (user.lockoutUntil && user.lockoutUntil > new Date()) throw new ServiceError("FORBIDDEN", LOCKED);
  if (!(await bcrypt.compare(password, user.password))) {
    await recordFailedLogin(user.id, user.failedLoginAttempts);
    throw new ServiceError("VALIDATION", INCORRECT_PASSWORD, { password: INCORRECT_PASSWORD });
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        name: "Deleted customer",
        email: null,
        phone: null,
        address: null,
        companyName: null,
        country: null,
        destinationPort: null,
        language: null,
        theme: null,
        assignedAgentId: null,
        password: null,
        loginEnabled: false,
        emailVerifiedAt: null,
        failedLoginAttempts: 0,
        lockoutUntil: null,
        deletedAt: new Date(),
      },
    });
    await revokeAllCustomerSessions(tx, customer.orgId, user.id);
    await tx.otpCode.deleteMany({ where: { org_id: customer.orgId, userId: user.id } });
    await tx.deviceToken.deleteMany({ where: { org_id: customer.orgId, userId: user.id } });
    // Personal content goes with the account: chat, alerts and notification settings.
    const conversations = await tx.conversation.findMany({ where: { org_id: customer.orgId, customerId: user.id }, select: { id: true } });
    if (conversations.length > 0) {
      await tx.message.deleteMany({ where: { org_id: customer.orgId, conversationId: { in: conversations.map((c) => c.id) } } });
      await tx.conversation.deleteMany({ where: { org_id: customer.orgId, customerId: user.id } });
    }
    await tx.notification.deleteMany({ where: { org_id: customer.orgId, userId: user.id } });
    await tx.notificationPreference.deleteMany({ where: { org_id: customer.orgId, userId: user.id } });
    await activityLog.record(tx, { orgId: customer.orgId, actorId: user.id, action: "CUSTOMER_DELETE_ACCOUNT", entity: "Customer", entityId: user.id });
  });
  return { deleted: true };
}
