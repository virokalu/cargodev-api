// Auth hook. Verifies the Bearer access token (signature, issuer, audience, expiry), then asks getFreshStaffAuth() whether that
// staff user is STILL active in that org and which role the DATABASE gives them now (through a short in-process cache,
// STAFF_AUTH_CACHE_SECONDS). The token's role claim is never used for a decision. Then it enforces the route's role allow-list.
// The actor's orgId comes ONLY from the verified token, never from the request.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { StaffRole } from "@prisma/client";
import { AccessTokenError, verifyAccessToken } from "../lib/mobile-jwt.js";
import { ServiceError } from "../lib/errors.js";
import { errorBody } from "../lib/response.js";
import type { SessionUser } from "../lib/session-user.js";
import { tokenClaimsAreTrusted } from "../lib/staff-auth-seam.js";
import { getFreshStaffAuth } from "../services/staff-auth-state.service.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    /** When the verified access token expires, in epoch milliseconds. Long-lived responses (streams) end then. */
    tokenExpiresAt: number | null;
  }
}

function unauthenticated(reply: FastifyReply, message: string) {
  return reply.status(401).send(errorBody("UNAUTHENTICATED", message));
}

/** preHandler factory. Omit `roles` to allow any authenticated staff role. */
export function authenticate(roles?: readonly StaffRole[]) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) return unauthenticated(reply, "Missing bearer token.");

    let payload;
    try {
      payload = await verifyAccessToken(token);
    } catch (error) {
      if (error instanceof AccessTokenError) return unauthenticated(reply, "Invalid or expired token.");
      throw error;
    }

    // The database decides (tests may take the token's claims through the NODE_ENV=test seam; nothing else can).
    const fresh = tokenClaimsAreTrusted()
      ? { id: payload.sub, orgId: payload.orgId, role: payload.role, name: payload.name, email: payload.email }
      : await getFreshStaffAuth(payload.sub, payload.orgId);
    // Deactivated, deleted or never a staff member of this org: the same answer as a bad token.
    if (!fresh) return unauthenticated(reply, "Invalid or expired token.");

    const user: SessionUser = { id: fresh.id, role: fresh.role, orgId: fresh.orgId, name: fresh.name, email: fresh.email };

    if (roles && !roles.includes(user.role)) {
      throw new ServiceError("FORBIDDEN", "You don't have permission to access this resource.");
    }
    request.user = user;
    request.tokenExpiresAt = payload.exp !== undefined ? payload.exp * 1000 : null;
  };
}

/** The authenticated actor. Only call from a route guarded by authenticate(). */
export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new Error("currentUser() called on a route without authenticate()");
  return request.user;
}
