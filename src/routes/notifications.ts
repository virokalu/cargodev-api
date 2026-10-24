import type { FastifyInstance } from "fastify";
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
export function registerNotificationRoutes(app: FastifyInstance) {
  const auth = { preHandler: authenticate() };

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

  app.post("/device-tokens", auth, async (request) => {
    const user = currentUser(request);
    return success(await registerDeviceToken(user.orgId, user.id, request.body));
  });

  app.delete("/device-tokens", auth, async (request) => {
    const user = currentUser(request);
    await unregisterDeviceToken(user.orgId, user.id, request.body);
    return success({ unregistered: true });
  });
}
