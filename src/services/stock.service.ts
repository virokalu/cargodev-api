// The curated stock shown on the public website, and the staff tools that manage it.
//
// PUBLIC side: no login, org from the server's default org (never from the request), only PUBLISHED rows, addressed by
// slug. Each DTO is built field by field: no ids, no org, no status, no timestamps except publishedAt, no storage keys.
// STAFF side: ADMINISTRATOR and MANAGER, every lookup filters by the token's org (another org's id is a 404), every
// mutation writes an ActivityLog row in the same transaction. "Publish" is its own explicit action.

import type { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { getDefaultOrgId } from "../config/default-org.js";
import { MAX_IMAGES_PER_STOCK, MAX_NEW_STOCK_RECIPIENTS, STOCK_PRICE_CURRENCY } from "../config/public-stock.js";
import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import { deleteStockImageObject, isOwnStockImageKey, presignStockImage, stockImageUrl, type PresignedStockImage } from "../lib/public-stock-storage.js";
import type { SessionUser } from "../lib/session-user.js";
import {
  emptyStockBodySchema,
  imagePresignSchema,
  imageRegisterSchema,
  imageReorderSchema,
  imageUpdateSchema,
  publicSlugSchema,
  publicStockQuerySchema,
  publishBodySchema,
  stockCreateSchema,
  stockListQuerySchema,
  stockUpdateSchema,
} from "../validation/stock.schema.js";
import * as activityLog from "./activity-log.service.js";
import { emit, notifyRealtime, type EmitParams } from "./notification.service.js";

const INVALID = "Please fix the highlighted fields.";
const notFound = () => new ServiceError("NOT_FOUND", "Stock vehicle not found.");
const imageNotFound = () => new ServiceError("NOT_FOUND", "Image not found.");
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const toNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** A listing price. Always an amount WITH its currency, never a bare number. */
export interface StockPrice {
  amount: number;
  currency: typeof STOCK_PRICE_CURRENCY;
}

/** The stored Decimal (`priceFob`, historical name) as a price in rupees. */
function toPrice(stored: unknown): StockPrice | null {
  const amount = toNumber(stored);
  return amount === null ? null : { amount, currency: STOCK_PRICE_CURRENCY };
}

// ---------------------------------------------------------------------------------------------
// Public

export interface PublicImage {
  url: string;
  alt: string | null;
}

export interface PublicStockCard {
  slug: string;
  make: string;
  model: string;
  year: number | null;
  price: StockPrice | null;
  mileageKm: number | null;
  bodyType: string | null;
  fuel: string | null;
  transmission: string | null;
  colour: string | null;
  publishedAt: string | null;
  image: PublicImage | null;
}

export interface PublicStockDetail extends PublicStockCard {
  description: string | null;
  images: PublicImage[];
}

const CARD_SELECT = {
  slug: true,
  make: true,
  model: true,
  year: true,
  priceFob: true,
  mileageKm: true,
  bodyType: true,
  fuel: true,
  transmission: true,
  colour: true,
  publishedAt: true,
} as const;

const IMAGE_SELECT = { key: true, altText: true, sortOrder: true } as const;

function toPublicImage(image: { key: string; altText: string | null }): PublicImage | null {
  const url = stockImageUrl(image.key);
  return url ? { url, alt: image.altText } : null;
}

const imagesOrdered = (images: { key: string; altText: string | null; sortOrder: number }[]) =>
  [...images].sort((a, b) => a.sortOrder - b.sortOrder).map(toPublicImage).filter((i): i is PublicImage => i !== null);

type CardRow = Prisma.StockVehicleGetPayload<{ select: typeof CARD_SELECT }>;

function toCard(row: CardRow, images: PublicImage[]): PublicStockCard {
  return {
    slug: row.slug,
    make: row.make,
    model: row.model,
    year: row.year,
    price: toPrice(row.priceFob),
    mileageKm: row.mileageKm,
    bodyType: row.bodyType,
    fuel: row.fuel,
    transmission: row.transmission,
    colour: row.colour,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    image: images[0] ?? null,
  };
}

/** The ONE definition of what the public may see: this org's, PUBLISHED. */
function publicWhere(orgId: string): Prisma.StockVehicleWhereInput {
  return { org_id: orgId, status: "PUBLISHED" };
}

const ci = (value: string) => ({ equals: value, mode: "insensitive" as const });

/**
 * Prisma passes `contains` straight into a LIKE pattern, so a visitor's % and _ would act as wildcards. In PostgreSQL the
 * default LIKE escape is the backslash, so a literal %, _ or backslash is written \%, \_ or \\ (the backslash first).
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const ORDER: Record<string, Prisma.StockVehicleOrderByWithRelationInput[]> = {
  newest: [{ publishedAt: "desc" }, { id: "desc" }],
  priceAsc: [{ priceFob: "asc" }, { id: "asc" }],
  priceDesc: [{ priceFob: "desc" }, { id: "desc" }],
  yearDesc: [{ year: "desc" }, { id: "desc" }],
  yearAsc: [{ year: "asc" }, { id: "asc" }],
  mileageAsc: [{ mileageKm: "asc" }, { id: "asc" }],
};

export async function listPublicStock(rawQuery: unknown): Promise<{ rows: PublicStockCard[]; total: number; page: number; pageSize: number }> {
  const q = parseInput(publicStockQuerySchema, rawQuery);
  const orgId = getDefaultOrgId();
  const prisma = getPrisma();

  const filters: Prisma.StockVehicleWhereInput[] = [publicWhere(orgId)];
  if (q.make) filters.push({ make: ci(q.make) });
  if (q.model) filters.push({ model: ci(q.model) });
  if (q.bodyType) filters.push({ bodyType: ci(q.bodyType) });
  if (q.fuel) filters.push({ fuel: ci(q.fuel) });
  if (q.transmission) filters.push({ transmission: ci(q.transmission) });
  if (q.yearMin !== undefined) filters.push({ year: { gte: q.yearMin } });
  if (q.yearMax !== undefined) filters.push({ year: { lte: q.yearMax } });
  if (q.priceMin !== undefined) filters.push({ priceFob: { gte: q.priceMin } });
  if (q.priceMax !== undefined) filters.push({ priceFob: { lte: q.priceMax } });
  if (q.mileageMax !== undefined) filters.push({ mileageKm: { lte: q.mileageMax } });
  if (q.q) {
    const pattern = escapeLike(q.q);
    filters.push({ OR: [{ make: { contains: pattern, mode: "insensitive" } }, { model: { contains: pattern, mode: "insensitive" } }] });
  }
  const where: Prisma.StockVehicleWhereInput = { AND: filters };

  const [total, rows] = await Promise.all([
    prisma.stockVehicle.count({ where }),
    prisma.stockVehicle.findMany({
      where,
      orderBy: ORDER[q.sort]!,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { ...CARD_SELECT, id: true },
    }),
  ]);

  // One query for every cover image on the page (never one per row).
  const images = rows.length
    ? await prisma.stockImage.findMany({ where: { org_id: orgId, stockVehicleId: { in: rows.map((r) => r.id) } }, select: { ...IMAGE_SELECT, stockVehicleId: true } })
    : [];
  const byStock = new Map<string, { key: string; altText: string | null; sortOrder: number }[]>();
  for (const image of images) byStock.set(image.stockVehicleId, [...(byStock.get(image.stockVehicleId) ?? []), image]);

  return {
    rows: rows.map((row) => toCard(row, imagesOrdered(byStock.get(row.id) ?? []).slice(0, 1))),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function getPublicStock(rawSlug: string): Promise<PublicStockDetail> {
  const parsed = publicSlugSchema.safeParse(rawSlug);
  if (!parsed.success) throw notFound();
  const orgId = getDefaultOrgId();
  const prisma = getPrisma();
  const row = await prisma.stockVehicle.findFirst({
    where: { AND: [publicWhere(orgId), { slug: parsed.data }] },
    select: { ...CARD_SELECT, id: true, description: true },
  });
  if (!row) throw notFound();
  const images = imagesOrdered(await prisma.stockImage.findMany({ where: { org_id: orgId, stockVehicleId: row.id }, select: IMAGE_SELECT }));
  return { ...toCard(row, images), description: row.description, images };
}

/** The slug of a published listing, or null. Used by the enquiry form so a bad slug is dropped, not stored. */
export async function publishedSlugOrNull(orgId: string, slug: string | undefined): Promise<string | null> {
  if (!slug) return null;
  const row = await getPrisma().stockVehicle.findFirst({ where: { AND: [publicWhere(orgId), { slug }] }, select: { slug: true } });
  return row?.slug ?? null;
}

// ---------------------------------------------------------------------------------------------
// Staff

export interface StaffStockImage {
  id: string;
  url: string | null;
  altText: string | null;
  sortOrder: number;
}

export interface StaffStock {
  id: string;
  slug: string;
  status: "DRAFT" | "PUBLISHED" | "SOLD";
  make: string;
  model: string;
  year: number | null;
  price: StockPrice | null;
  mileageKm: number | null;
  bodyType: string | null;
  fuel: string | null;
  transmission: string | null;
  colour: string | null;
  description: string | null;
  publishedAt: string | null;
  images: StaffStockImage[];
}

const STAFF_SELECT = {
  id: true,
  slug: true,
  status: true,
  make: true,
  model: true,
  year: true,
  priceFob: true,
  mileageKm: true,
  bodyType: true,
  fuel: true,
  transmission: true,
  colour: true,
  description: true,
  publishedAt: true,
} as const;

type StaffRow = Prisma.StockVehicleGetPayload<{ select: typeof STAFF_SELECT }>;

function toStaff(row: StaffRow, images: { id: string; key: string; altText: string | null; sortOrder: number }[]): StaffStock {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    make: row.make,
    model: row.model,
    year: row.year,
    price: toPrice(row.priceFob),
    mileageKm: row.mileageKm,
    bodyType: row.bodyType,
    fuel: row.fuel,
    transmission: row.transmission,
    colour: row.colour,
    description: row.description,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    images: [...images].sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({ id: i.id, url: stockImageUrl(i.key), altText: i.altText, sortOrder: i.sortOrder })),
  };
}

