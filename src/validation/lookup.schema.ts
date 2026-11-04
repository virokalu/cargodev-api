// Query schemas for the /api/v1/lookups/* search endpoints.

import { z } from "zod";
import { flattenFieldErrors } from "./shared.js";

export { flattenFieldErrors };

// Optional filter-bar parameter: only FC or FL. "ALL", lower case, an empty value or anything else is a 400 with fieldErrors.track.
export const trackQueryParam = z.enum(["FC", "FL"], { error: "track must be FC or FL" }).optional();

export const trackOnlyQuerySchema = z.object({ track: trackQueryParam });

export const lookupSearchQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  track: trackQueryParam,
});

export const modelSearchQuerySchema = z.object({
  brandId: z.string().min(1, "brandId is required"),
  q: z.string().trim().max(200).default(""),
  track: trackQueryParam,
});

export const gradeSearchQuerySchema = z.object({
  modelId: z.string().min(1, "modelId is required"),
  q: z.string().trim().max(200).default(""),
  track: trackQueryParam,
});

export const freightAgentSearchQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  method: z.enum(["RORO", "CONTAINER"]).optional(),
  track: trackQueryParam,
});
