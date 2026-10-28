// Bodies and queries for the customer alerts, preferences, devices and presence routes. Strict: an unknown field is a 400.

import { z } from "zod";
import { DEPARTURE_LEAD_DAYS, TOGGLEABLE_EVENTS } from "../config/customer-events.js";

export const alertListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Not a valid id");

export const markReadBodySchema = z.union([
  z.object({ ids: z.array(id).min(1, "Choose at least one alert").max(200) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

const eventToggles = z.object(Object.fromEntries(TOGGLEABLE_EVENTS.map((event) => [event, z.boolean().optional()]))).strict();

export const preferencesBodySchema = z
  .object({
    events: eventToggles.optional(),
    departureLeadDays: z.union(DEPARTURE_LEAD_DAYS.map((days) => z.literal(days)) as [z.ZodLiteral<3>, z.ZodLiteral<7>, z.ZodLiteral<14>]).optional(),
    pushEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
    // Stored only: WhatsApp is not sent.
    whatsappEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Change at least one setting");

export const deviceBodySchema = z
  .object({
    expoPushToken: z.string().trim().min(1, "expoPushToken is required").max(200),
    platform: z.enum(["ios", "android"]),
    appVersion: z.string().trim().min(1).max(32).optional(),
  })
  .strict();
