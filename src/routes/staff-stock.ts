// /api/v1/stock and /api/v1/enquiries: the staff side of the public website (curated stock, website enquiries).
// ADMINISTRATOR and MANAGER only. Every lookup is by id AND the token's org; another org's id is a 404.
// Registered only when PUBLIC_STOCK_ENABLED is true.

import type { FastifyInstance } from "fastify";
import { STOCK_ROLES } from "../config/roles.js";
import { success } from "../lib/response.js";
import { authenticate, currentUser } from "../plugins/auth.js";
import { listEnquiries, setEnquiryHandled } from "../services/enquiry.service.js";
import {
  addStockImage,
  createStock,
  deleteStock,
  deleteStockImage,
  getStaffStock,
  listStaffStock,
  markStockSold,
  presignStockUpload,
  publishStock,
  reorderStockImages,
  unpublishStock,
  updateStock,
  updateStockImage,
} from "../services/stock.service.js";

export function registerStaffStockRoutes(app: FastifyInstance) {
  const stock = { preHandler: authenticate(STOCK_ROLES) };
  type Params = { Params: { id: string } };
  type ImageParams = { Params: { id: string; imageId: string } };

  app.get("/stock", stock, async (request) => success(await listStaffStock(currentUser(request).orgId, request.query)));
  app.post("/stock", stock, async (request, reply) => reply.status(201).send(success(await createStock(currentUser(request), request.body))));
  app.get<Params>("/stock/:id", stock, async (request) => success(await getStaffStock(currentUser(request).orgId, request.params.id)));
  app.patch<Params>("/stock/:id", stock, async (request) => success(await updateStock(currentUser(request), request.params.id, request.body)));
  app.delete<Params>("/stock/:id", stock, async (request) => success(await deleteStock(currentUser(request), request.params.id)));

  app.post<Params>("/stock/:id/publish", stock, async (request) => success(await publishStock(currentUser(request), request.params.id, request.body)));
  app.post<Params>("/stock/:id/unpublish", stock, async (request) => success(await unpublishStock(currentUser(request), request.params.id, request.body)));
  app.post<Params>("/stock/:id/mark-sold", stock, async (request) => success(await markStockSold(currentUser(request), request.params.id, request.body)));

  app.post<Params>("/stock/:id/images/presign", stock, async (request) => success(await presignStockUpload(currentUser(request), request.params.id, request.body)));
  app.post<Params>("/stock/:id/images", stock, async (request, reply) => reply.status(201).send(success(await addStockImage(currentUser(request), request.params.id, request.body))));
  app.post<Params>("/stock/:id/images/reorder", stock, async (request) => success(await reorderStockImages(currentUser(request), request.params.id, request.body)));
  app.patch<ImageParams>("/stock/:id/images/:imageId", stock, async (request) =>
    success(await updateStockImage(currentUser(request), request.params.id, request.params.imageId, request.body))
  );
  app.delete<ImageParams>("/stock/:id/images/:imageId", stock, async (request) =>
    success(await deleteStockImage(currentUser(request), request.params.id, request.params.imageId))
  );

  app.get("/enquiries", stock, async (request) => success(await listEnquiries(currentUser(request).orgId, request.query)));
  app.post<Params>("/enquiries/:id/handled", stock, async (request) => success(await setEnquiryHandled(currentUser(request), request.params.id, request.body)));
}
