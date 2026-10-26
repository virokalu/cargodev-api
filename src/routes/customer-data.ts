// /api/customer/v1: the customer's own data. Thin: guard, rate limits, one service call.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { CUSTOMER_RATE_LIMITS, type CustomerLimitName } from "../config/customer-rate-limits.js";
import { loadEnv } from "../config/env.js";
import { identifierLimiter } from "../lib/identifier-limiter.js";
import { success } from "../lib/response.js";
import { currentCustomer, requireCustomer } from "../plugins/customer-auth.js";
import { createLinkRequest } from "../services/customer-link-request.service.js";
import {
  getCustomerHome,
  getCustomerTimeline,
  getCustomerVehicle,
  getPurchaseHistory,
  listCustomerDocuments,
  listCustomerPhotos,
  listCustomerVehicles,
  listFaqs,
} from "../services/customer-data.service.js";

const ipLimit = (name: CustomerLimitName) => ({
  config: { rateLimit: { max: CUSTOMER_RATE_LIMITS[name].ip.max, timeWindow: CUSTOMER_RATE_LIMITS[name].ip.windowMs } },
});

/** Per-customer limit, counted before any work. Answers 429 in the standard envelope. */
function limitCustomer(name: "read" | "linkRequest", request: FastifyRequest, reply: { header(name: string, value: string): unknown }): void {
  const limit = CUSTOMER_RATE_LIMITS[name].identifier;
  if (identifierLimiter.hit(name, currentCustomer(request).id, limit)) return;
  reply.header("Retry-After", String(Math.ceil(limit.windowMs / 1000)));
  throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
}

export function registerCustomerDataRoutes(app: FastifyInstance) {
  const read = { ...ipLimit("read"), preHandler: requireCustomer() };
  type VehicleParams = { Params: { vehicleId: string } };

  app.get("/home", read, async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await getCustomerHome(currentCustomer(request)));
  });

  app.get("/vehicles", read, async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await listCustomerVehicles(currentCustomer(request), request.query));
  });

  app.get<VehicleParams>("/vehicles/:vehicleId", read, async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await getCustomerVehicle(currentCustomer(request), request.params.vehicleId));
  });

  app.get<VehicleParams>("/vehicles/:vehicleId/timeline", read, async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await getCustomerTimeline(currentCustomer(request), request.params.vehicleId));
  });

  app.get<VehicleParams>("/vehicles/:vehicleId/photos", read, async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await listCustomerPhotos(currentCustomer(request), request.params.vehicleId));
  });

  app.get("/purchase-history", read, async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await getPurchaseHistory(currentCustomer(request)));
  });

  app.get("/documents", read, async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await listCustomerDocuments(currentCustomer(request), request.query));
  });

  app.get("/help/faqs", read, async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await listFaqs(currentCustomer(request), request.query));
  });

  app.post("/vehicles/link-requests", { ...ipLimit("linkRequest"), preHandler: requireCustomer() }, async (request, reply) => {
    limitCustomer("linkRequest", request, reply);
    return reply.status(202).send(success(await createLinkRequest(currentCustomer(request), request.body)));
  });

  // Runs before sign-in (an old app build must learn it has to update), so it takes no token and returns nothing private.
  app.get("/app/min-version", ipLimit("appConfig"), async () => success({ minVersion: loadEnv().APP_MIN_VERSION }));
}
