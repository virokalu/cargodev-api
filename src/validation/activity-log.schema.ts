// Query schema for GET /api/v1/activity-log (Administrator-only).

import { z } from "zod";
import { flattenFieldErrors } from "./shared.js";
import { paginationQuerySchema } from "./pagination.schema.js";

export { flattenFieldErrors };

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const optionalDate = z
  .string()
  .optional()
  .transform(emptyToUndefined)
  .transform((v) => (v === undefined ? undefined : new Date(v)))
  .refine((v) => v === undefined || !Number.isNaN(v.getTime()), { message: "Invalid date" });

export const activityLogListQuerySchema = z.object({
  ...paginationQuerySchema.shape,
  // entity is an exact (case-insensitive) match and action a partial,
  // case-insensitive one — see listActivityLog. Clients should take entity
  // values from GET /activity-log/filters rather than guessing the stored
  // string. entityId/actorId are exact: those are real ids, not search text.
  entity: z.string().trim().max(100).optional().transform(emptyToUndefined),
  entityId: z.string().trim().max(100).optional().transform(emptyToUndefined),
  actorId: z.string().trim().max(100).optional().transform(emptyToUndefined),
  action: z.string().trim().max(100).optional().transform(emptyToUndefined),
  dateFrom: optionalDate,
  dateTo: optionalDate,
});
