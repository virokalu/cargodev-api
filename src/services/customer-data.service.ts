// What a signed-in customer may read about their own vehicles. Every DTO is built field by field below: a database row
// is never returned or spread. NEVER included, on purpose: remarks and internal notes, auction hall, supplier, lot and
// item numbers, whether the auction bill is paid, transport, freight/packing agents, inspection details, selling price
// and other internal costs, partnership details, row colour, other customers, the activity log.
//
// Which vehicles: the customer's own, same org, not deleted, an export-track vehicle (effective track, so a converted
// one counts), released by staff (customerVisible), and not cancelled. Anything else does not exist as far as the
// customer is concerned (404, or simply absent from lists).

import type { MilestoneType, Prisma } from "@prisma/client";
import { ServiceError } from "../lib/errors.js";
import { parseInput } from "../lib/parse.js";
import { getPrisma } from "../lib/prisma.js";
import { CANCEL_SHIPMENT_ROW_COLOUR_NAMES, computeEffectiveShipmentStatus } from "../lib/shipment-status.js";
import { buildTrackWhere } from "../lib/vehicle-track.js";
import {
  customerDocumentListQuerySchema,
  customerVehicleListQuerySchema,
  noQuerySchema,
  type CustomerStatus,
} from "../validation/customer-data.schema.js";
import { buildEffectiveShipmentStatusWhere } from "./vehicle.service.js";

