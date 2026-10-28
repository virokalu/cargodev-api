// Body schemas for vehicle file endpoints. These check SHAPE. Whether a URL is one of our own
// uploads for this org is checked in file.service (lib/object-storage.ts), because it needs config.

import { z } from "zod";
import { flattenFieldErrors } from "./shared.js";

export { flattenFieldErrors };

export const DOCUMENT_TYPES = [
  "LC",
  "EC",
  "ED",
  "BL",
  "INSPECTION_REPORT",
  "SHAKEN_SHO",
  "FREIGHT_INVOICE",
  "PURCHASE_INVOICE",
  "SALES_INVOICE",
  "MEGI_HENKO",
  "CASH_RECEIPT",
  "OTHER",
] as const;

const fileUrl = z.string("url is required").trim().min(1, "url is required").max(2000, "url is too long");

export const fileUrlBodySchema = z.object({ url: fileUrl });

export const documentBodySchema = z.object({
  url: fileUrl,
  name: z.string("name is required").trim().min(1, "name is required").max(255, "name must be 255 characters or fewer"),
  documentType: z.enum(DOCUMENT_TYPES, { error: "documentType is not valid" }),
});

export const photosAddedBodySchema = z.object({
  count: z.number("count must be a number").int().min(1, "count must be at least 1").max(500, "count is too large"),
});
