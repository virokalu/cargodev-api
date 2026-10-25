// Access tokens for the CUSTOMER zone. A separate secret (CUSTOMER_JWT_SECRET), audience "customer" and the
// same issuer as staff tokens. A staff token cannot pass here (different secret and audience) and a
// customer token cannot pass the staff guard (different secret and audience): each is checked on its own.
// The payload carries only the user id and org; everything else is read from the database per request.

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { loadEnv } from "../config/env.js";
import { TOKEN_ISSUER } from "./mobile-jwt.js";

export const CUSTOMER_AUDIENCE = "customer";
export const CUSTOMER_ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

export interface CustomerTokenPayload {
  sub: string; // customer user id
  orgId: string;
  /** Epoch seconds. Only set on payloads read back from a verified token. */
  exp?: number;
}

export class CustomerTokenError extends Error {}

function getSecret(): Uint8Array {
  const secret = loadEnv().CUSTOMER_JWT_SECRET;
  if (!secret) throw new CustomerTokenError("The customer API is not configured.");
  return new TextEncoder().encode(secret);
}

export async function signCustomerToken(payload: CustomerTokenPayload): Promise<string> {
  return new SignJWT({ orgId: payload.orgId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(CUSTOMER_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${CUSTOMER_ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

/** Throws CustomerTokenError for anything that is not a valid, unexpired customer token. */
export async function verifyCustomerToken(token: string): Promise<CustomerTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: CUSTOMER_AUDIENCE,
    });
    if (typeof payload.sub !== "string" || typeof payload.orgId !== "string") {
      throw new CustomerTokenError("Malformed customer token payload.");
    }
    return { sub: payload.sub, orgId: payload.orgId, ...(typeof payload.exp === "number" ? { exp: payload.exp } : {}) };
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) throw new CustomerTokenError(error.message);
    throw error;
  }
}
