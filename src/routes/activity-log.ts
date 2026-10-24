import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import { parseInput } from "../lib/parse.js";
import { success } from "../lib/response.js";
import { listActivityLog, listActivityLogFilterOptions } from "../services/activity-log.service.js";
import { activityLogListQuerySchema } from "../validation/activity-log.schema.js";

const ADMIN_ONLY = ["ADMINISTRATOR"] as const;

export function registerActivityLogRoutes(app: FastifyInstance) {
  app.get("/activity-log", { preHandler: authenticate(ADMIN_ONLY) }, async (request) => {
    const params = parseInput(activityLogListQuerySchema, request.query);
    return success(await listActivityLog(currentUser(request).orgId, params));
  });

  app.get("/activity-log/filters", { preHandler: authenticate(ADMIN_ONLY) }, async (request) =>
    success(await listActivityLogFilterOptions(currentUser(request).orgId))
  );
}
