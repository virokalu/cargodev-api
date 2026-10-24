// Query schema for GET /api/v1/notifications — real page/pageSize
// pagination (same shape as vehicles/activity-log), not the old flat
// `limit` cap that made anything past the first batch unreachable.

import { paginationQuerySchema } from "./pagination.schema.js";
import { flattenFieldErrors } from "./shared.js";

export { flattenFieldErrors };

export const notificationListQuerySchema = paginationQuerySchema;
