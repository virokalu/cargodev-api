// GET /f/v1/:kind/:id/:variant: the own-domain file links (ADR 0007). No Bearer token: the signed link is the ticket, and the database is
// asked again on every fetch (services/file-link.service.ts). Every failure is the SAME 404 (status, headers and body), so a link
// cannot be used to learn whether a file exists, whose it is, or why it was refused.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FILE_LINK_RATE_LIMIT } from "../config/file-link-rate-limits.js";
import { errorBody } from "../lib/response.js";
import { openFileLink } from "../services/file-link.service.js";

/** The one failure answer. Do not add a header or a field that depends on WHY it failed. */
function notFound(reply: FastifyReply) {
  return reply.status(404).send(errorBody("NOT_FOUND", "File not found."));
}

export function registerFileLinkRoutes(app: FastifyInstance) {
  app.get<{ Params: { kind: string; id: string; variant: string }; Querystring: Record<string, unknown> }>(
    "/f/v1/:kind/:id/:variant",
    { config: { rateLimit: { max: FILE_LINK_RATE_LIMIT.max, timeWindow: FILE_LINK_RATE_LIMIT.windowMs } } },
    async (request: FastifyRequest<{ Params: { kind: string; id: string; variant: string }; Querystring: Record<string, unknown> }>, reply) => {
      const opened = await openFileLink(request.params, request.query, {
        ...(typeof request.headers["if-none-match"] === "string" ? { ifNoneMatch: request.headers["if-none-match"] } : {}),
        ...(typeof request.headers["range"] === "string" ? { rangeHeader: request.headers["range"] } : {}),
      });
      if (!opened) return notFound(reply);

      // The one place (with the customer files) where a private cache is allowed; never shared, and never longer than the link lives.
      reply
        .header("Cache-Control", `private, max-age=${"maxAgeSeconds" in opened ? opened.maxAgeSeconds : 0}`)
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        // A staff or customer app on another origin shows the file in an <img> or an embedded viewer.
        .header("Cross-Origin-Resource-Policy", "cross-origin");

      if (opened.status === 416) return reply.status(416).send(errorBody("VALIDATION", "Range not satisfiable."));
      if (opened.etag) reply.header("ETag", opened.etag);
      if (opened.status === 304) return reply.status(304).send();

      reply.header("Content-Type", opened.contentType).header("Content-Disposition", opened.contentDisposition);
      if (opened.acceptRanges) reply.header("Accept-Ranges", "bytes");
      if (opened.contentRange) reply.header("Content-Range", opened.contentRange);
      if (opened.contentLength !== null) reply.header("Content-Length", opened.contentLength);

      // If the client goes away, stop reading from storage.
      const stop = () => opened.body.destroy();
      request.raw.once("close", stop);
      reply.raw.once("close", stop);
      return reply.status(opened.status).send(opened.body);
    }
  );
}
