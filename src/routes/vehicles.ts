// Vehicle routes: reads (any staff) and writes (role allow-lists below, enforced per route).
// Reads address a vehicle by serial; writes by id, as in the original app.

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
import {
  addVehicleDocument,
  addVehiclePhoto,
  deleteVehicleDocument,
  deleteVehiclePhoto,
  getVehiclePdfImages,
  listVehicleFiles,
  notifyPhotosAdded,
  setAuctionSheet,
} from "../services/file.service.js";
import { previewNextSerial } from "../services/serial.service.js";
import type { StaffRole } from "@prisma/client";
import {
  auctionBillPaidBodySchema,
  checkChassisQuerySchema,
  convertToExportBodySchema,
  nextSerialQuerySchema,
  rowColourBodySchema,
  serialCorrectionBodySchema,
  vehicleListQuerySchema,
} from "../validation/vehicle.schema.js";
import {
  convertVehicleToExport,
  convertVehicleToLocal,
  correctVehicleSerialNumber,
  createVehicle,
  deleteVehicle,
  hasDuplicateChassisNo,
  revertVehicleToExport,
  revertVehicleToLocal,
  updateVehicle,
  updateVehicleAuctionBillPaid,
  updateVehicleRowColourStatus,
} from "../services/vehicle.service.js";

// Mirrors the original per-action allow-lists. VIEWER never writes.
export const CAN_MANAGE_VEHICLES: readonly StaffRole[] = ["ADMINISTRATOR", "MANAGER"];
export const CAN_QUICK_EDIT_VEHICLES: readonly StaffRole[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR"];
export const CAN_CORRECT_SERIAL: readonly StaffRole[] = ["ADMINISTRATOR"];

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

  const manage = { preHandler: authenticate(CAN_MANAGE_VEHICLES) };
  const quickEdit = { preHandler: authenticate(CAN_QUICK_EDIT_VEHICLES) };
  type IdParams = { Params: { id: string } };

  app.post("/vehicles", manage, async (request, reply) =>
    reply.status(201).send(success(await createVehicle(currentUser(request), request.body)))
  );

  // Full replace (PUT), not a partial patch: omitted optional fields are cleared.
  app.put<IdParams>("/vehicles/:id", manage, async (request) =>
    success(await updateVehicle(currentUser(request), request.params.id, request.body))
  );

  app.delete<IdParams>("/vehicles/:id", manage, async (request) => {
    const user = currentUser(request);
    await deleteVehicle(user.orgId, user.id, request.params.id);
    return success({ deleted: true });
  });

  app.patch<IdParams>("/vehicles/:id/row-colour", quickEdit, async (request) => {
    const user = currentUser(request);
    const { rowColourStatusId } = parseInput(rowColourBodySchema, request.body, "Invalid request body.");
    await updateVehicleRowColourStatus(user.orgId, user.id, request.params.id, rowColourStatusId);
    return success({ rowColourStatusId });
  });

  app.patch<IdParams>("/vehicles/:id/auction-bill-paid", quickEdit, async (request) => {
    const user = currentUser(request);
    const { auctionBillPaid } = parseInput(auctionBillPaidBodySchema, request.body, "Invalid request body.");
    await updateVehicleAuctionBillPaid(user.orgId, user.id, request.params.id, auctionBillPaid);
    return success({ auctionBillPaid });
  });

  app.post<IdParams>("/vehicles/:id/convert-to-export", manage, async (request) => {
    const user = currentUser(request);
    const { destination } = parseInput(convertToExportBodySchema, request.body, "Invalid request body.");
    await convertVehicleToExport(user.orgId, user.id, request.params.id, destination);
    return success({ converted: true });
  });

  const transitions = [
    ["revert-to-local", revertVehicleToLocal],
    ["convert-to-local", convertVehicleToLocal],
    ["revert-to-export", revertVehicleToExport],
  ] as const;
  for (const [path, run] of transitions) {
    app.post<IdParams>(`/vehicles/:id/${path}`, manage, async (request) => {
      const user = currentUser(request);
      await run(user.orgId, user.id, request.params.id);
      return success({ ok: true });
    });
  }

  app.patch<IdParams>("/vehicles/:id/serial", { preHandler: authenticate(CAN_CORRECT_SERIAL) }, async (request) => {
    const user = currentUser(request);
    const { serialNumber } = parseInput(serialCorrectionBodySchema, request.body, "Invalid request body.");
    return success(await correctVehicleSerialNumber(user.orgId, user.id, request.params.id, serialNumber));
  });

  app.get("/vehicles/check-chassis", auth, async (request) => {
    const { chassisNo, excludeId } = parseInput(checkChassisQuerySchema, request.query);
    const duplicate = await hasDuplicateChassisNo(currentUser(request).orgId, chassisNo, excludeId);
    return success({ duplicate });
  });

  app.get("/vehicles/next-serial", auth, async (request) => {
    const { track } = parseInput(nextSerialQuerySchema, request.query);
    return success({ serial: await previewNextSerial(currentUser(request).orgId, track) });
  });

  // Files. Reads are by serial; writes by id.
  app.get<{ Params: { serial: string } }>("/vehicles/:serial/files", auth, async (request) => {
    const { orgId } = currentUser(request);
    return success(await listVehicleFiles(orgId, await resolveVehicleIdBySerial(orgId, request.params.serial)));
  });

  app.get<{ Params: { serial: string } }>("/vehicles/:serial/pdf-images", auth, async (request) => {
    const { orgId } = currentUser(request);
    return success(await getVehiclePdfImages(orgId, await resolveVehicleIdBySerial(orgId, request.params.serial)));
  });

  app.post<IdParams>("/vehicles/:id/photos", quickEdit, async (request, reply) =>
    reply.status(201).send(success(await addVehiclePhoto(currentUser(request), request.params.id, request.body)))
  );

  app.post<IdParams>("/vehicles/:id/photos-added", quickEdit, async (request) => {
    await notifyPhotosAdded(currentUser(request), request.params.id, request.body);
    return success({ ok: true });
  });

  app.post<IdParams>("/vehicles/:id/documents", quickEdit, async (request, reply) =>
    reply.status(201).send(success(await addVehicleDocument(currentUser(request), request.params.id, request.body)))
  );

  app.put<IdParams>("/vehicles/:id/auction-sheet", quickEdit, async (request) =>
    success(await setAuctionSheet(currentUser(request), request.params.id, request.body))
  );

  app.delete<{ Params: { id: string; photoId: string } }>("/vehicles/:id/photos/:photoId", manage, async (request) => {
    await deleteVehiclePhoto(currentUser(request), request.params.id, request.params.photoId);
    return success({ deleted: true });
  });

  app.delete<{ Params: { id: string; docId: string } }>("/vehicles/:id/documents/:docId", manage, async (request) => {
    await deleteVehicleDocument(currentUser(request), request.params.id, request.params.docId);
    return success({ deleted: true });
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
