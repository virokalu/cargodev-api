// Auth hook. Verifies the Bearer access token locally (no DB hit per request),
// attaches the actor, then enforces the route's role allow-list. The actor's
// orgId comes ONLY from the verified token, never from the request.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { StaffRole } from "@prisma/client";
import { AccessTokenError, verifyAccessToken } from "../lib/mobile-jwt.js";
import { ServiceError } from "../lib/errors.js";
import { errorBody } from "../lib/response.js";
import type { SessionUser } from "../lib/session-user.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
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

    const user: SessionUser = {
      id: payload.sub,
      role: payload.role,
      orgId: payload.orgId,
      name: payload.name,
      email: payload.email,
    };

    if (roles && !roles.includes(user.role)) {
      throw new ServiceError("FORBIDDEN", "You don't have permission to access this resource.");
    }
    request.user = user;
  };
}

/** The authenticated actor. Only call from a route guarded by authenticate(). */
export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new Error("currentUser() called on a route without authenticate()");
  return request.user;
}