const slugify = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

function newSlug(input: { make: string; model: string; year?: number | null | undefined }): string {
  const base = slugify([input.make, input.model, input.year ?? ""].join(" ")) || "vehicle";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

async function loadOwned(client: Prisma.TransactionClient | ReturnType<typeof getPrisma>, orgId: string, id: string) {
  if (!ID.test(id)) throw notFound();
  const row = await client.stockVehicle.findFirst({ where: { id, org_id: orgId }, select: STAFF_SELECT });
  if (!row) throw notFound();
  return row;
}

async function withImages(client: Prisma.TransactionClient | ReturnType<typeof getPrisma>, orgId: string, row: StaffRow): Promise<StaffStock> {
  const images = await client.stockImage.findMany({ where: { org_id: orgId, stockVehicleId: row.id }, select: { id: true, key: true, altText: true, sortOrder: true } });
  return toStaff(row, images);
}

export async function listStaffStock(orgId: string, rawQuery: unknown): Promise<{ rows: StaffStock[]; total: number; page: number; pageSize: number }> {
  const q = parseInput(stockListQuerySchema, rawQuery);
  const prisma = getPrisma();
  const where = { org_id: orgId, ...(q.status ? { status: q.status } : {}) };
  const [total, rows] = await Promise.all([
    prisma.stockVehicle.count({ where }),
    prisma.stockVehicle.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: STAFF_SELECT }),
  ]);
  const images = rows.length
    ? await prisma.stockImage.findMany({ where: { org_id: orgId, stockVehicleId: { in: rows.map((r) => r.id) } }, select: { id: true, key: true, altText: true, sortOrder: true, stockVehicleId: true } })
    : [];
  return { rows: rows.map((row) => toStaff(row, images.filter((i) => i.stockVehicleId === row.id))), total, page: q.page, pageSize: q.pageSize };
}

