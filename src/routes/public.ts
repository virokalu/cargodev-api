// /api/public: the website's read-only stock and the enquiry form. NO authentication, and nothing here ever reads a
// token, a cookie or an org from the request. Registered only when PUBLIC_STOCK_ENABLED is true.
//
// Cache-Control: the successful GET responses are the one deliberate exception to "no-store" (docs/api-contract.md):
// `public, max-age=60`. Errors, and the POST, stay no-store.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ENQUIRY_BODY_LIMIT_BYTES, PUBLIC_CACHE_SECONDS, PUBLIC_RATE_LIMITS } from "../config/public-stock.js";
import { identifierLimiter } from "../lib/identifier-limiter.js";
import { success } from "../lib/response.js";
import { createEnquiry } from "../services/enquiry.service.js";
import { getPublicStock, listPublicStock } from "../services/stock.service.js";

const perMinute = (limit: { max: number; windowMs: number }) => ({ config: { rateLimit: { max: limit.max, timeWindow: limit.windowMs } } });

function tooMany(reply: { header(name: string, value: string): unknown }, windowMs: number): never {
  reply.header("Retry-After", String(Math.ceil(windowMs / 1000)));
  throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
}

/** The email in an (unvalidated) body, normalised, or null. */
function bodyEmail(request: FastifyRequest): string | null {
  const body = request.body as { email?: unknown } | null | undefined;
  return typeof body?.email === "string" ? body.email.trim().toLowerCase().slice(0, 150) : null;
}

export function registerPublicRoutes(app: FastifyInstance) {
  app.get("/stock", perMinute(PUBLIC_RATE_LIMITS.read), async (request, reply) => {
    const data = await listPublicStock(request.query);
    reply.header("Cache-Control", `public, max-age=${PUBLIC_CACHE_SECONDS}`);
    return success(data);
  });

  app.get<{ Params: { slug: string } }>("/stock/:slug", perMinute(PUBLIC_RATE_LIMITS.read), async (request, reply) => {
    const data = await getPublicStock(request.params.slug);
    reply.header("Cache-Control", `public, max-age=${PUBLIC_CACHE_SECONDS}`);
    return success(data);
  });

  app.post("/enquiries", { bodyLimit: ENQUIRY_BODY_LIMIT_BYTES, ...perMinute(PUBLIC_RATE_LIMITS.enquiryIpBurst) }, async (request, reply) => {
    // Counted before any work and whatever the body holds, so a flood costs one cheap check.
    if (!identifierLimiter.hit("enquiry-ip", request.ip, PUBLIC_RATE_LIMITS.enquiryIpHour)) tooMany(reply, PUBLIC_RATE_LIMITS.enquiryIpHour.windowMs);
    const email = bodyEmail(request);
    if (email && !identifierLimiter.hit("enquiry-email", email, PUBLIC_RATE_LIMITS.enquiryEmailHour)) tooMany(reply, PUBLIC_RATE_LIMITS.enquiryEmailHour.windowMs);
    return reply.status(202).send(success(await createEnquiry(request.body, { ip: request.ip })));
  });
}
