// /api/customer/v1: the customer's alerts, notification preferences, push devices, presence heartbeat and live stream.
// Thin: guard, rate limits, one service call. The stream has its own route and guard; it shares only the hub.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { CUSTOMER_RATE_LIMITS, type CustomerLimitName } from "../config/customer-rate-limits.js";
import { identifierLimiter } from "../lib/identifier-limiter.js";
import { ACCESS_TOKEN_TTL_SECONDS } from "../lib/mobile-jwt.js";
import { success } from "../lib/response.js";
import { openSseStream } from "../lib/sse-route.js";
import { currentCustomer, requireCustomer } from "../plugins/customer-auth.js";
import {
  deleteCustomerDevice,
  getPreferences,
  listAlerts,
  markAlertsRead,
  recordHeartbeat,
  registerCustomerDevice,
  updatePreferences,
} from "../services/customer-alerts.service.js";

const ipLimit = (name: CustomerLimitName) => ({
  config: { rateLimit: { max: CUSTOMER_RATE_LIMITS[name].ip.max, timeWindow: CUSTOMER_RATE_LIMITS[name].ip.windowMs } },
});

type LimitedName = "read" | "alertsWrite" | "preferences" | "devices" | "presence" | "stream";

/** Per-customer limit, counted before any work. Answers 429 in the standard envelope. */
function limitCustomer(name: LimitedName, request: FastifyRequest, reply: { header(name: string, value: string): unknown }): void {
  const limit = CUSTOMER_RATE_LIMITS[name].identifier;
  if (identifierLimiter.hit(name, currentCustomer(request).id, limit)) return;
  reply.header("Retry-After", String(Math.ceil(limit.windowMs / 1000)));
  throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
}

export function registerCustomerNotificationRoutes(app: FastifyInstance) {
  const guard = requireCustomer();
  const route = (name: CustomerLimitName) => ({ ...ipLimit(name), preHandler: guard });

  app.get("/alerts", route("read"), async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await listAlerts(currentCustomer(request), request.query));
  });

  app.post("/alerts/mark-read", route("alertsWrite"), async (request, reply) => {
    limitCustomer("alertsWrite", request, reply);
    return success(await markAlertsRead(currentCustomer(request), request.body));
  });

  app.get("/me/notification-preferences", route("preferences"), async (request, reply) => {
    limitCustomer("preferences", request, reply);
    return success(await getPreferences(currentCustomer(request)));
  });

  app.patch("/me/notification-preferences", route("preferences"), async (request, reply) => {
    limitCustomer("preferences", request, reply);
    return success(await updatePreferences(currentCustomer(request), request.body));
  });

  app.post("/devices", route("devices"), async (request, reply) => {
    limitCustomer("devices", request, reply);
    return success(await registerCustomerDevice(currentCustomer(request), request.body));
  });

  app.delete<{ Params: { id: string } }>("/devices/:id", route("devices"), async (request, reply) => {
    limitCustomer("devices", request, reply);
    await deleteCustomerDevice(currentCustomer(request), request.params.id);
    return success({ deleted: true });
  });

  app.post("/presence/heartbeat", route("presence"), async (request, reply) => {
    limitCustomer("presence", request, reply);
    return success(await recordHeartbeat(currentCustomer(request)));
  });

  // Live alerts over Server-Sent Events. Same hub as the staff stream, separate route and guard: a customer token
  // is the only way in here, and the hub delivers only events published for THIS customer's own user id. The
  // stream ends at the token's expiry. The token must be in the Authorization header (a URL token would be logged).
  app.get("/stream", route("stream"), async (request, reply) => {
    limitCustomer("stream", request, reply);
    const customer = currentCustomer(request);
    return openSseStream(app.sseHub, request, reply, {
      userId: customer.id,
      orgId: customer.orgId,
      expiresAt: request.customerTokenExpiresAt ?? Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
    });
  });
}
