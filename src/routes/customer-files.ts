// Customer photos and documents, streamed by the API. The client addresses a file by its database id only; it never
// sees an R2 address, a key or a signed link. Authorisation happens before the store is touched.

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { CUSTOMER_RATE_LIMITS } from "../config/customer-rate-limits.js";
import { loadEnv } from "../config/env.js";
import { identifierLimiter } from "../lib/identifier-limiter.js";
import { parseInput } from "../lib/parse.js";
import { currentCustomer, requireCustomer } from "../plugins/customer-auth.js";
import { openCustomerFile, type CustomerFileKind, type ImageSize } from "../services/customer-file-access.service.js";

const limit = CUSTOMER_RATE_LIMITS.fileDownload;
const routeOptions = {
  config: { rateLimit: { max: limit.ip.max, timeWindow: limit.ip.windowMs } },
  preHandler: requireCustomer(),
};

const sizeQuery = z.object({ size: z.enum(["thumb", "full"]).default("full") }).strict();
const noQuery = z.object({}).strict();

async function serve(
  reply: FastifyReply,
  customer: { id: string; orgId: string },
  kind: CustomerFileKind,
  fileId: string,
  ifNoneMatch: string | undefined,
  size: ImageSize
) {
  // Per customer (the route limit above is per IP): counted before any work.
  if (!identifierLimiter.hit("fileDownload", customer.id, limit.identifier)) {
    void reply.header("Retry-After", String(Math.ceil(limit.identifier.windowMs / 1000)));
    throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
  }

  const opened = await openCustomerFile(customer, kind, fileId, { size, ...(ifNoneMatch ? { ifNoneMatch } : {}) });

  // These responses are the one place a customer API answer may be cached, and only privately.
  const maxAge = loadEnv().CUSTOMER_FILE_CACHE_SECONDS;
  reply
    .header("Cache-Control", `private, max-age=${maxAge}`)
    .header("Vary", "Authorization")
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "default-src 'none'; sandbox");
  if (opened.etag) reply.header("ETag", opened.etag);

  if (opened.status === 304) return reply.status(304).send();

  reply.header("Content-Type", opened.contentType).header("Content-Disposition", opened.contentDisposition);
  if (opened.contentLength !== null) reply.header("Content-Length", opened.contentLength);
  return reply.send(opened.body);
}

export function registerCustomerFileRoutes(app: FastifyInstance) {
  app.get<{ Params: { photoId: string }; Querystring: Record<string, unknown> }>("/photos/:photoId/image", routeOptions, async (request, reply) => {
    const { size } = parseInput(sizeQuery, request.query, "Invalid query parameters.");
    return serve(reply, currentCustomer(request), "photo", request.params.photoId, request.headers["if-none-match"], size);
  });

  app.get<{ Params: { documentId: string }; Querystring: Record<string, unknown> }>("/documents/:documentId/file", routeOptions, async (request, reply) => {
    parseInput(noQuery, request.query, "Invalid query parameters.");
    return serve(reply, currentCustomer(request), "document", request.params.documentId, request.headers["if-none-match"], "full");
  });
}
