import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import { success } from "../lib/response.js";
import { getDashboardStats, getDashboardTrends } from "../services/dashboard.service.js";

export function registerDashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard/stats", { preHandler: authenticate() }, async (request) =>
    success(await getDashboardStats(currentUser(request).orgId))
  );

  app.get("/dashboard/trends", { preHandler: authenticate() }, async (request) =>
    success(await getDashboardTrends(currentUser(request).orgId))
  );
}
