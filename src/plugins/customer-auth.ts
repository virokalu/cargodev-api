// Guard for the customer zone. Verifies a CUSTOMER access token (own secret, audience "customer"), then loads the
// account from the database on every request, so disabling, deleting or unverifying a customer takes effect at
// once instead of when the 15-minute token expires. The org and customer id come only from the verified token.

import type { FastifyReply, FastifyRequest } from "fastify";
import { findActiveCustomer } from "../lib/customer-access.js";
import { CustomerTokenError, verifyCustomerToken } from "../lib/customer-jwt.js";
import { errorBody } from "../lib/response.js";

export interface CustomerPrincipal {
  id: string;
  orgId: string;
  name: string;
}

declare module "fastify" {
  interface FastifyRequest {
    customer: CustomerPrincipal | null;
    /** When the verified customer token expires, epoch milliseconds. */
    customerTokenExpiresAt: number | null;
  }
}

function unauthenticated(reply: FastifyReply) {
  return reply.status(401).send(errorBody("UNAUTHENTICATED", "Invalid or expired token."));
}

export function requireCustomer() {
  return async function customerHook(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) return reply.status(401).send(errorBody("UNAUTHENTICATED", "Missing bearer token."));

    let payload;
    try {
      payload = await verifyCustomerToken(token);
    } catch (error) {
      if (error instanceof CustomerTokenError) return unauthenticated(reply);
      throw error;
    }

    const principal = await findActiveCustomer(payload.sub, payload.orgId);
    if (!principal) return unauthenticated(reply);

    request.customer = principal;
    request.customerTokenExpiresAt = payload.exp !== undefined ? payload.exp * 1000 : null;
  };
}

/** The signed-in customer. Only call from a route guarded by requireCustomer(). */
export function currentCustomer(request: FastifyRequest): CustomerPrincipal {
  if (!request.customer) throw new Error("currentCustomer() called on a route without requireCustomer()");
  return request.customer;
}