export async function getStaffStock(orgId: string, id: string): Promise<StaffStock> {
  const prisma = getPrisma();
  return withImages(prisma, orgId, await loadOwned(prisma, orgId, id));
}

export async function createStock(actor: SessionUser, rawBody: unknown): Promise<StaffStock> {
  const input = parseInput(stockCreateSchema, rawBody, INVALID);
  return getPrisma().$transaction(async (tx) => {
    // A slug collision (rare: 24 random bits) retries with a new one.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = newSlug(input);
      if (await tx.stockVehicle.findFirst({ where: { org_id: actor.orgId, slug }, select: { id: true } })) continue;
      const created = await tx.stockVehicle.create({
        data: { org_id: actor.orgId, slug, status: "DRAFT", make: input.make, model: input.model, year: input.year ?? null, priceFob: input.price ?? null, mileageKm: input.mileageKm ?? null, bodyType: input.bodyType ?? null, fuel: input.fuel ?? null, transmission: input.transmission ?? null, colour: input.colour ?? null, description: input.description ?? null },
        select: STAFF_SELECT,
      });
      await activityLog.record(tx, { orgId: actor.orgId, actorId: actor.id, action: "CREATE_STOCK", entity: "StockVehicle", entityId: created.id, after: { make: created.make, model: created.model, status: "DRAFT" } });
      return toStaff(created, []);
    }
    throw new ServiceError("CONFLICT", "Could not create a unique address for this listing. Try again.");
  });
}

