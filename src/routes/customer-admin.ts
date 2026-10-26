// Staff tools for customers: sign-in access, assigned agent, who is online, link requests, FAQs.
// Every route is org-scoped by the token; the role lists come from src/config/roles.ts.

import type { FastifyInstance } from "fastify";
import { CUSTOMER_ADMIN_ROLES, LINK_REQUEST_DECIDERS } from "../config/roles.js";
import { authenticate, currentUser } from "../plugins/auth.js";
import { success } from "../lib/response.js";
import { listActiveCustomers, setCustomerAgent, setCustomerLoginAccess } from "../services/customer-admin.service.js";
import { createFaq, deleteFaq, listStaffFaqs, updateFaq } from "../services/faq.service.js";
import { approveLinkRequest, listLinkRequests, rejectLinkRequest } from "../services/link-request-admin.service.js";

export function registerCustomerAdminRoutes(app: FastifyInstance) {
  const admin = { preHandler: authenticate(CUSTOMER_ADMIN_ROLES) };
  const decider = { preHandler: authenticate(LINK_REQUEST_DECIDERS) };
  type IdParams = { Params: { id: string } };

  app.patch<IdParams>("/customers/:id/login-access", admin, async (request) =>
    success(await setCustomerLoginAccess(currentUser(request), request.params.id, request.body))
  );
  app.patch<IdParams>("/customers/:id/agent", admin, async (request) =>
    success(await setCustomerAgent(currentUser(request), request.params.id, request.body))
  );
  app.get("/staff/customers/active", admin, async (request) => success(await listActiveCustomers(currentUser(request).orgId)));

  app.get("/link-requests", decider, async (request) => success(await listLinkRequests(currentUser(request).orgId, request.query)));
  app.post<IdParams>("/link-requests/:id/approve", decider, async (request) =>
    success(await approveLinkRequest(currentUser(request), request.params.id, request.body))
  );
  app.post<IdParams>("/link-requests/:id/reject", decider, async (request) =>
    success(await rejectLinkRequest(currentUser(request), request.params.id, request.body))
  );

  app.get("/faqs", admin, async (request) => success(await listStaffFaqs(currentUser(request).orgId)));
  app.post("/faqs", admin, async (request, reply) => reply.status(201).send(success(await createFaq(currentUser(request), request.body))));
  app.patch<IdParams>("/faqs/:id", admin, async (request) => success(await updateFaq(currentUser(request), request.params.id, request.body)));
  app.delete<IdParams>("/faqs/:id", admin, async (request) => {
    await deleteFaq(currentUser(request), request.params.id);
    return success({ deleted: true });
  });
}