export interface CustomerPrincipalLike {
  id: string;
  orgId: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOT_FOUND = () => new ServiceError("NOT_FOUND", "Vehicle not found.");

/** The ONE definition of "a vehicle this customer may see". Every query below starts from it. */
export function customerVehicleWhere(customer: CustomerPrincipalLike): Prisma.VehicleWhereInput {
  return {
    AND: [
      { org_id: customer.orgId, customerId: customer.id, deletedAt: null, customerVisible: true },
      buildTrackWhere("FC"),
      { NOT: { rowColourStatus: { name: { in: [...CANCEL_SHIPMENT_ROW_COLOUR_NAMES] } } } },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// DTOs

export interface Money {
  amount: number;
  currency: string;
}

export interface CustomerVehicleSummary {
  id: string;
  serial: string;
  brand: string | null;
  model: string | null;
  grade: string | null;
  year: number | null;
  chassisNo: string | null;
  destination: string | null;
  status: CustomerStatus;
  purchaseDate: string | null;
  etd: string | null;
  eta: string | null;
  portOfLoading: string | null;
  portOfDischarge: string | null;
  vesselName: string | null;
  amount: Money | null;
  coverPhotoId: string | null;
  photoCount: number;
}

export interface CustomerVehicleDetail extends CustomerVehicleSummary {
  voyageNo: string | null;
  blNo: string | null;
  shippingMethod: "RORO" | "CONTAINER" | null;
  containerNumber: string | null;
}

export const TIMELINE: { type: MilestoneType; label: string }[] = [
  { type: "BOUGHT", label: "Bought" },
  { type: "AUCTION_BILL_PAID", label: "Auction bill paid" },
  { type: "AT_EXPORT_YARD", label: "At export yard" },
  { type: "EXPORT_CERT_ISSUED", label: "Export certificate issued" },
  { type: "BOOKING_RECEIVED", label: "Booking received" },
  { type: "SHIPPED", label: "Shipped" },
  { type: "BL_ISSUED", label: "Bill of lading issued" },
  { type: "ARRIVED", label: "Arrived" },
  { type: "DELIVERED", label: "Delivered" },
];

export interface TimelineStep {
  type: MilestoneType;
  label: string;
  completed: boolean;
  occurredAt: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "object" && typeof (value as { toNumber?: unknown }).toNumber === "function") return (value as { toNumber(): number }).toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(amount: unknown, currency: string | null): Money | null {
  const n = toNumber(amount);
  return n === null || !currency ? null : { amount: n, currency };
}

/** What the customer sees: the later of the shipping status and the arrival / delivery milestones. */
function customerStatus(stored: "PENDING" | "BOOKING_RECEIVED" | "SHIPPED", etd: Date | null, milestones: ReadonlySet<MilestoneType>): CustomerStatus {
  if (milestones.has("DELIVERED")) return "DELIVERED";
  if (milestones.has("ARRIVED")) return "ARRIVED";
  const effective = computeEffectiveShipmentStatus(stored, etd, false);
  return effective === "CANCELLED" ? "PENDING" : effective;
}

const detailSelect = {
  id: true,
  serial: true,
  chassisNo: true,
  yom: true,
  destination: true,
  shipmentStatus: true,
  purchaseDate: true,
  etd: true,
  eta: true,
  portOfLoading: true,
  portOfDischarge: true,
  vesselName: true,
  voyageNo: true,
  blNo: true,
  shippingMethod: true,
  containerNumber: true,
  customerAmount: true,
  customerAmountCurrency: true,
  model: { select: { name: true, brand: { select: { name: true } } } },
  grade: { select: { name: true } },
} as const;

type VehicleRow = Prisma.VehicleGetPayload<{ select: typeof detailSelect }>;

interface Extras {
  milestones: Map<string, Set<MilestoneType>>;
  photos: Map<string, string[]>;
}

/** One query for the released photos and one for the milestones of a set of vehicles (never one per vehicle). */
async function loadExtras(orgId: string, vehicleIds: string[]): Promise<Extras> {
  const prisma = getPrisma();
  const milestones = new Map<string, Set<MilestoneType>>();
  const photos = new Map<string, string[]>();
  if (vehicleIds.length === 0) return { milestones, photos };

  const [milestoneRows, photoRows] = await Promise.all([
    prisma.vehicleMilestone.findMany({ where: { org_id: orgId, vehicleId: { in: vehicleIds } }, select: { vehicleId: true, type: true } }),
    prisma.vehiclePhoto.findMany({
      where: { vehicleId: { in: vehicleIds }, visibleToCustomer: true },
      select: { id: true, vehicleId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  for (const m of milestoneRows) (milestones.get(m.vehicleId) ?? milestones.set(m.vehicleId, new Set()).get(m.vehicleId)!).add(m.type);
  for (const p of photoRows) (photos.get(p.vehicleId) ?? photos.set(p.vehicleId, []).get(p.vehicleId)!).push(p.id);
  return { milestones, photos };
}

function toSummary(row: VehicleRow, extras: Extras): CustomerVehicleSummary {
  const photoIds = extras.photos.get(row.id) ?? [];
  return {
    id: row.id,
    serial: row.serial,
    brand: row.model?.brand?.name ?? null,
    model: row.model?.name ?? null,
    grade: row.grade?.name ?? null,
    year: row.yom,
    chassisNo: row.chassisNo,
    destination: row.destination,
    status: customerStatus(row.shipmentStatus, row.etd, extras.milestones.get(row.id) ?? new Set()),
    purchaseDate: iso(row.purchaseDate),
    etd: iso(row.etd),
    eta: iso(row.eta),
    portOfLoading: row.portOfLoading,
    portOfDischarge: row.portOfDischarge,
    vesselName: row.vesselName,
    amount: money(row.customerAmount, row.customerAmountCurrency),
    coverPhotoId: photoIds[0] ?? null,
    photoCount: photoIds.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Vehicles

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** The SQL for a customer-facing status filter (the status is derived, so it is a where-clause, not a column). */
function statusWhere(status: CustomerStatus): Prisma.VehicleWhereInput {
  if (status === "DELIVERED") return { milestones: { some: { type: "DELIVERED" } } };
  if (status === "ARRIVED") return { milestones: { some: { type: "ARRIVED" }, none: { type: "DELIVERED" } } };
  return { AND: [buildEffectiveShipmentStatusWhere(status), { milestones: { none: { type: { in: ["ARRIVED", "DELIVERED"] } } } }] };
}

export async function listCustomerVehicles(customer: CustomerPrincipalLike, rawQuery: unknown): Promise<Page<CustomerVehicleSummary>> {
  const q = parseInput(customerVehicleListQuerySchema, rawQuery);
  const prisma = getPrisma();

  const where: Prisma.VehicleWhereInput = {
    AND: [
      customerVehicleWhere(customer),
      ...(q.status ? [statusWhere(q.status)] : []),
      ...(q.brand ? [{ model: { brand: { name: { equals: q.brand, mode: "insensitive" as const } } } }] : []),
    ],
  };

  const field = q.sort === "arrival" ? "eta" : q.sort === "price" ? "customerAmount" : "purchaseDate";
  const [total, rows] = await Promise.all([
    prisma.vehicle.count({ where }),
    prisma.vehicle.findMany({
      where,
      select: detailSelect,
      // Vehicles without a value for the sort field always come last, in either direction.
      orderBy: [{ [field]: { sort: q.dir, nulls: "last" } }, { id: "asc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);

  const extras = await loadExtras(customer.orgId, rows.map((r) => r.id));
  return { rows: rows.map((r) => toSummary(r, extras)), total, page: q.page, pageSize: q.pageSize };
}

async function findOwnVehicle(customer: CustomerPrincipalLike, vehicleId: string): Promise<VehicleRow> {
  if (!ID.test(vehicleId)) throw NOT_FOUND();
  const row = await getPrisma().vehicle.findFirst({
    where: { AND: [customerVehicleWhere(customer), { id: vehicleId }] },
    select: detailSelect,
  });
  if (!row) throw NOT_FOUND();
  return row;
}

export async function getCustomerVehicle(customer: CustomerPrincipalLike, vehicleId: string): Promise<CustomerVehicleDetail> {
  const row = await findOwnVehicle(customer, vehicleId);
  const extras = await loadExtras(customer.orgId, [row.id]);
  return {
    ...toSummary(row, extras),
    voyageNo: row.voyageNo,
    blNo: row.blNo,
    shippingMethod: row.shippingMethod,
    containerNumber: row.containerNumber,
  };
}

export async function getCustomerTimeline(customer: CustomerPrincipalLike, vehicleId: string): Promise<TimelineStep[]> {
  const row = await findOwnVehicle(customer, vehicleId);
  const rows = await getPrisma().vehicleMilestone.findMany({ where: { org_id: customer.orgId, vehicleId: row.id }, select: { type: true, occurredAt: true } });
  const byType = new Map(rows.map((m) => [m.type, m.occurredAt] as const));
  return TIMELINE.map(({ type, label }) => ({ type, label, completed: byType.has(type), occurredAt: iso(byType.get(type)) }));
}

export interface CustomerPhoto {
  id: string;
  createdAt: string;
}

export async function listCustomerPhotos(customer: CustomerPrincipalLike, vehicleId: string): Promise<CustomerPhoto[]> {
  const row = await findOwnVehicle(customer, vehicleId);
  const photos = await getPrisma().vehiclePhoto.findMany({
    where: { vehicleId: row.id, visibleToCustomer: true },
    select: { id: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  return photos.map((p) => ({ id: p.id, createdAt: p.createdAt.toISOString() }));
}

// ---------------------------------------------------------------------------------------------
// Documents

export interface CustomerDocument {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  vehicle: { id: string; serial: string };
}

export async function listCustomerDocuments(customer: CustomerPrincipalLike, rawQuery: unknown): Promise<Page<CustomerDocument>> {
  const q = parseInput(customerDocumentListQuerySchema, rawQuery);
  const prisma = getPrisma();

  const vehicles = await prisma.vehicle.findMany({ where: customerVehicleWhere(customer), select: { id: true, serial: true }, take: 500 });
  const serialById = new Map(vehicles.map((v) => [v.id, v.serial] as const));
  // A vehicle id that is not one of the customer's visible vehicles simply matches nothing.
  const ids = q.vehicleId ? vehicles.filter((v) => v.id === q.vehicleId).map((v) => v.id) : vehicles.map((v) => v.id);
  if (ids.length === 0) return { rows: [], total: 0, page: q.page, pageSize: q.pageSize };

  const where = { vehicleId: { in: ids }, visibleToCustomer: true };
  const [total, rows] = await Promise.all([
    prisma.vehicleDocument.count({ where }),
    prisma.vehicleDocument.findMany({
      where,
      select: { id: true, name: true, documentType: true, createdAt: true, vehicleId: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  return {
    rows: rows.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.documentType,
      createdAt: d.createdAt.toISOString(),
      vehicle: { id: d.vehicleId, serial: serialById.get(d.vehicleId) ?? "" },
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

// ---------------------------------------------------------------------------------------------
// Purchase history and home

export interface PurchaseHistory {
  deliveredCount: number;
  /** Set when every valued vehicle uses one currency; otherwise null and see totalSpentByCurrency. */
  totalSpent: Money | null;
  totalSpentByCurrency: Money[];
  customerSince: string;
}

export async function getPurchaseHistory(customer: CustomerPrincipalLike): Promise<PurchaseHistory> {
  const prisma = getPrisma();
  const [user, vehicles] = await Promise.all([
    prisma.user.findFirst({ where: { id: customer.id, org_id: customer.orgId, userType: "CUSTOMER", deletedAt: null }, select: { createdAt: true } }),
    prisma.vehicle.findMany({ where: customerVehicleWhere(customer), select: { id: true, customerAmount: true, customerAmountCurrency: true }, take: 1000 }),
  ]);
  if (!user) throw new ServiceError("NOT_FOUND", "Account not found.");

  const extras = await loadExtras(customer.orgId, vehicles.map((v) => v.id));
  const deliveredCount = vehicles.filter((v) => extras.milestones.get(v.id)?.has("DELIVERED")).length;

  const totals = new Map<string, number>();
  for (const v of vehicles) {
    const m = money(v.customerAmount, v.customerAmountCurrency);
    if (m) totals.set(m.currency, Math.round(((totals.get(m.currency) ?? 0) + m.amount) * 100) / 100);
  }
  const byCurrency = [...totals].map(([currency, amount]) => ({ amount, currency })).sort((a, b) => a.currency.localeCompare(b.currency));
  return {
    deliveredCount,
    totalSpent: byCurrency.length === 1 ? byCurrency[0]! : null,
    totalSpentByCurrency: byCurrency,
    customerSince: user.createdAt.toISOString(),
  };
}

export interface CustomerHome {
  name: string;
  activeCount: number;
  deliveredCount: number;
  nextDeparture: { vehicleId: string; serial: string; etd: string } | null;
  recentVehicles: CustomerVehicleSummary[];
}

export async function getCustomerHome(customer: CustomerPrincipalLike): Promise<CustomerHome> {
  const prisma = getPrisma();
  const [user, rows] = await Promise.all([
    prisma.user.findFirst({ where: { id: customer.id, org_id: customer.orgId, userType: "CUSTOMER", deletedAt: null }, select: { name: true } }),
    prisma.vehicle.findMany({
      where: customerVehicleWhere(customer),
      select: detailSelect,
      orderBy: [{ purchaseDate: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take: 500,
    }),
  ]);
  if (!user) throw new ServiceError("NOT_FOUND", "Account not found.");

  const extras = await loadExtras(customer.orgId, rows.map((r) => r.id));
  const summaries = rows.map((r) => toSummary(r, extras));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const upcoming = rows
    .filter((r) => r.etd && r.etd.getTime() >= today.getTime() && ["PENDING", "BOOKING_RECEIVED"].includes(summaries.find((s) => s.id === r.id)!.status))
    .sort((a, b) => a.etd!.getTime() - b.etd!.getTime())[0];

  return {
    name: user.name,
    activeCount: summaries.filter((s) => s.status !== "DELIVERED").length,
    deliveredCount: summaries.filter((s) => s.status === "DELIVERED").length,
    nextDeparture: upcoming ? { vehicleId: upcoming.id, serial: upcoming.serial, etd: upcoming.etd!.toISOString() } : null,
    recentVehicles: summaries.slice(0, 3),
  };
}

// ---------------------------------------------------------------------------------------------
// Help

export interface CustomerFaq {
  id: string;
  question: string;
  answer: string;
}

export async function listFaqs(customer: CustomerPrincipalLike, rawQuery: unknown): Promise<CustomerFaq[]> {
  parseInput(noQuerySchema, rawQuery);
  const rows = await getPrisma().faq.findMany({
    where: { org_id: customer.orgId, published: true },
    select: { id: true, question: true, answer: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  return rows.map((f) => ({ id: f.id, question: f.question, answer: f.answer }));
}
