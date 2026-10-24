// Lookup endpoints. Reads are open to any staff role. Create (find-or-create:
// an existing name, matched case-insensitively, returns the existing row) and
// rename are limited to the same roles as the web app's lookup actions.

import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import type { SessionUser } from "../lib/session-user.js";
import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { success } from "../lib/response.js";
import * as lookups from "../services/lookup.service.js";
import {
  freightAgentBodySchema,
  gradeCreateBodySchema,
  lookupNameBodySchema,
  modelCreateBodySchema,
} from "../validation/lookup-write.schema.js";
import {
  freightAgentSearchQuerySchema,
  gradeSearchQuerySchema,
  lookupSearchQuerySchema,
  modelSearchQuerySchema,
} from "../validation/lookup.schema.js";

const CAN_WRITE_LOOKUPS = ["ADMINISTRATOR", "MANAGER"] as const;

interface SimpleLookup {
  path: string;
  label: string;
  search: (orgId: string, query: string) => Promise<unknown[]>;
  byId: (orgId: string, id: string) => Promise<unknown | null>;
  create: (actor: SessionUser, name: string) => Promise<unknown>;
  rename: (actor: SessionUser, id: string, name: string) => Promise<unknown>;
}

const SIMPLE_LOOKUPS: SimpleLookup[] = [
  {
    path: "brands",
    label: "Brand",
    search: lookups.searchBrands,
    byId: lookups.getBrandById,
    create: lookups.findOrCreateBrand,
    rename: lookups.renameBrand,
  },
  {
    path: "auction-halls",
    label: "Auction hall",
    search: lookups.searchAuctionHalls,
    byId: lookups.getAuctionHallById,
    create: lookups.findOrCreateAuctionHall,
    rename: lookups.renameAuctionHall,
  },
  {
    path: "suppliers",
    label: "Supplier",
    search: lookups.searchSuppliers,
    byId: lookups.getSupplierById,
    create: lookups.findOrCreateSupplier,
    rename: lookups.renameSupplier,
  },
  {
    path: "transport-companies",
    label: "Transport company",
    search: lookups.searchTransportCompanies,
    byId: lookups.getTransportCompanyById,
    create: lookups.findOrCreateTransportCompany,
    rename: lookups.renameTransportCompany,
  },
  {
    path: "inspection-companies",
    label: "Inspection company",
    search: lookups.searchInspectionCompanies,
    byId: lookups.getInspectionCompanyById,
    create: lookups.findOrCreateInspectionCompany,
    rename: lookups.renameInspectionCompany,
  },
  {
    path: "inspection-by",
    label: "Inspector",
    search: lookups.searchInspectionBy,
    byId: lookups.getInspectionByById,
    create: lookups.findOrCreateInspectionBy,
    rename: lookups.renameInspectionBy,
  },
  {
    path: "packing-agents",
    label: "Packing agent",
    search: lookups.searchPackingAgents,
    byId: lookups.getPackingAgentById,
    create: lookups.findOrCreatePackingAgent,
    rename: lookups.renamePackingAgent,
  },
  {
    path: "vehicle-locations",
    label: "Vehicle location",
    search: lookups.searchVehicleLocations,
    byId: lookups.getVehicleLocationById,
    create: lookups.findOrCreateVehicleLocation,
    rename: lookups.renameVehicleLocation,
  },
];

