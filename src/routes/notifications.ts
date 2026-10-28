import type { FastifyInstance } from "fastify";
import { ACCESS_TOKEN_TTL_SECONDS } from "../lib/mobile-jwt.js";
import { openSseStream } from "../lib/sse-route.js";
import type { SseHub } from "../lib/sse-hub.js";
import { authenticate, currentUser } from "../plugins/auth.js";
import { tokenClaimsAreTrusted } from "../lib/staff-auth-seam.js";
import { getFreshStaffAuth } from "../services/staff-auth-state.service.js";
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
  /** Tests only. */
  recheckMs?: number;
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
    return openSseStream(deps.sseHub, request, reply, {
      userId: user.id,
      orgId: user.orgId,
      // Never outlive the token that opened the stream.
      expiresAt: request.tokenExpiresAt ?? Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
      // Every minute, straight from the database (no cache): a user disabled while connected loses the stream.
      ...(deps.recheckMs !== undefined ? { recheckMs: deps.recheckMs } : {}),
      recheck: async () => tokenClaimsAreTrusted() || (await getFreshStaffAuth(user.id, user.orgId, { bypassCache: true })) !== null,
    });
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
