import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import { success } from "../lib/response.js";
import { getOrganizationName } from "../services/organization.service.js";

export function registerOrganizationRoutes(app: FastifyInstance) {
  app.get("/organization", { preHandler: authenticate() }, async (request) => {
    return success({ name: await getOrganizationName(currentUser(request).orgId) });
  });
}