export function registerLookupRoutes(app: FastifyInstance) {
  const auth = { preHandler: authenticate() };
  const write = { preHandler: authenticate(CAN_WRITE_LOOKUPS) };

  for (const lookup of SIMPLE_LOOKUPS) {
    app.get(`/lookups/${lookup.path}`, auth, async (request) => {
      const { q } = parseInput(lookupSearchQuerySchema, request.query);
      return success(await lookup.search(currentUser(request).orgId, q));
    });

    app.get<{ Params: { id: string } }>(`/lookups/${lookup.path}/:id`, auth, async (request) => {
      const row = await lookup.byId(currentUser(request).orgId, request.params.id);
      if (!row) throw new ServiceError("NOT_FOUND", `${lookup.label} not found.`);
      return success(row);
    });

    app.post(`/lookups/${lookup.path}`, write, async (request) => {
      const { name } = parseInput(lookupNameBodySchema, request.body, "Invalid request body.");
      return success(await lookup.create(currentUser(request), name));
    });

    app.patch<{ Params: { id: string } }>(`/lookups/${lookup.path}/:id`, write, async (request) => {
      const { name } = parseInput(lookupNameBodySchema, request.body, "Invalid request body.");
      return success(await lookup.rename(currentUser(request), request.params.id, name));
    });
  }

  // Models belong to a brand, grades to a model.
  app.get("/lookups/models", auth, async (request) => {
    const { brandId, q } = parseInput(modelSearchQuerySchema, request.query);
    return success(await lookups.searchModels(currentUser(request).orgId, brandId, q));
  });
  app.get<{ Params: { id: string } }>("/lookups/models/:id", auth, async (request) => {
    const row = await lookups.getModelById(currentUser(request).orgId, request.params.id);
    if (!row) throw new ServiceError("NOT_FOUND", "Model not found.");
    return success(row);
  });

  app.post("/lookups/models", write, async (request) => {
    const { brandId, name } = parseInput(modelCreateBodySchema, request.body, "Invalid request body.");
    return success(await lookups.findOrCreateModel(currentUser(request), brandId, name));
  });
  app.patch<{ Params: { id: string } }>("/lookups/models/:id", write, async (request) => {
    const { name } = parseInput(lookupNameBodySchema, request.body, "Invalid request body.");
    return success(await lookups.renameModel(currentUser(request), request.params.id, name));
  });

  app.get("/lookups/grades", auth, async (request) => {
    const { modelId, q } = parseInput(gradeSearchQuerySchema, request.query);
    return success(await lookups.searchGrades(currentUser(request).orgId, modelId, q));
  });
  app.get<{ Params: { id: string } }>("/lookups/grades/:id", auth, async (request) => {
    const row = await lookups.getGradeById(currentUser(request).orgId, request.params.id);
    if (!row) throw new ServiceError("NOT_FOUND", "Grade not found.");
    return success(row);
  });

  app.post("/lookups/grades", write, async (request) => {
    const { modelId, name } = parseInput(gradeCreateBodySchema, request.body, "Invalid request body.");
    return success(await lookups.findOrCreateGrade(currentUser(request), modelId, name));
  });
  app.patch<{ Params: { id: string } }>("/lookups/grades/:id", write, async (request) => {
    const { name } = parseInput(lookupNameBodySchema, request.body, "Invalid request body.");
    return success(await lookups.renameGrade(currentUser(request), request.params.id, name));
  });

  app.post("/lookups/freight-agents", write, async (request) => {
    const body = parseInput(freightAgentBodySchema, request.body, "Invalid request body.");
    return success(await lookups.createFreightAgent(currentUser(request), body.name, body.offersRoro, body.offersContainer));
  });
  app.patch<{ Params: { id: string } }>("/lookups/freight-agents/:id", write, async (request) => {
    const body = parseInput(freightAgentBodySchema, request.body, "Invalid request body.");
    return success(
      await lookups.updateFreightAgent(currentUser(request), request.params.id, body.name, body.offersRoro, body.offersContainer)
    );
  });

  // Freight agents: full list, search with an optional shipping-method filter, and by id.
  app.get("/lookups/freight-agents", auth, async (request) =>
    success(await lookups.listFreightAgents(currentUser(request).orgId))
  );
  app.get("/lookups/freight-agents/search", auth, async (request) => {
    const { q, method } = parseInput(freightAgentSearchQuerySchema, request.query);
    return success(await lookups.searchFreightAgents(currentUser(request).orgId, q, method));
  });
  app.get<{ Params: { id: string } }>("/lookups/freight-agents/:id", auth, async (request) => {
    const row = await lookups.getFreightAgentById(currentUser(request).orgId, request.params.id);
    if (!row) throw new ServiceError("NOT_FOUND", "Freight agent not found.");
    return success(row);
  });

  app.get("/lookups/row-colour-statuses", auth, async (request) =>
    success(await lookups.listRowColourStatuses(currentUser(request).orgId))
  );
}
