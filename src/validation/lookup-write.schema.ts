// Body schemas for the lookup create/rename endpoints. These check the SHAPE
// only; the name's content (trim, 1-150 chars) is validated in lookup.service.

import { z } from "zod";

const name = z.string("name is required");

export const lookupNameBodySchema = z.object({ name });

export const modelCreateBodySchema = z.object({
  brandId: z.string("brandId is required").min(1, "brandId is required"),
  name,
});

export const gradeCreateBodySchema = z.object({
  modelId: z.string("modelId is required").min(1, "modelId is required"),
  name,
});

export const freightAgentBodySchema = z.object({
  name,
  offersRoro: z.boolean("offersRoro must be true or false"),
  offersContainer: z.boolean("offersContainer must be true or false"),
});
