// Queries and bodies for the public stock API, the enquiry form and the staff stock tools. Strict: an unknown field
// is a 400. Public inputs are tiny and bounded.

import { z } from "zod";
import { MAX_IMAGES_PER_STOCK, MAX_STOCK_IMAGE_BYTES, MAX_STOCK_PRICE, PUBLIC_DEFAULT_PAGE_SIZE, PUBLIC_MAX_PAGE_SIZE, STOCK_IMAGE_TYPES } from "../config/public-stock.js";
import { plainText } from "./chat.schema.js";

const id = z.string("an id is required").regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug").max(120);

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

// ---------------------------------------------------------------------------------------------
// Public stock

export const PUBLIC_SORTS = ["newest", "priceAsc", "priceDesc", "yearDesc", "yearAsc", "mileageAsc"] as const;

export const publicStockQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(PUBLIC_MAX_PAGE_SIZE).default(PUBLIC_DEFAULT_PAGE_SIZE),
    make: text(60).optional(),
    model: text(60).optional(),
    bodyType: text(40).optional(),
    fuel: text(40).optional(),
    transmission: text(40).optional(),
    yearMin: z.coerce.number().int().min(1950).max(2100).optional(),
    yearMax: z.coerce.number().int().min(1950).max(2100).optional(),
    // In rupees (LKR), whole numbers.
    priceMin: z.coerce.number().int().min(0).max(MAX_STOCK_PRICE).optional(),
    priceMax: z.coerce.number().int().min(0).max(MAX_STOCK_PRICE).optional(),
    mileageMax: z.coerce.number().int().min(0).max(5_000_000).optional(),
    // Trimmed and cut to 100 characters; a blank search is no search.
    q: z
      .string()
      .transform((value) => value.trim().slice(0, 100))
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    sort: z.enum(PUBLIC_SORTS).default("newest"),
  })
  .strict();
export type PublicStockQuery = z.infer<typeof publicStockQuerySchema>;

export const publicSlugSchema = slug;

// ---------------------------------------------------------------------------------------------
// Enquiries (public form)

export const enquiryBodySchema = z
  .object({
    name: text(100),
    email: z.string().trim().toLowerCase().max(150).pipe(z.email("Enter a valid email address")),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+()\-\s.]{5,40}$/, "Enter a valid phone number")
      .optional(),
    message: plainText(2000),
    stockSlug: slug.optional(),
    // A hidden field real visitors never fill in. A bot that does is answered as if it worked, and dropped.
    website: z.string().max(300).optional(),
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type EnquiryBody = z.infer<typeof enquiryBodySchema>;

// ---------------------------------------------------------------------------------------------
// Staff

const stockFields = {
  make: text(60),
  model: text(80),
  year: z.number().int().min(1950).max(2100).nullable(),
  // The listing price in whole rupees (LKR): positive, no fractions, with a sane ceiling. null clears it.
  price: z
    .number("price must be a whole number of rupees or null")
    .int("price must be a whole number of rupees")
    .positive("price must be more than zero")
    .max(MAX_STOCK_PRICE, "price is too large")
    .nullable(),
  mileageKm: z.number().int().min(0).max(5_000_000).nullable(),
  bodyType: optionalText(40),
  fuel: optionalText(40),
  transmission: optionalText(40),
  colour: optionalText(40),
  description: optionalText(5000),
};

export const stockCreateSchema = z
  .object({
    make: stockFields.make,
    model: stockFields.model,
    year: stockFields.year.optional(),
    price: stockFields.price.optional(),
    mileageKm: stockFields.mileageKm.optional(),
    bodyType: stockFields.bodyType.optional(),
    fuel: stockFields.fuel.optional(),
    transmission: stockFields.transmission.optional(),
    colour: stockFields.colour.optional(),
    description: stockFields.description.optional(),
  })
  .strict();

export const stockUpdateSchema = z
  .object({
    make: stockFields.make.optional(),
    model: stockFields.model.optional(),
    year: stockFields.year.optional(),
    price: stockFields.price.optional(),
    mileageKm: stockFields.mileageKm.optional(),
    bodyType: stockFields.bodyType.optional(),
    fuel: stockFields.fuel.optional(),
    transmission: stockFields.transmission.optional(),
    colour: stockFields.colour.optional(),
    description: stockFields.description.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Send at least one field to change" });

export const stockListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    status: z.enum(["DRAFT", "PUBLISHED", "SOLD"]).optional(),
  })
  .strict();

export const publishBodySchema = z.object({ notifyCustomers: z.boolean().optional() }).strict();
export const emptyStockBodySchema = z.object({}).strict();

export const imagePresignSchema = z
  .object({
    contentType: z.string().min(1),
    fileSize: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!(STOCK_IMAGE_TYPES as readonly string[]).includes(value.contentType)) {
      ctx.addIssue({ code: "custom", path: ["contentType"], message: "Unsupported file type." });
    }
    if (value.fileSize > MAX_STOCK_IMAGE_BYTES) {
      ctx.addIssue({ code: "custom", path: ["fileSize"], message: `Images can be at most ${MAX_STOCK_IMAGE_BYTES / (1024 * 1024)} MB.` });
    }
  });

export const imageRegisterSchema = z
  .object({ key: z.string().min(10).max(200), altText: optionalText(200).optional() })
  .strict();

export const imageUpdateSchema = z
  .object({ altText: optionalText(200).optional(), sortOrder: z.number().int().min(0).max(MAX_IMAGES_PER_STOCK).optional() })
  .strict()
  .refine((v) => v.altText !== undefined || v.sortOrder !== undefined, { message: "Send at least one field to change" });

export const imageReorderSchema = z.object({ imageIds: z.array(id).min(1).max(MAX_IMAGES_PER_STOCK) }).strict();

export const enquiryListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    status: z.enum(["open", "handled", "all"]).default("open"),
  })
  .strict();

export const enquiryHandledSchema = z.object({ handled: z.boolean("handled must be true or false") }).strict();
