// /api/customer/v1: customer auth and profile. Thin: rate limits, then one service call.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CUSTOMER_RATE_LIMITS, type CustomerLimitName } from "../config/customer-rate-limits.js";
import { identifierLimiter } from "../lib/identifier-limiter.js";
import { success } from "../lib/response.js";
import { currentCustomer, requireCustomer } from "../plugins/customer-auth.js";
import {
  GENERIC_ACCEPTED,
  deleteCustomerAccount,
  forgotPassword,
  loginCustomer,
  logoutCustomer,
  refreshCustomerSession,
  registerCustomer,
  resendVerification,
  resetPassword,
  verifyEmail,
  type RequestMeta,
} from "../services/customer-auth.service.js";
import { getMe, updateMe } from "../services/customer-profile.service.js";

/** Route options carrying the per-IP limit from the config module. */
const ipLimit = (name: CustomerLimitName) => ({
  config: { rateLimit: { max: CUSTOMER_RATE_LIMITS[name].ip.max, timeWindow: CUSTOMER_RATE_LIMITS[name].ip.windowMs } },
});

function requestMeta(request: FastifyRequest): RequestMeta {
  const userAgent = request.headers["user-agent"];
  return userAgent ? { userAgent: userAgent.slice(0, 300) } : {};
}

/** The email in an (unvalidated) body, normalised, or null. */
function bodyEmail(request: FastifyRequest): string | null {
  const body = request.body as { email?: unknown } | null | undefined;
  return typeof body?.email === "string" ? body.email.trim().toLowerCase().slice(0, 150) : null;
}

/**
 * Per-identifier limit (the email, or the customer id). Counted whether or not the account exists, so being
 * limited reveals nothing. Answers 429 in the standard envelope.
 */
function limitByIdentifier(name: CustomerLimitName, identifier: string | null, reply: FastifyReply): boolean {
  const limits = CUSTOMER_RATE_LIMITS[name] as { identifier?: { max: number; windowMs: number } };
  if (!identifier || !limits.identifier) return true;
  if (identifierLimiter.hit(name, identifier, limits.identifier)) return true;
  const error = Object.assign(new Error("Too many requests"), { statusCode: 429 });
  void reply.header("Retry-After", String(Math.ceil(limits.identifier.windowMs / 1000)));
  throw error;
}

export function registerCustomerAuthRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireCustomer() };

  app.post("/auth/register", ipLimit("register"), async (request, reply) => {
    limitByIdentifier("register", bodyEmail(request), reply);
    return reply.status(202).send(success(await registerCustomer(request.body)));
  });

  app.post("/auth/verify-email", ipLimit("verifyEmail"), async (request, reply) => {
    limitByIdentifier("verifyEmail", bodyEmail(request), reply);
    return success(await verifyEmail(request.body));
  });

  app.post("/auth/resend-verification", ipLimit("resendVerification"), async (request, reply) => {
    limitByIdentifier("resendVerification", bodyEmail(request), reply);
    return reply.status(202).send(success(await resendVerification(request.body)));
  });

  app.post("/auth/login", ipLimit("login"), async (request, reply) => {
    limitByIdentifier("login", bodyEmail(request), reply);
    return success(await loginCustomer(request.body, requestMeta(request)));
  });

  app.post("/auth/refresh", ipLimit("refresh"), async (request) => success(await refreshCustomerSession(request.body, requestMeta(request))));

  app.post("/auth/logout", ipLimit("logout"), async (request) => {
    await logoutCustomer(request.body);
    return success({ loggedOut: true });
  });

  app.post("/auth/forgot-password", ipLimit("forgotPassword"), async (request, reply) => {
    limitByIdentifier("forgotPassword", bodyEmail(request), reply);
    return reply.status(202).send(success(await forgotPassword(request.body)));
  });

  app.post("/auth/reset-password", ipLimit("resetPassword"), async (request, reply) => {
    limitByIdentifier("resetPassword", bodyEmail(request), reply);
    return success(await resetPassword(request.body));
  });

  app.post("/auth/delete-account", { ...ipLimit("deleteAccount"), ...auth }, async (request, reply) => {
    const customer = currentCustomer(request);
    limitByIdentifier("deleteAccount", customer.id, reply);
    return success(await deleteCustomerAccount(customer, request.body));
  });

  app.get("/me", { ...ipLimit("me"), ...auth }, async (request) => success(await getMe(currentCustomer(request))));
  app.patch("/me", { ...ipLimit("me"), ...auth }, async (request) => success(await updateMe(currentCustomer(request), request.body)));
}

export { GENERIC_ACCEPTED };