export async function updateStock(actor: SessionUser, id: string, rawBody: unknown): Promise<StaffStock> {
  const changes = parseInput(stockUpdateSchema, rawBody, INVALID);
  return getPrisma().$transaction(async (tx) => {
    const before = await loadOwned(tx, actor.orgId, id);
    // The API says `price`; the column is the historical `priceFob`. The price is stored as a Decimal (whole rupees).
    const data = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined).map(([k, v]) => [k === "price" ? "priceFob" : k, v]));
    const updated = await tx.stockVehicle.update({ where: { id: before.id }, data, select: STAFF_SELECT });
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "UPDATE_STOCK",
      entity: "StockVehicle",
      entityId: before.id,
      before: pick(before, Object.keys(data)),
      after: pick(updated, Object.keys(data)),
    });
    return withImages(tx, actor.orgId, updated);
  });
}

function pick(row: object, keys: string[]): Record<string, unknown> {
  const source = row as Record<string, unknown>;
  return Object.fromEntries(
    keys.map((k) => {
      const value = source[k];
      // the log says `price` (a number of rupees), like the API
      if (k === "priceFob") return ["price", toNumber(value)];
      return [k, value instanceof Date ? value.toISOString() : (value ?? null)];
    })
  );
}

type Transition = { action: string; from: ("DRAFT" | "PUBLISHED" | "SOLD")[]; to: "DRAFT" | "PUBLISHED" | "SOLD" };

/** A status change is a conditional update on the current status, so two staff acting at once cannot both win. */
async function transition(actor: SessionUser, id: string, change: Transition, extra?: (tx: Prisma.TransactionClient, row: StaffRow) => Promise<EmitParams | null>): Promise<{ stock: StaffStock; announce: EmitParams | null }> {
  return getPrisma().$transaction(async (tx) => {
    const before = await loadOwned(tx, actor.orgId, id);
    if (!change.from.includes(before.status)) {
      throw new ServiceError("CONFLICT", `This listing is ${before.status.toLowerCase()}; it cannot be changed that way.`);
    }
    if (change.to === "PUBLISHED") {
      const count = await tx.stockImage.count({ where: { org_id: actor.orgId, stockVehicleId: before.id } });
      if (count === 0) throw new ServiceError("VALIDATION", "Add at least one image before publishing.", { images: "Add at least one image" });
    }
    const claimed = await tx.stockVehicle.updateMany({
      where: { id: before.id, org_id: actor.orgId, status: { in: change.from } },
      data: { status: change.to, publishedAt: change.to === "PUBLISHED" ? new Date() : change.to === "DRAFT" ? null : before.publishedAt },
    });
    if (claimed.count === 0) throw new ServiceError("CONFLICT", "This listing was changed by someone else. Reload and try again.");
    const updated = await loadOwned(tx, actor.orgId, id);
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: change.action,
      entity: "StockVehicle",
      entityId: before.id,
      before: { status: before.status },
      after: { status: updated.status },
    });
    const announce = extra ? await extra(tx, updated) : null;
    return { stock: await withImages(tx, actor.orgId, updated), announce };
  });
}

