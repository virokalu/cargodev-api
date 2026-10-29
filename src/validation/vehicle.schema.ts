// Zod schema for vehicle creation — shape-level validation only.
//
// WHY shape-level only: this schema checks that fields are the right type and
// present when required. Rules that depend on the database (freight agent
// capabilities, FL fields being stripped, chassis duplicate warnings, customer
// must be userType CUSTOMER) can't be expressed here — they live in
// vehicle.service.ts, which has a Prisma client to check against.
//
// The client always sends date fields as "YYYY-MM-DD" strings (or null) since
// that's what a native <input type="date"> produces — optionalDate below
// turns that into a Date | null for Prisma.

import { z } from "zod";
import type { ShippingMethod } from "@prisma/client";
import { flattenFieldErrors } from "./shared.js";
import type { ShipmentStatus } from "../lib/constants/shipment-status.js";
// Type-only imports — erased at compile time, so this doesn't create a real
// runtime circular dependency even though vehicle.service.ts also imports
// from this file (for vehicleCreateSchema/vehicleUpdateSchema).
import type {
  VehicleListSortKey,
  TriStateFilterValue,
  TwoStateFilterValue,
} from "../services/vehicle.service.js";
import {
  SORT_KEYS,
  SHIPMENT_STATUSES,
  SHIPPING_METHODS,
  TRI_STATE_VALUES,
  TWO_STATE_VALUES,
} from "../lib/vehicle-list-url.js";
import { paginationQuerySchema } from "./pagination.schema.js";

export { flattenFieldErrors };

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const optionalText = (maxLength: number) =>
  z
    .string()
    .nullable()
    .optional()
    .transform(emptyToNull)
    .refine((v) => v === null || v.length <= maxLength, {
      message: `Must be ${maxLength} characters or fewer`,
    });

const optionalId = z.string().nullable().optional().transform(emptyToNull);

const optionalDate = z
  .string()
  .nullable()
  .optional()
  .transform(emptyToNull)
  .transform((v) => (v === null ? null : new Date(v)))
  .refine((v) => v === null || !Number.isNaN(v.getTime()), {
    message: "Invalid date",
  });

// Tri-state flags: null = not entered, true = Yes, false = No.
// Never coerce a missing/undefined value to false — that's the whole point
// of these being nullable (see CLAUDE.md "Tri-state flags").
const triState = z
  .boolean()
  .nullable()
  .optional()
  .transform((v) => v ?? null);

// Fields shared by create and edit — everything except serial/track (fixed at
// creation) and the legacy-entry-only fields (legacySerialNumber, the manual
// shipmentStatus override). Defined once so the two schemas below can't drift.
const vehicleSharedFields = {
  auctionItemNo: optionalText(100),
  chassisNo: z
    .string()
    .trim()
    .min(1, "Chassis number is required")
    .max(100, "Must be 100 characters or fewer"),

  brandId: z.string().min(1, "Make is required"),
  modelId: z.string().min(1, "Model is required"),
  gradeId: optionalId,

  yom: z
    .number()
    .int()
    .min(1980, "Enter a valid year")
    .max(new Date().getFullYear() + 1, "Enter a valid year")
    .nullable()
    .optional(),
  // FL only — mutually exclusive (checkSharedVehicleRules below), which
  // source this vehicle was purchased through.
  auctionHallId: optionalId,
  supplierId: optionalId,
  purchaseDate: optionalDate,
  auctionLotNo: optionalText(100),
  customerId: optionalId,
  destination: optionalText(100),

  // FL only. hasPartnership is a plain boolean (not tri-state — whoever
  // enters the vehicle always knows whether there was a partner), defaults
  // false to match the DB column. partnerName only means something when
  // hasPartnership is true (checkSharedVehicleRules below).
  hasPartnership: z.boolean().optional().default(false),
  partnerName: optionalText(200),

  // Shipment fields — FC only. Present in the schema so FC submissions
  // validate them, but vehicle.service strips them to null for FL regardless
  // of what's posted (never trust the client to have actually hidden them).
  etd: optionalDate,
  eta: optionalDate,
  blNo: optionalText(100),
  vesselName: optionalText(100),
  freightAgentId: optionalId,
  shippingMethod: z.enum(["RORO", "CONTAINER"]).nullable().optional(),
  // Only meaningful when shippingMethod = CONTAINER — vehicle.service nulls
  // it out otherwise, same treatment as the other FC-only shipping fields.
  packingAgentId: optionalId,
  vanningDate: optionalDate,
  containerNumber: optionalText(100),

  // FC only — plain boolean like hasPartnership below (not tri-state).
  // inspectionDate/inspectionCompanyId/inspectionById only mean something
  // when true; vehicle.service nulls them out otherwise.
  hasInspection: z.boolean().optional().default(false),
  inspectionDate: optionalDate,
  inspectionCompanyId: optionalId,
  inspectionById: optionalId,

  transportById: optionalId,
  vehicleLocationId: optionalId,
  massoDate: optionalDate,
  trackingNumber: optionalText(100),
  lcNo: optionalText(100),
  docsArrivedDate: optionalDate,

  auctionBillPaid: triState,
  logBook: triState,
  extraKey: triState,
  nameChangeDeadline: optionalDate,
  rowColourStatusId: optionalId,
  docSentDate: optionalDate,
  docSentComment: optionalText(500),
  recycleDate: optionalDate,
  jibaishake: optionalText(500),
  vehicleRemark: optionalText(2000),

  // Sold Details — FL only.
  deliveryDate: optionalDate,
  // Same nullable-boolean shape as triState above — null means "not
  // touched yet", not a third UI state (the form always writes true/false
  // once staff check/uncheck it; see CLAUDE.md-style tri-state reasoning,
  // just applied to a plain Yes/No checkbox here instead of a —/Yes/No
  // control).
  paidByCustomer: triState,
  sellingPrice: z
    .number()
    .nonnegative("Must be zero or more")
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  sellingPriceCurrency: optionalText(10),
};

