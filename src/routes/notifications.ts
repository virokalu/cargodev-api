import type { FastifyInstance } from "fastify";
import { ACCESS_TOKEN_TTL_SECONDS } from "../lib/mobile-jwt.js";
import { errorBody } from "../lib/response.js";
import type { SseHub } from "../lib/sse-hub.js";
import { authenticate, currentUser } from "../plugins/auth.js";
import { parseInput } from "../lib/parse.js";
import { success } from "../lib/response.js";
import {
  countUnread,
  listNotificationsPaginated,
  markAllRead,
  markRead,
} from "../services/notification.service.js";
import { registerDeviceToken, unregisterDeviceToken } from "../services/device-token.service.js";
import { notificationListQuerySchema } from "../validation/notification.schema.js";

// Every endpoint acts only on the token's own user id and org, so any staff
// role may use them.

// Registering and unregistering devices is rare in normal use (app start, login,
// logout), so a tight per-IP limit costs nothing and stops token-probing.
const DEVICE_TOKEN_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
export interface NotificationRouteDeps {
  sseHub: SseHub;
}

// Reconnect storms are the main way a stream endpoint gets abused.
const STREAM_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

export function registerNotificationRoutes(app: FastifyInstance, deps: NotificationRouteDeps) {
  const auth = { preHandler: authenticate() };

  // Live notifications over Server-Sent Events. A convenience, not the source of
  // truth: there is no replay, so after (re)connecting a client calls GET /notifications
  // to catch up. The token must be in the Authorization header: a token in the URL
  // would end up in logs, so no query-string fallback exists.
  app.get("/notifications/stream", { ...auth, ...STREAM_RATE_LIMIT }, async (request, reply) => {
    const user = currentUser(request);

    if (!deps.sseHub.hasCapacity()) {
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

    const connection = deps.sseHub.open({
      userId: user.id,
      orgId: user.orgId,
      sink: raw,
      // Never outlive the token that opened the stream.
      expiresAt: request.tokenExpiresAt ?? Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
    });

    const cleanup = () => connection.dispose();
    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
    raw.on("close", cleanup);
    raw.on("error", cleanup);

    return reply;
  });

  app.get("/notifications", auth, async (request) => {
    const params = parseInput(notificationListQuerySchema, request.query);
    const user = currentUser(request);
    return success(await listNotificationsPaginated(user.orgId, user.id, params));
  });

  app.get("/notifications/unread-count", auth, async (request) => {
    const user = currentUser(request);
    return success({ count: await countUnread(user.orgId, user.id) });
  });

  app.post("/notifications/read-all", auth, async (request) => {
    const user = currentUser(request);
    await markAllRead(user.orgId, user.id);
    return success({ read: true });
  });

  app.post<{ Params: { id: string } }>("/notifications/:id/read", auth, async (request) => {
    const user = currentUser(request);
    await markRead(user.orgId, user.id, request.params.id);
    return success({ read: true });
  });

  app.post("/device-tokens", { ...auth, ...DEVICE_TOKEN_RATE_LIMIT }, async (request) => {
    const user = currentUser(request);
    return success(await registerDeviceToken(user.orgId, user.id, request.body));
  });

  app.delete("/device-tokens", { ...auth, ...DEVICE_TOKEN_RATE_LIMIT }, async (request) => {
    const user = currentUser(request);
    await unregisterDeviceToken(user.orgId, user.id, request.body);
    return success({ unregistered: true });
  });
}