/** Publishes a draft. With `notifyCustomers`, customers who have not switched "new stock" off are told (at most 1000). */
export async function publishStock(actor: SessionUser, id: string, rawBody: unknown): Promise<StaffStock> {
  const { notifyCustomers } = parseInput(publishBodySchema, rawBody ?? {}, INVALID);
  const result = await transition(actor, id, { action: "PUBLISH_STOCK", from: ["DRAFT"], to: "PUBLISHED" }, async (tx, row) => {
    if (!notifyCustomers) return null;
    const customers = await tx.user.findMany({
      where: { org_id: actor.orgId, userType: "CUSTOMER", loginEnabled: true, deletedAt: null },
      select: { id: true },
      take: MAX_NEW_STOCK_RECIPIENTS,
      orderBy: { id: "asc" },
    });
    if (customers.length === 0) return null;
    const params: EmitParams = {
      orgId: actor.orgId,
      event: "NEW_STOCK",
      title: "New stock",
      body: `${row.make} ${row.model}${row.year ? ` (${row.year})` : ""} has just been added.`,
      recipientUserIds: customers.map((c) => c.id),
    };
    await emit(tx, params);
    return params.recipientUserIds.length > 0 ? params : null;
  });
  if (result.announce) notifyRealtime(result.announce);
  return result.stock;
}

export async function unpublishStock(actor: SessionUser, id: string, rawBody: unknown): Promise<StaffStock> {
  parseInput(emptyStockBodySchema, rawBody ?? {}, INVALID);
  return (await transition(actor, id, { action: "UNPUBLISH_STOCK", from: ["PUBLISHED", "SOLD"], to: "DRAFT" })).stock;
}

export async function markStockSold(actor: SessionUser, id: string, rawBody: unknown): Promise<StaffStock> {
  parseInput(emptyStockBodySchema, rawBody ?? {}, INVALID);
  return (await transition(actor, id, { action: "MARK_STOCK_SOLD", from: ["PUBLISHED"], to: "SOLD" })).stock;
}

export async function deleteStock(actor: SessionUser, id: string): Promise<{ deleted: true }> {
  const keys = await getPrisma().$transaction(async (tx) => {
    const before = await loadOwned(tx, actor.orgId, id);
    const images = await tx.stockImage.findMany({ where: { org_id: actor.orgId, stockVehicleId: before.id }, select: { key: true } });
    await tx.stockImage.deleteMany({ where: { org_id: actor.orgId, stockVehicleId: before.id } });
    await tx.stockVehicle.deleteMany({ where: { id: before.id, org_id: actor.orgId } });
    await activityLog.record(tx, { orgId: actor.orgId, actorId: actor.id, action: "DELETE_STOCK", entity: "StockVehicle", entityId: before.id, before: { make: before.make, model: before.model, status: before.status } });
    return images.map((i) => i.key);
  });
  for (const key of keys) await deleteStockImageObject(key);
  return { deleted: true };
}

// ---------------------------------------------------------------------------------------------
// Images

export async function presignStockUpload(actor: SessionUser, id: string, rawBody: unknown): Promise<PresignedStockImage> {
  const input = parseInput(imagePresignSchema, rawBody, INVALID);
  await loadOwned(getPrisma(), actor.orgId, id); // ownership before anything is signed
  return presignStockImage(actor.orgId, input.contentType, input.fileSize);
}

export async function addStockImage(actor: SessionUser, id: string, rawBody: unknown): Promise<StaffStock> {
  const input = parseInput(imageRegisterSchema, rawBody, INVALID);
  return getPrisma().$transaction(async (tx) => {
    // The listing first (another org's is a 404), then the key.
    const stock = await loadOwned(tx, actor.orgId, id);
    if (!isOwnStockImageKey(actor.orgId, input.key)) {
      throw new ServiceError("VALIDATION", "This image was not uploaded for your organisation.", { key: "Not an image uploaded for this organisation" });
    }
    if (await tx.stockImage.findFirst({ where: { key: input.key }, select: { id: true } })) {
      throw new ServiceError("CONFLICT", "This image is already in use.");
    }
    const existing = await tx.stockImage.findMany({ where: { org_id: actor.orgId, stockVehicleId: stock.id }, select: { sortOrder: true } });
    if (existing.length >= MAX_IMAGES_PER_STOCK) throw new ServiceError("CONFLICT", `A listing can have at most ${MAX_IMAGES_PER_STOCK} images.`);
    const sortOrder = existing.length ? Math.max(...existing.map((i) => i.sortOrder)) + 1 : 0;
    const image = await tx.stockImage.create({ data: { org_id: actor.orgId, stockVehicleId: stock.id, key: input.key, altText: input.altText ?? null, sortOrder }, select: { id: true } });
    await activityLog.record(tx, { orgId: actor.orgId, actorId: actor.id, action: "ADD_STOCK_IMAGE", entity: "StockImage", entityId: image.id, after: { stockVehicleId: stock.id, sortOrder } });
    return withImages(tx, actor.orgId, stock);
  });
}

