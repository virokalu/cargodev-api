// /api/customer/v1: the customer's chat. Thin: guard, rate limits, one service call. Plain text in, plain text out;
// the API never renders a message as markup (responses are JSON strings only).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { CUSTOMER_RATE_LIMITS, type CustomerLimitName } from "../config/customer-rate-limits.js";
import { identifierLimiter } from "../lib/identifier-limiter.js";
import { success } from "../lib/response.js";
import { currentCustomer, requireCustomer } from "../plugins/customer-auth.js";
import { listCustomerConversations, listCustomerMessages, sendCustomerMessage, startConversation, suggestedQuestions } from "../services/chat.service.js";

const ipLimit = (name: CustomerLimitName) => ({
  config: { rateLimit: { max: CUSTOMER_RATE_LIMITS[name].ip.max, timeWindow: CUSTOMER_RATE_LIMITS[name].ip.windowMs } },
});

type LimitedName = "read" | "chatSend" | "chatStart";

/** Per-customer limit, counted before any work. Answers 429 in the standard envelope. */
function limitCustomer(name: LimitedName, request: FastifyRequest, reply: { header(name: string, value: string): unknown }): void {
  const limit = CUSTOMER_RATE_LIMITS[name].identifier;
  if (identifierLimiter.hit(name, currentCustomer(request).id, limit)) return;
  reply.header("Retry-After", String(Math.ceil(limit.windowMs / 1000)));
  throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
}

export function registerCustomerChatRoutes(app: FastifyInstance) {
  const guard = requireCustomer();
  const route = (name: CustomerLimitName) => ({ ...ipLimit(name), preHandler: guard });
  type ConversationParams = { Params: { id: string } };

  app.get("/chat/suggested-questions", route("read"), async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(suggestedQuestions());
  });

  app.get("/conversations", route("read"), async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await listCustomerConversations(currentCustomer(request), request.query));
  });

  app.post("/conversations", route("chatStart"), async (request, reply) => {
    limitCustomer("chatStart", request, reply);
    limitCustomer("chatSend", request, reply);
    return reply.status(201).send(success(await startConversation(currentCustomer(request), request.body)));
  });

  app.get<ConversationParams>("/conversations/:id/messages", route("read"), async (request, reply) => {
    limitCustomer("read", request, reply);
    return success(await listCustomerMessages(currentCustomer(request), request.params.id, request.query));
  });

  app.post<ConversationParams>("/conversations/:id/messages", route("chatSend"), async (request, reply) => {
    limitCustomer("chatSend", request, reply);
    return reply.status(201).send(success(await sendCustomerMessage(currentCustomer(request), request.params.id, request.body)));
  });
}
