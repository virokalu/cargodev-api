// /api/v1/chat: the staff side of customer chat (inbox, read, reply, mark handled).
// ADMINISTRATOR and MANAGER reach every conversation of their org; an OPERATOR only those of customers assigned to them
// (checked against the database on every request, config/roles.ts); VIEWER is refused. Anything out of scope is a 404.

import type { FastifyInstance } from "fastify";
import { CHAT_ROLES } from "../config/roles.js";
import { success } from "../lib/response.js";
import { authenticate, currentUser } from "../plugins/auth.js";
import { listInbox, listStaffMessages, replyAsStaff, setConversationHandled } from "../services/chat.service.js";

export function registerStaffChatRoutes(app: FastifyInstance) {
  const chat = { preHandler: authenticate(CHAT_ROLES) };
  type Params = { Params: { id: string } };

  app.get("/chat/conversations", chat, async (request) => success(await listInbox(currentUser(request), request.query)));

  app.get<Params>("/chat/conversations/:id/messages", chat, async (request) =>
    success(await listStaffMessages(currentUser(request), request.params.id, request.query))
  );

  app.post<Params>("/chat/conversations/:id/messages", chat, async (request, reply) =>
    reply.status(201).send(success(await replyAsStaff(currentUser(request), request.params.id, request.body)))
  );

  app.post<Params>("/chat/conversations/:id/handled", chat, async (request) =>
    success(await setConversationHandled(currentUser(request), request.params.id, request.body))
  );
}
