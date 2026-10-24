// Signing/verification for bearer access tokens (HS256, 20 minutes). Pure
// crypto, no Prisma. The secret is read lazily so importing this module in a
// unit test needs no environment.

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { StaffRole } from "@prisma/client";
import { loadEnv } from "../config/env.js";

export const ACCESS_TOKEN_TTL_SECONDS = 20 * 60; // 20 minutes

export interface AccessTokenPayload {
  sub: string; // user id
  orgId: string;
  role: StaffRole;
  name: string;
  email: string | null;
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(loadEnv().MOBILE_JWT_SECRET);
}

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  return new SignJWT({ orgId: payload.orgId, role: payload.role, name: payload.name, email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

export class AccessTokenError extends Error {}

const ROLES: readonly string[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];

/** Throws AccessTokenError on a missing/malformed/expired/bad-signature
 * token. The auth hook treats any throw as a 401. */
export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.orgId !== "string" ||
      typeof payload.role !== "string" ||
      !ROLES.includes(payload.role) ||
      typeof payload.name !== "string"
    ) {
      throw new AccessTokenError("Malformed access token payload.");
    }
    return {
      sub: payload.sub,
      orgId: payload.orgId,
      role: payload.role as StaffRole,
      name: payload.name,
      email: (payload.email as string | null | undefined) ?? null,
    };
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) {
      throw new AccessTokenError(error.message);
    }
    throw error;
  }
}
