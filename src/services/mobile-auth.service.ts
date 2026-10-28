// Business logic for the /api/v1 bearer-token lifecycle. Login issues an
// access+refresh pair; refresh rotates the refresh token (the old row is
// marked revoked + replacedByTokenId, a new row takes its place, all in one
// transaction); logout revokes on demand. Refresh tokens are opaque
// (crypto.randomBytes) and stored only as a sha256 hash — a leaked DB
// backup alone can't be replayed as a working token.

import { randomBytes, createHash } from "crypto";
import type { Prisma, StaffRole } from "@prisma/client";
import { getPrisma } from "../lib/prisma.js";
import { ServiceError } from "../lib/errors.js";
import { verifyStaffCredentials } from "./staff-auth.service.js";
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from "../lib/mobile-jwt.js";
import {
  mobileLoginSchema,
  mobileRefreshSchema,
  mobileLogoutSchema,
} from "../validation/mobile-auth.schema.js";
import { flattenFieldErrors } from "../validation/shared.js";

const REFRESH_TOKEN_TTL_DAYS = 30;

// Presenting an already-rotated token again is either a client retry after a
// dropped response or a stolen token. Within this window we treat it as a
// retry (reject, but leave the live session alone); after it, as theft (revoke
// every active token for the user).
const REUSE_GRACE_MS = 10_000;

// Thrown inside the rotation transaction to roll it back when another request
// already claimed the same refresh token.
class RefreshTokenAlreadyUsed extends Error {}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface MobileAuthUser {
  id: string;
  name: string;
  email: string | null;
  role: StaffRole;
  orgId: string;
}

export interface MobileAuthResult {
  accessToken: string;
  accessTokenExpiresIn: number; // seconds
  refreshToken: string;
  refreshTokenExpiresAt: string; // ISO date
  user: MobileAuthUser;
}

function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function issueTokenPair(user: MobileAuthUser, meta: RequestMeta): Promise<MobileAuthResult> {
  const accessToken = await signAccessToken({
    sub: user.id,
    orgId: user.orgId,
    role: user.role,
    name: user.name,
    email: user.email,
  });

  const refreshToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await getPrisma().refreshToken.create({
    data: {
      org_id: user.orgId,
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      createdByIp: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      expiresAt,
    },
  });

  return {
    accessToken,
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
    refreshTokenExpiresAt: expiresAt.toISOString(),
    user,
  };
}

export async function loginMobile(rawBody: unknown, meta: RequestMeta): Promise<MobileAuthResult> {
  const parsed = mobileLoginSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new ServiceError(
      "VALIDATION",
      "Please check your email and password.",
      flattenFieldErrors(parsed.error)
    );
  }

  // verifyStaffCredentials itself throws ServiceError("FORBIDDEN") for an
  // active lockout — let that propagate as-is, it's already the right shape.
  const verified = await verifyStaffCredentials(parsed.data.email, parsed.data.password);
  if (!verified) {
    throw new ServiceError("VALIDATION", "Invalid email or password.");
  }

  return issueTokenPair(verified, meta);
}

export async function refreshMobileToken(rawBody: unknown, meta: RequestMeta): Promise<MobileAuthResult> {
  const parsed = mobileRefreshSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new ServiceError("VALIDATION", "A refresh token is required.", flattenFieldErrors(parsed.error));
  }

  const tokenHash = hashToken(parsed.data.refreshToken);
  const existing = await getPrisma().refreshToken.findUnique({ where: { tokenHash } });

  if (!existing || existing.expiresAt <= new Date()) {
    throw new ServiceError("FORBIDDEN", "Session expired. Please sign in again.");
  }

  if (existing.revokedAt) {
    // Revoked by rotation (replacedByTokenId set) and presented again well after
    // the fact: treat as token theft and kill every session for this user.
    // A token revoked by logout has no replacement, so it is a plain rejection.
    const wasRotated = Boolean(existing.replacedByTokenId);
    if (wasRotated && Date.now() - existing.revokedAt.getTime() > REUSE_GRACE_MS) {
      await revokeAllUserTokens(getPrisma(), existing.org_id, existing.userId);
    }
    throw new ServiceError("FORBIDDEN", "Session expired. Please sign in again.");
  }

  // Re-check the user fresh from the DB on every rotation — this is what
  // keeps a deactivated account (or a role change) locked out within one
  // refresh cycle, independent of the explicit revocation hooks that
  // user.service.ts calls on deactivation/password change.
  const dbUser = await getPrisma().user.findFirst({
    where: { id: existing.userId, org_id: existing.org_id, userType: "STAFF", loginEnabled: true },
    select: { id: true, name: true, email: true, role: true, org_id: true },
  });

  if (!dbUser || !dbUser.role) {
    throw new ServiceError("FORBIDDEN", "Session expired. Please sign in again.");
  }
  const user: MobileAuthUser = {
    id: dbUser.id,
    name: dbUser.name,
    email: dbUser.email,
    role: dbUser.role,
    orgId: dbUser.org_id,
  };

  const newRefreshToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  try {
    await getPrisma().$transaction(async (tx) => {
      // Claim the old token atomically. If a concurrent request already rotated
      // it, count is 0 and this whole transaction rolls back, so one token can
      // never produce two live successors.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: existing.id, org_id: existing.org_id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 0) throw new RefreshTokenAlreadyUsed();

      const created = await tx.refreshToken.create({
        data: {
          org_id: user.orgId,
          userId: user.id,
          tokenHash: hashToken(newRefreshToken),
          createdByIp: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          expiresAt,
        },
      });
      await tx.refreshToken.updateMany({
        where: { id: existing.id, org_id: existing.org_id },
        data: { replacedByTokenId: created.id },
      });
    });
  } catch (error) {
    if (error instanceof RefreshTokenAlreadyUsed) {
      throw new ServiceError("FORBIDDEN", "Session expired. Please sign in again.");
    }
    throw error;
  }

  const accessToken = await signAccessToken({
    sub: user.id,
    orgId: user.orgId,
    role: user.role,
    name: user.name,
    email: user.email,
  });

  return {
    accessToken,
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: newRefreshToken,
    refreshTokenExpiresAt: expiresAt.toISOString(),
    user,
  };
}

export async function logoutMobile(rawBody: unknown): Promise<void> {
  const parsed = mobileLogoutSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new ServiceError("VALIDATION", "A refresh token is required.", flattenFieldErrors(parsed.error));
  }

  const tokenHash = hashToken(parsed.data.refreshToken);
  const { expoPushToken } = parsed.data;

  // The logout endpoint is public, so the refresh token is the only proof of who
  // is signing out. It decides whose device token may be removed.
  const owner = expoPushToken
    ? await getPrisma().refreshToken.findUnique({
        where: { tokenHash },
        select: { org_id: true, userId: true },
      })
    : null;

  // Idempotent — an already-revoked or unknown token isn't an error, since
  // the end state ("this token no longer works") already holds either way.
  await getPrisma().$transaction(async (tx) => {
    await tx.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (expoPushToken && owner) {
      // Scoped to the refresh token's own org and user: signing out can never
      // unregister someone else's device, even if its token is known.
      await tx.deviceToken.deleteMany({
        where: { expoPushToken, org_id: owner.org_id, userId: owner.userId },
      });
    }
  });
}

/** Revokes every active refresh token for a user. Called from
 * user.service.ts's setStaffActive(false) and changeOwnPassword(), inside
 * the same transaction as the mutation that triggers it, so revocation is
 * atomic with the change rather than a best-effort afterthought. */
export async function revokeAllUserTokens(
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { org_id: orgId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
