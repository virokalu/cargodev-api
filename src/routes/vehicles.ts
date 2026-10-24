// Vehicle routes. Slice 1: read paths only. Mutations arrive in slices 2 and 3.
// File-related endpoints (/:serial/files, /:serial/pdf-images) are NOT here:
// file.service is not ported yet (it needs the object-storage SDK).

import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { success } from "../lib/response.js";
import {
  getVehicleDetail,
  getVehicleFilterOptions,
  listDistinctDestinations,
  listVehicles,
  listVehicleStatusHistory,
  resolveVehicleIdBySerial,
} from "../services/vehicle.service.js";
import { vehicleListQuerySchema } from "../validation/vehicle.schema.js";

// Fastify gives an array for a repeated query key and a string for a single one;
// the schema wants the first value for scalars and a list for `status`.
type RawQuery = Record<string, unknown>;
const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);
const all = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

const LIST_KEYS = [
  "page", "pageSize", "track", "q", "destination", "partner", "customer", "rowColour", "rowColourNot",
  "brand", "model", "grade", "hall", "supplier", "agent", "packingAgent", "location", "transport",
  "method", "billPaid", "logBook", "extraKey", "partnership", "paidByCustomer", "currency",
  "converted", "convertedLocal", "etdFrom", "etdTo", "etaFrom", "etaTo", "sort", "dir",
] as const;

function rawListQuery(query: RawQuery): RawQuery {
  const raw: RawQuery = { status: all(query["status"]) };
  for (const key of LIST_KEYS) raw[key] = first(query[key]);
  return raw;
}

export function registerVehicleRoutes(app: FastifyInstance) {
  const auth = { preHandler: authenticate() };

  app.get("/vehicles", auth, async (request) => {
    const params = parseInput(vehicleListQuerySchema, rawListQuery(request.query as RawQuery));
    return success(await listVehicles(currentUser(request).orgId, params));
  });

  app.get("/vehicles/filter-options", auth, async () => success(getVehicleFilterOptions()));

  app.get("/vehicles/destinations", auth, async (request) =>
    success(await listDistinctDestinations(currentUser(request).orgId))
  );

  app.get<{ Params: { serial: string } }>("/vehicles/:serial", auth, async (request) => {
    const vehicle = await getVehicleDetail(currentUser(request).orgId, request.params.serial);
    if (!vehicle) throw new ServiceError("NOT_FOUND", "Vehicle not found.");
    return success(vehicle);
  });

  app.get<{ Params: { serial: string } }>("/vehicles/:serial/status-history", auth, async (request) => {
    const { orgId } = currentUser(request);
    // Resolving the serial first gives the standard 404 for a missing, other-org or deleted vehicle.
    const vehicleId = await resolveVehicleIdBySerial(orgId, request.params.serial);
    return success(await listVehicleStatusHistory(orgId, vehicleId));
  });
}