/** Cross-field rules shared by create and edit. */
function checkSharedVehicleRules(
  data: {
    shippingMethod?: "RORO" | "CONTAINER" | null | undefined;
    freightAgentId?: string | null | undefined;
    packingAgentId?: string | null | undefined;
    etd?: Date | null | undefined;
    eta?: Date | null | undefined;
    auctionHallId?: string | null | undefined;
    supplierId?: string | null | undefined;
    hasPartnership?: boolean | undefined;
    partnerName?: string | null | undefined;
  },
  ctx: z.RefinementCtx
) {
  if (data.shippingMethod && !data.freightAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["freightAgentId"],
      message: "Select a forwarding agent before choosing RORO/Container",
    });
  }
  if (data.shippingMethod === "CONTAINER" && !data.packingAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["packingAgentId"],
      message: "Select a packing agent for Container shipments",
    });
  }
  if (data.etd && data.eta && data.eta.getTime() <= data.etd.getTime()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eta"],
      message: "ETA must be after ETD",
    });
  }
  if (data.auctionHallId && data.supplierId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supplierId"],
      message: "Choose either an auction hall or a supplier, not both",
    });
  }
  if (data.hasPartnership && !data.partnerName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["partnerName"],
      message: "Enter the partnership name",
    });
  }
}

export const vehicleCreateSchema = z
  .object({
    track: z.enum(["FC", "FL"]),
    isLegacyEntry: z.boolean(),
    legacySerialNumber: z.number().int().positive().nullable().optional(),
    // Only honoured by the service when isLegacyEntry && track === "FC" —
    // otherwise status stays derived from ETD (Tech Doc §1).
    shipmentStatus: z.enum(["PENDING", "BOOKING_RECEIVED", "SHIPPED"]).nullable().optional(),
    // Create-only, like the fields above — staged during Add Vehicle via the
    // presigned-upload flow, submitted with the rest of the create payload.
    // Deliberately NOT in vehicleSharedFields: editing the auction sheet
    // happens exclusively through the Files panel's immediate-persist action,
    // never through this form's update payload (see vehicle-form.tsx).
    auctionSheetKey: optionalText(1024),
    // Same create-only staging treatment as auctionSheetUrl above — Photos
    // and Documents added after creation go exclusively through the Files
    // panel's immediate-persist actions instead.
    photoKeys: z.array(z.string().max(1024)).max(50).optional().default([]),
    documents: z
      .array(
        z.object({
          key: z.string().max(1024),
          name: z.string().min(1).max(255),
          documentType: z.enum([
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
          ]),
        })
      )
      .max(50)
      .optional()
      .default([]),

    ...vehicleSharedFields,
  })
  .superRefine((data, ctx) => {
    if (data.isLegacyEntry && !data.legacySerialNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["legacySerialNumber"],
        message: "Enter the legacy serial number",
      });
    }
    checkSharedVehicleRules(data, ctx);
  });

export type VehicleCreateInput = z.infer<typeof vehicleCreateSchema>;

// Edit: no track/serial (read-only after creation, Tech Doc §3) and no manual
// shipmentStatus (that override is a creation-time-only exception — see
// vehicle.service.ts createVehicle/updateVehicle comments).
export const vehicleUpdateSchema = z.object(vehicleSharedFields).superRefine(checkSharedVehicleRules);

export type VehicleUpdateInput = z.infer<typeof vehicleUpdateSchema>;

// ── GET /api/v1/vehicles query params ──────────────────────────────
// Mirrors VehicleListParams (lib/services/vehicle.service.ts) and the same
// URL param names lib/vehicle-list-url.ts uses for the web filter bar — a
// mobile client sends the same query string shape. Unlike the web page's
// parser (which silently falls back to defaults on a bad value, since a
// stale bookmark shouldn't error), invalid enum values here are rejected
// with a 400: this is a machine-consumed API, so a bad filter value is a
// client bug worth surfacing, not something to swallow silently.
//
// One deliberate divergence from the web app: pageSize is client-
// controlled here (the web UI always uses a fixed 50), since a mobile
// client reasonably wants its own page size.

const idOrAll = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : "ALL"));

