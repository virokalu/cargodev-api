import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import { canSeeCustomerContact } from "../config/roles.js";
import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { success } from "../lib/response.js";
import {
  createCustomerFull,
  getCustomerById,
  listCustomers,
  searchCustomers,
  updateCustomer,
} from "../services/customer.service.js";
import { customerListQuerySchema, customerSearchQuerySchema } from "../validation/customer.schema.js";

// Same allow-list as the web app's customer Server Actions.
const CAN_MANAGE_CUSTOMERS = ["ADMINISTRATOR", "MANAGER"] as const;

export function registerCustomerRoutes(app: FastifyInstance) {
  app.get("/customers", { preHandler: authenticate() }, async (request) => {
    const { q } = parseInput(customerListQuerySchema, request.query);
    const user = currentUser(request);
    // A VIEWER gets names, country and counts only (no email, phone or address), and cannot search by them.
    return success(await listCustomers(user.orgId, q, canSeeCustomerContact(user.role)));
  });

  app.get("/customers/search", { preHandler: authenticate() }, async (request) => {
    const { q } = parseInput(customerSearchQuerySchema, request.query);
    return success(await searchCustomers(currentUser(request).orgId, q));
  });

  app.get<{ Params: { id: string } }>("/customers/:id", { preHandler: authenticate() }, async (request) => {
    const customer = await getCustomerById(currentUser(request).orgId, request.params.id);
    if (!customer) throw new ServiceError("NOT_FOUND", "Customer not found.");
    return success(customer);
  });

  app.post("/customers", { preHandler: authenticate(CAN_MANAGE_CUSTOMERS) }, async (request, reply) => {
    const created = await createCustomerFull(currentUser(request), request.body);
    return reply.status(201).send(success(created));
  });

  app.patch<{ Params: { id: string } }>(
    "/customers/:id",
    { preHandler: authenticate(CAN_MANAGE_CUSTOMERS) },
    async (request) => success(await updateCustomer(currentUser(request), request.params.id, request.body))
  );
}
