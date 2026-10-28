// One-time codes for customers (email verification and password reset).
//
// Brute force is the threat: a 6-digit code has a million values. So every check SPENDS an attempt
// before the code is compared (a single atomic UPDATE ... WHERE attempts < 5), which means a burst of
// parallel guesses cannot get more than 5 tries however it is timed. A new code retires the old one.

import type { OtpPurpose, Prisma } from "@prisma/client";
import { getPrisma } from "../lib/prisma.js";
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS, generateOtp, hashOtp, otpMatches } from "../lib/otp.js";

type TxClient = Prisma.TransactionClient;

/** Retires any unused code for this user and purpose, creates a fresh one, returns the plain code (to email). */
export async function issueOtp(tx: TxClient, orgId: string, userId: string, purpose: OtpPurpose): Promise<string> {
  const code = generateOtp();
  await tx.otpCode.updateMany({
    where: { org_id: orgId, userId, purpose, usedAt: null },
    data: { usedAt: new Date() },
  });
  await tx.otpCode.create({
    data: { org_id: orgId, userId, purpose, codeHash: hashOtp(orgId, userId, purpose, code), attempts: 0, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });
  return code;
}

/** True only if `code` is the live code for this user and purpose. Consumes it on success. */
export async function consumeOtp(orgId: string, userId: string, purpose: OtpPurpose, code: string): Promise<boolean> {
  const prisma = getPrisma();
  const now = new Date();
  const live = await prisma.otpCode.findFirst({
    where: { org_id: orgId, userId, purpose, usedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!live) return false;

  // Spend an attempt first, atomically. Zero rows means the 5 attempts are gone (or it was just used).
  const spent = await prisma.otpCode.updateMany({
    where: { id: live.id, org_id: orgId, usedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (spent.count === 0) return false;

  if (!otpMatches(live.codeHash, orgId, userId, purpose, code)) return false;

  // Single use: only one of several parallel correct submissions can claim it.
  const claimed = await prisma.otpCode.updateMany({ where: { id: live.id, org_id: orgId, usedAt: null }, data: { usedAt: new Date() } });
  return claimed.count === 1;
}

/** Same work as a real check, for an address with no account, so the timing does not tell them apart. */
export function burnOtpWork(code: string): void {
  otpMatches("0".repeat(64), "-", "-", "RESET", code);
}