export async function updateStockImage(actor: SessionUser, id: string, imageId: string, rawBody: unknown): Promise<StaffStock> {
  const changes = parseInput(imageUpdateSchema, rawBody, INVALID);
  return getPrisma().$transaction(async (tx) => {
    const stock = await loadOwned(tx, actor.orgId, id);
    if (!ID.test(imageId)) throw imageNotFound();
    const image = await tx.stockImage.findFirst({ where: { id: imageId, org_id: actor.orgId, stockVehicleId: stock.id }, select: { id: true, altText: true, sortOrder: true } });
    if (!image) throw imageNotFound();
    const data = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    await tx.stockImage.update({ where: { id: image.id }, data });
    await activityLog.record(tx, { orgId: actor.orgId, actorId: actor.id, action: "UPDATE_STOCK_IMAGE", entity: "StockImage", entityId: image.id, before: pick(image, Object.keys(data)), after: data });
    return withImages(tx, actor.orgId, stock);
  });
}

export async function reorderStockImages(actor: SessionUser, id: string, rawBody: unknown): Promise<StaffStock> {
  const { imageIds } = parseInput(imageReorderSchema, rawBody, INVALID);
  return getPrisma().$transaction(async (tx) => {
    const stock = await loadOwned(tx, actor.orgId, id);
    const images = await tx.stockImage.findMany({ where: { org_id: actor.orgId, stockVehicleId: stock.id }, select: { id: true } });
    const wanted = new Set(imageIds);
    // Exactly this listing's images, each once: anything else (another listing's image, a missing one, a repeat) is refused.
    if (wanted.size !== imageIds.length || images.length !== imageIds.length || images.some((i) => !wanted.has(i.id))) {
      throw new ServiceError("VALIDATION", "Send every image of this listing exactly once.", { imageIds: "Send every image of this listing exactly once" });
    }
    for (const [index, imageId] of imageIds.entries()) {
      await tx.stockImage.updateMany({ where: { id: imageId, org_id: actor.orgId, stockVehicleId: stock.id }, data: { sortOrder: index } });
    }
    await activityLog.record(tx, { orgId: actor.orgId, actorId: actor.id, action: "REORDER_STOCK_IMAGES", entity: "StockVehicle", entityId: stock.id, after: { imageIds } });
    return withImages(tx, actor.orgId, stock);
  });
}

export async function deleteStockImage(actor: SessionUser, id: string, imageId: string): Promise<StaffStock> {
  const { stock, key } = await getPrisma().$transaction(async (tx) => {
    const owner = await loadOwned(tx, actor.orgId, id);
    if (!ID.test(imageId)) throw imageNotFound();
    const image = await tx.stockImage.findFirst({ where: { id: imageId, org_id: actor.orgId, stockVehicleId: owner.id }, select: { id: true, key: true } });
    if (!image) throw imageNotFound();
    // A published listing keeps at least one image.
    if (owner.status === "PUBLISHED" && (await tx.stockImage.count({ where: { org_id: actor.orgId, stockVehicleId: owner.id } })) <= 1) {
      throw new ServiceError("CONFLICT", "A published listing needs at least one image. Unpublish it first.");
    }
    await tx.stockImage.deleteMany({ where: { id: image.id, org_id: actor.orgId } });
    await activityLog.record(tx, { orgId: actor.orgId, actorId: actor.id, action: "DELETE_STOCK_IMAGE", entity: "StockImage", entityId: image.id, before: { stockVehicleId: owner.id } });
    return { stock: await withImages(tx, actor.orgId, owner), key: image.key };
  });
  await deleteStockImageObject(key);
  return stock;
}
