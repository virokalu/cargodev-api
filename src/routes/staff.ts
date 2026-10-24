import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, currentUser } from "../plugins/auth.js";
import { parseInput } from "../lib/parse.js";
import { success } from "../lib/response.js";
import { createStaff, listStaff, setStaffActive, updateStaff } from "../services/user.service.js";
import { staffListQuerySchema } from "../validation/user.schema.js";

const CAN_READ_STAFF = ["ADMINISTRATOR", "MANAGER"] as const;
const ADMIN_ONLY = ["ADMINISTRATOR"] as const;

const staffActiveBodySchema = z.object({ active: z.boolean("active must be true or false") });

export function registerStaffRoutes(app: FastifyInstance) {
  app.get("/staff", { preHandler: authenticate(CAN_READ_STAFF) }, async (request) => {
    const { q } = parseInput(staffListQuerySchema, request.query);
    return success(await listStaff(currentUser(request), q));
  });

  app.post("/staff", { preHandler: authenticate(ADMIN_ONLY) }, async (request, reply) => {
    const created = await createStaff(currentUser(request), request.body);
    return reply.status(201).send(success(created));
  });

  app.patch<{ Params: { id: string } }>("/staff/:id", { preHandler: authenticate(ADMIN_ONLY) }, async (request) =>
    success(await updateStaff(currentUser(request), request.params.id, request.body))
  );

  app.post<{ Params: { id: string } }>("/staff/:id/active", { preHandler: authenticate(ADMIN_ONLY) }, async (request) => {
    const { active } = parseInput(staffActiveBodySchema, request.body, "Invalid request body.");
    return success(await setStaffActive(currentUser(request), request.params.id, active));
  });
}
