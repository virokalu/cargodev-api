// Opens a Server-Sent Events response on the shared hub. Used by BOTH streams (staff: /api/v1/notifications/stream,
// customers: /api/customer/v1/stream), each behind its own guard. This function trusts its caller to have
// authenticated: the user id, org id and expiry come from a verified token, never from the request.

import type { FastifyReply, FastifyRequest } from "fastify";
import { errorBody } from "./response.js";
import type { SseHub } from "./sse-hub.js";

export function openSseStream(
  hub: SseHub,
  request: FastifyRequest,
  reply: FastifyReply,
  who: { userId: string; orgId: string; expiresAt: number }
): FastifyReply {
  if (!hub.hasCapacity()) {
    reply.header("Retry-After", "30");
    return reply.status(429).send(errorBody("RATE_LIMITED", "Too many open streams. Try again later."));
  }

  // From here on we own the socket: the error handler and onSend hooks no longer apply.
  reply.hijack();
  const raw = reply.raw;
  // Headers already set on the reply (no-store, security headers, CORS) are not sent after hijack.
  const inherited: Record<string, string | number | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) inherited[name] = value;
  }
  raw.writeHead(200, {
    ...inherited,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // tell reverse proxies not to buffer the stream
  });
  raw.write("retry: 5000\n: connected\n\n");

  const connection = hub.open({ userId: who.userId, orgId: who.orgId, sink: raw, expiresAt: who.expiresAt });

  const cleanup = () => connection.dispose();
  request.raw.on("close", cleanup);
  request.raw.on("error", cleanup);
  raw.on("close", cleanup);
  raw.on("error", cleanup);

  return reply;
}
