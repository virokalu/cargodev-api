// Query and body schemas for the customer read API. Strict: an unknown parameter is a 400, so a client can never
// slip in an org id, a customer id or a column name.

import { z } from "zod";

export const CUSTOMER_STATUSES = ["PENDING", "BOOKING_RECEIVED", "SHIPPED", "ARRIVED", "DELIVERED"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

const page = z.coerce.number().int().min(1).max(100000).default(1);
const pageSize = z.coerce.number().int().min(1).max(50).default(20);

export const customerVehicleListQuerySchema = z
  .object({
    page,
    pageSize,
    status: z.enum(CUSTOMER_STATUSES).optional(),
    brand: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(["arrival", "purchaseDate"]).default("purchaseDate"),
    dir: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();
export type CustomerVehicleListQuery = z.infer<typeof customerVehicleListQuerySchema>;

export const customerDocumentListQuerySchema = z
  .object({
    page,
    pageSize,
    vehicleId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  })
  .strict();

export const noQuerySchema = z.object({}).strict();

// A serial as staff print it: FC or FL and the number. Normalised to upper case.
export const linkRequestBodySchema = z
  .object({
    serial: z
      .string("serial is required")
      .trim()
      .toUpperCase()
      .regex(/^(FC|FL)\d{1,9}$/, "Enter a serial number such as FC1024"),
  })
  .strict();
