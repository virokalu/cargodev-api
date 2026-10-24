import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import { parseInput } from "../lib/parse.js";
import { success } from "../lib/response.js";
import {
  getAuctionHallVehicleReport,
  getCustomerVehicleReport,
  getDestinationVehicleReport,
  getFreightAgentVehicleReport,
} from "../services/reports.service.js";
import { reportTrackQuerySchema } from "../validation/report.schema.js";

export function registerReportRoutes(app: FastifyInstance) {
  app.get("/reports/by-customer", { preHandler: authenticate() }, async (request) => {
    const { track } = parseInput(reportTrackQuerySchema, request.query);
    return success(await getCustomerVehicleReport(currentUser(request).orgId, track));
  });

  app.get("/reports/by-auction-hall", { preHandler: authenticate() }, async (request) => {
    const { track } = parseInput(reportTrackQuerySchema, request.query);
    return success(await getAuctionHallVehicleReport(currentUser(request).orgId, track));
  });

  app.get("/reports/by-destination", { preHandler: authenticate() }, async (request) => {
    const { track } = parseInput(reportTrackQuerySchema, request.query);
    return success(await getDestinationVehicleReport(currentUser(request).orgId, track));
  });

  // Freight agents only ever apply to FC vehicles, so there is no track parameter.
  app.get("/reports/by-freight-agent", { preHandler: authenticate() }, async (request) =>
    success(await getFreightAgentVehicleReport(currentUser(request).orgId))
  );
}
