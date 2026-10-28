// What customers may see, set by staff: release a vehicle, its photos and documents, and the customer-facing details.

import type { FastifyInstance } from "fastify";
import { CUSTOMER_ADMIN_ROLES, RELEASE_READINESS_ROLES } from "../config/roles.js";
import { authenticate, currentUser } from "../plugins/auth.js";
import { success } from "../lib/response.js";
import {
  getReleaseReadiness,
  setDocumentRelease,
  setPhotoRelease,
  setPhotosRelease,
  setVehicleCustomerInfo,
  setVehicleCustomerVisibility,
} from "../services/vehicle-release.service.js";

export function registerVehicleReleaseRoutes(app: FastifyInstance) {
  const admin = { preHandler: authenticate(CUSTOMER_ADMIN_ROLES) };
  type VehicleParams = { Params: { id: string } };

  // Read-only: how ready a vehicle is to be shown to its customer. Booleans and counts only.
  app.get<VehicleParams>("/vehicles/:id/release-readiness", { preHandler: authenticate(RELEASE_READINESS_ROLES) }, async (request) =>
    success(await getReleaseReadiness(currentUser(request), request.params.id))
  );

  app.patch<VehicleParams>("/vehicles/:id/customer-visibility", admin, async (request) =>
    success(await setVehicleCustomerVisibility(currentUser(request), request.params.id, request.body))
  );
  app.patch<VehicleParams>("/vehicles/:id/customer-info", admin, async (request) =>
    success(await setVehicleCustomerInfo(currentUser(request), request.params.id, request.body))
  );
  app.patch<{ Params: { id: string; docId: string } }>("/vehicles/:id/documents/:docId", admin, async (request) =>
    success(await setDocumentRelease(currentUser(request), request.params.id, request.params.docId, request.body))
  );
  app.patch<{ Params: { id: string; photoId: string } }>("/vehicles/:id/photos/:photoId", admin, async (request) =>
    success(await setPhotoRelease(currentUser(request), request.params.id, request.params.photoId, request.body))
  );
  app.patch<VehicleParams>("/vehicles/:id/photos", admin, async (request) =>
    success(await setPhotosRelease(currentUser(request), request.params.id, request.body))
  );
}
