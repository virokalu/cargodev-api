// POST /api/v1/uploads/presign. Staff who may add files (ADMINISTRATOR, MANAGER, OPERATOR).

import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import { success } from "../lib/response.js";
import { createPresignedUpload } from "../services/upload.service.js";
import { CAN_QUICK_EDIT_VEHICLES } from "./vehicles.js";

export function registerUploadRoutes(app: FastifyInstance) {
  app.post("/uploads/presign", { preHandler: authenticate(CAN_QUICK_EDIT_VEHICLES), config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) =>
    success(await createPresignedUpload(currentUser(request), request.body))
  );
}
