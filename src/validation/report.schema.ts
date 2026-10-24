// Query schema for the /api/v1/reports/* endpoints that take a track param.
// ReportTrack = SerialPrefix ("FC" | "FL") — there's no "ALL" option, unlike
// the vehicle list filter.

import { z } from "zod";
import { flattenFieldErrors } from "./shared.js";

export { flattenFieldErrors };

export const reportTrackQuerySchema = z.object({
  track: z.enum(["FC", "FL"]).default("FC"),
});