const shipmentStatusEnum = z.enum(SHIPMENT_STATUSES as [ShipmentStatus, ...ShipmentStatus[]]);
const sortKeyEnum = z.enum(SORT_KEYS as [VehicleListSortKey, ...VehicleListSortKey[]]);
const shippingMethodOrAllEnum = z.enum(
  [...SHIPPING_METHODS, "ALL"] as unknown as [ShippingMethod | "ALL", ...(ShippingMethod | "ALL")[]]
);
const triStateOrAllEnum = z.enum(["ALL", ...TRI_STATE_VALUES] as [
  TriStateFilterValue,
  ...TriStateFilterValue[],
]);
const twoStateOrAllEnum = z.enum(["ALL", ...TWO_STATE_VALUES] as [
  TwoStateFilterValue,
  ...TwoStateFilterValue[],
]);

export const vehicleListQuerySchema = z
  .object({
    ...paginationQuerySchema.shape,
    track: z.enum(["FC", "FL", "ALL"]).default("FC"),
    q: z.string().trim().max(200).default(""),
    status: z.array(shipmentStatusEnum).default([]),
    destination: idOrAll,
    partner: idOrAll,
    customer: idOrAll,
    rowColour: idOrAll,
    rowColourNot: idOrAll,
    brand: idOrAll,
    model: idOrAll,
    grade: idOrAll,
    hall: idOrAll,
    supplier: idOrAll,
    agent: idOrAll,
    packingAgent: idOrAll,
    location: idOrAll,
    transport: idOrAll,
    method: shippingMethodOrAllEnum.default("ALL"),
    billPaid: triStateOrAllEnum.default("ALL"),
    logBook: triStateOrAllEnum.default("ALL"),
    extraKey: triStateOrAllEnum.default("ALL"),
    partnership: twoStateOrAllEnum.default("ALL"),
    paidByCustomer: triStateOrAllEnum.default("ALL"),
    currency: idOrAll,
    converted: twoStateOrAllEnum.default("ALL"),
    convertedLocal: twoStateOrAllEnum.default("ALL"),
    // Inclusive date-range bounds on etd/eta — reuses the same optionalDate
    // parser vehicleSharedFields uses for mutation bodies ("YYYY-MM-DD"
    // string -> Date, undefined/empty -> null). No web filter-bar control
    // sets these yet (see VEHICLE_LIST_DEFAULTS in lib/vehicle-list-url.ts)
    // — mobile-only for now.
    etdFrom: optionalDate,
    etdTo: optionalDate,
    etaFrom: optionalDate,
    etaTo: optionalDate,
    sort: sortKeyEnum.default("serial"),
    dir: z.enum(["asc", "desc"]).default("desc"),
  })
  .transform((v) => ({
    page: v.page,
    pageSize: v.pageSize,
    track: v.track,
    search: v.q,
    shipmentStatus: v.status,
    destination: v.destination,
    partnerName: v.partner,
    customerId: v.customer,
    rowColourStatusId: v.rowColour,
    rowColourStatusIdNot: v.rowColourNot,
    brandId: v.brand,
    modelId: v.model,
    gradeId: v.grade,
    auctionHallId: v.hall,
    supplierId: v.supplier,
    freightAgentId: v.agent,
    packingAgentId: v.packingAgent,
    vehicleLocationId: v.location,
    transportById: v.transport,
    shippingMethod: v.method,
    auctionBillPaid: v.billPaid,
    logBook: v.logBook,
    extraKey: v.extraKey,
    hasPartnership: v.partnership,
    paidByCustomer: v.paidByCustomer,
    sellingPriceCurrency: v.currency,
    convertedToExport: v.converted,
    convertedToLocal: v.convertedLocal,
    etdFrom: v.etdFrom,
    etdTo: v.etdTo,
    etaFrom: v.etaFrom,
    etaTo: v.etaTo,
    sortBy: v.sort,
    sortDir: v.dir,
  }));

export type VehicleListQuery = z.infer<typeof vehicleListQuerySchema>;

// ---------------------------------------------------------------------------
// Small action bodies / queries for the vehicle write endpoints.
// ---------------------------------------------------------------------------

export const rowColourBodySchema = z.object({
  rowColourStatusId: z.string("rowColourStatusId must be a string or null").min(1).nullable(),
});

// null is a real value ("not entered"), so the field must be present: omitting it is an error, not a null.
export const auctionBillPaidBodySchema = z.object({
  auctionBillPaid: z.boolean("auctionBillPaid must be true, false or null").nullable(),
});

export const convertToExportBodySchema = z.object({
  destination: z.string("destination is required").trim().min(1, "destination is required").max(200),
});

export const serialCorrectionBodySchema = z.object({
  serialNumber: z
    .number("serialNumber must be a number")
    .int("serialNumber must be a whole number")
    .positive("serialNumber must be positive")
    .max(999_999_999),
});

export const checkChassisQuerySchema = z.object({
  chassisNo: z.string("chassisNo is required").trim().min(1, "chassisNo is required").max(100),
  excludeId: z.string().min(1).optional(),
});

export const nextSerialQuerySchema = z.object({
  track: z.enum(["FC", "FL"], "track must be FC or FL"),
});
