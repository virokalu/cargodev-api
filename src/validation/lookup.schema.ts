// Query schemas for the /api/v1/lookups/* search endpoints.

import { z } from "zod";
import { flattenFieldErrors } from "./shared.js";

export { flattenFieldErrors };

export const lookupSearchQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
});

export const modelSearchQuerySchema = z.object({
  brandId: z.string().min(1, "brandId is required"),
  q: z.string().trim().max(200).default(""),
});

export const gradeSearchQuerySchema = z.object({
  modelId: z.string().min(1, "modelId is required"),
  q: z.string().trim().max(200).default(""),
});

export const freightAgentSearchQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  method: z.enum(["RORO", "CONTAINER"]).optional(),
});
