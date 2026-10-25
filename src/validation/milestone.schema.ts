import { z } from "zod";

export const MILESTONE_TYPES = [
  "BOUGHT",
  "AUCTION_BILL_PAID",
  "AT_EXPORT_YARD",
  "EXPORT_CERT_ISSUED",
  "BOOKING_RECEIVED",
  "SHIPPED",
  "BL_ISSUED",
  "ARRIVED",
  "DELIVERED",
] as const;

export const milestoneTypeSchema = z.enum(MILESTONE_TYPES, "Unknown milestone");

// A date or a full timestamp. Not further in the future than tomorrow (time zones), and not absurdly old.
export const milestoneBodySchema = z
  .object({
    occurredAt: z
      .string()
      .trim()
      .refine((v) => !Number.isNaN(new Date(v).getTime()), "Enter a valid date")
      .transform((v) => new Date(v))
      .refine((d) => d.getTime() <= Date.now() + 24 * 60 * 60 * 1000, "The date cannot be in the future")
      .refine((d) => d.getUTCFullYear() >= 2000, "Enter a valid date")
      .optional(),
  })
  .strict();
