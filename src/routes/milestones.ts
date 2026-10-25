// Vehicle milestones (staff). Reads by serial, writes by id, like the rest of /vehicles.

import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import { success } from "../lib/response.js";
import { listMilestones, setMilestone, undoMilestone } from "../services/milestone.service.js";
import { resolveVehicleIdBySerial } from "../services/vehicle.service.js";
import { CAN_QUICK_EDIT_VEHICLES } from "./vehicles.js";

export function registerMilestoneRoutes(app: FastifyInstance) {
  type Params = { Params: { id: string; type: string } };

  app.get<{ Params: { serial: string } }>("/vehicles/:serial/milestones", { preHandler: authenticate() }, async (request) => {
    const { orgId } = currentUser(request);
    return success(await listMilestones(orgId, await resolveVehicleIdBySerial(orgId, request.params.serial)));
  });

  app.put<Params>("/vehicles/:id/milestones/:type", { preHandler: authenticate(CAN_QUICK_EDIT_VEHICLES) }, async (request) =>
    success(await setMilestone(currentUser(request), request.params.id, request.params.type, request.body))
  );

  app.delete<Params>("/vehicles/:id/milestones/:type", { preHandler: authenticate(CAN_QUICK_EDIT_VEHICLES) }, async (request) => {
    await undoMilestone(currentUser(request), request.params.id, request.params.type);
    return success({ deleted: true });
  });
}
