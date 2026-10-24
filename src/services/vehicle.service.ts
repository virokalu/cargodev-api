// Vehicle service.
//
// Ported in three slices. THIS FILE CURRENTLY HOLDS SLICE 1 ONLY: the read paths
// (list, detail, status history, distinct destinations/partner names, filter
// options). Every query is scoped by orgId and excludes soft-deleted vehicles.
//
// Seams left for later slices (do not add logic for them here until then):
//   Slice 2: createVehicle, updateVehicle, deleteVehicle, hasDuplicateChassisNo
//   Slice 3: convert*/revert*, updateVehicleRowColourStatus,
//            updateVehicleAuctionBillPaid, correctVehicleSerialNumber
//   Later:   runDailyShipmentStatusTransitions (with reminder.service)
//   File-related (file.service is not ported; needs the object-storage SDK):
//            listVehicleFiles, getVehiclePdfImages, photo/document/auction-sheet
//            mutations

import type { Prisma, SerialPrefix, ShipmentStatus, ShippingMethod } from "@prisma/client";
// The raw Vehicle.shipmentStatus column only ever holds the 3 Prisma-enum
// values above. CANCELLED is a computed, FC-only, display-only status (see
// lib/shipment-status.ts) — fields that hold an *effective* status use this
// wider app-level type instead.
import type { ShipmentStatus as EffectiveShipmentStatus } from "../lib/constants/shipment-status.js";
import { SHIPMENT_STATUS_ORDER, SHIPMENT_STATUS_META } from "../lib/constants/shipment-status.js";
import { SHIPPING_METHODS, TRI_STATE_VALUES, TWO_STATE_VALUES, SOLD_CURRENCIES } from "../lib/vehicle-list-url.js";
import { getPrisma } from "../lib/prisma.js";
import { ServiceError } from "../lib/errors.js";
import { buildTrackWhere, computeEffectiveTrack, type TrackFilter } from "../lib/vehicle-track.js";
import {
  computeEffectiveShipmentStatus,
  isCancelShipmentRowColour,
  todayAtMidnight,
  CANCEL_SHIPMENT_ROW_COLOUR_NAMES,
} from "../lib/shipment-status.js";

interface LookupRef {
  id: string;
  name: string;
}

export interface VehicleDetailData {
  id: string;
  serial: string;
  // Effective track (lib/vehicle-track.ts) — "FC" once convertedToExport is
  // true, even though serialPrefix (and the serial string above) never
  // changes. Every existing FC/FL field-visibility check in the form/detail
  // view/PDF already reads this field, so they get converted-vehicle
  // behaviour automatically with no changes of their own.
  track: SerialPrefix;
  // Whether this vehicle has been converted from FL to export — combined
  // with track === "FL" this is how the edit page decides whether to show
  // the "Convert to Export" button (only offered once, to a still-FL,
  // not-yet-converted vehicle).
  convertedToExport: boolean;
  // Mirror of convertedToExport above — combined with track === "FC" this
  // is how the edit page decides whether to show the "Convert to Local"
  // button (only offered once, to a still-FC, not-yet-converted vehicle).
  convertedToLocal: boolean;
  shipmentStatus: EffectiveShipmentStatus;

  auctionItemNo: string | null;
  chassisNo: string | null;
  brand: LookupRef | null;
  model: LookupRef | null;
  grade: LookupRef | null;
  yom: number | null;
  auctionHall: LookupRef | null;
  supplier: LookupRef | null;
  purchaseDate: Date | null;
  auctionLotNo: string | null;
  customer: LookupRef | null;
  destination: string | null;
  hasPartnership: boolean;
  partnerName: string | null;

  etd: Date | null;
  // When ETD was actually saved (the StatusHistory row for the PENDING →
  // BOOKING_RECEIVED transition), not the ETD value itself — the Shipment
  // Timeline's "Booking Received" milestone shows this instead of etd, since
  // "booking received" means the date staff entered the booking, not the
  // date the ship is expected to depart. null for FL vehicles (etd is
  // always null, so this transition never happens) and for legacy-entry
  // vehicles whose starting status was hand-picked rather than derived from
  // an ETD save.
  bookingReceivedAt: Date | null;
  eta: Date | null;
  blNo: string | null;
  vesselName: string | null;
  freightAgent: (LookupRef & { offersRoro: boolean; offersContainer: boolean }) | null;
  shippingMethod: ShippingMethod | null;
  packingAgent: LookupRef | null;
  vanningDate: Date | null;
  containerNumber: string | null;
  hasInspection: boolean;
  inspectionDate: Date | null;
  inspectionCompany: LookupRef | null;
  inspectionBy: LookupRef | null;

  transportBy: LookupRef | null;
  vehicleLocation: LookupRef | null;
  massoDate: Date | null;
  trackingNumber: string | null;
  lcNo: string | null;
  docsArrivedDate: Date | null;

  auctionBillPaid: boolean | null;
  logBook: boolean | null;
  extraKey: boolean | null;
  nameChangeDeadline: Date | null;
  rowColourStatus: { id: string; name: string; colour: string } | null;
  docSentDate: Date | null;
  docSentComment: string | null;
  recycleDate: Date | null;
  jibaishake: string | null;
  vehicleRemark: string | null;

  // ── Sold Details (FL only) ─────────────────
  deliveryDate: Date | null;
  paidByCustomer: boolean | null;
  // Prisma's Decimal isn't safe to hand to a Client Component as-is — plain
  // number, same treatment money would get anywhere else in this app if it
  // existed elsewhere (it doesn't, this is the first).
  sellingPrice: number | null;
  sellingPriceCurrency: string | null;
}

/** Fetches a vehicle shaped for display — the edit form and the read-only
 * detail page (US-10) both need every field, just one renders them as
 * inputs and the other as plain text. Returns null if it doesn't exist or
 * belongs to a different org (both callers treat that as 404 — never leak
 * which org a given id belongs to). */
export async function getVehicleDetail(orgId: string, serial: string): Promise<VehicleDetailData | null> {
  // Looked up by serial, not id — serial is unique per org, read-only after
  // creation (CLAUDE.md), and human-readable, so it doubles as the vehicle
  // detail/edit page's URL slug instead of the opaque database id.
  const vehicle = await getPrisma().vehicle.findUnique({
    where: { org_id_serial: { org_id: orgId, serial } },
    select: {
      id: true,
      org_id: true,
      deletedAt: true,
      serial: true,
      serialPrefix: true,
      convertedToExport: true,
      convertedToLocal: true,
      shipmentStatus: true,
      auctionItemNo: true,
      chassisNo: true,
      yom: true,
      purchaseDate: true,
      auctionLotNo: true,
      destination: true,
      hasPartnership: true,
      partnerName: true,
      deliveryDate: true,
      paidByCustomer: true,
      sellingPrice: true,
      sellingPriceCurrency: true,
      etd: true,
      eta: true,
      blNo: true,
      vesselName: true,
      shippingMethod: true,
      vanningDate: true,
      containerNumber: true,
      hasInspection: true,
      inspectionDate: true,
      massoDate: true,
      trackingNumber: true,
      lcNo: true,
      docsArrivedDate: true,
      auctionBillPaid: true,
      logBook: true,
      extraKey: true,
      nameChangeDeadline: true,
      docSentDate: true,
      docSentComment: true,
      recycleDate: true,
      jibaishake: true,
      vehicleRemark: true,
      model: { select: { id: true, name: true, brand: { select: { id: true, name: true } } } },
      grade: { select: { id: true, name: true } },
      auctionHall: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true } },
      freightAgent: { select: { id: true, name: true, offersRoro: true, offersContainer: true } },
      packingAgent: { select: { id: true, name: true } },
      transportBy: { select: { id: true, name: true } },
      vehicleLocation: { select: { id: true, name: true } },
      rowColourStatus: { select: { id: true, name: true, colour: true } },
      inspectionCompany: { select: { id: true, name: true } },
      inspectionBy: { select: { id: true, name: true } },
    },
  });

  // org_id is already part of the lookup key above, so a match is
  // guaranteed to belong to this org — only soft-delete needs checking here.
  if (!vehicle || vehicle.deletedAt !== null) return null;

  // Skip the query entirely when there's no ETD — the milestone this feeds
  // shows as not-completed in that case regardless (lib/shipment-milestones.ts),
  // so there's nothing to show a date for. Picking the latest matching row
  // (not the earliest) matters because ETD can be cleared and re-entered —
  // CLAUDE.md "Clearing ETD reverts to Pending" — which writes a fresh
  // PENDING → BOOKING_RECEIVED row each time; the latest one reflects the
  // *current* booking, not a stale one that was later reverted. Filtering to
  // trigger: "ETD_SAVED" (not just toStatus) excludes LEGACY_ENTRY rows,
  // which also land on BOOKING_RECEIVED but represent a hand-picked starting
  // status, not a real ETD-save event.
  const bookingReceivedHistory =
    vehicle.etd !== null
      ? await getPrisma().statusHistory.findFirst({
          where: { vehicleId: vehicle.id, toStatus: "BOOKING_RECEIVED", trigger: "ETD_SAVED" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        })
      : null;

  const effectiveTrack = computeEffectiveTrack(
    vehicle.serialPrefix,
    vehicle.convertedToExport,
    vehicle.convertedToLocal
  );

  return {
    id: vehicle.id,
    serial: vehicle.serial,
    track: effectiveTrack,
    convertedToExport: vehicle.convertedToExport,
    convertedToLocal: vehicle.convertedToLocal,
    // Same "computed guard on read" the vehicles table uses (see
    // computeEffectiveShipmentStatus above) — without it, this page shows
    // the raw stored status, which reads BOOKING_RECEIVED until the daily
    // cron catches up, even right after saving an ETD that's already in
    // the past (which should read as SHIPPED immediately, same as the
    // table already shows). Same treatment for Cancelled — FC only. Uses
    // the effective track, not the raw serialPrefix, so a converted vehicle
    // gets real shipment-status tracking from the moment it's converted.
    shipmentStatus: computeEffectiveShipmentStatus(
      vehicle.shipmentStatus,
      vehicle.etd,
      effectiveTrack === "FC" && isCancelShipmentRowColour(vehicle.rowColourStatus?.name)
    ),
    auctionItemNo: vehicle.auctionItemNo,
    chassisNo: vehicle.chassisNo,
    brand: vehicle.model?.brand ?? null,
    model: vehicle.model ? { id: vehicle.model.id, name: vehicle.model.name } : null,
    grade: vehicle.grade,
    yom: vehicle.yom,
    auctionHall: vehicle.auctionHall,
    supplier: vehicle.supplier,
    purchaseDate: vehicle.purchaseDate,
    auctionLotNo: vehicle.auctionLotNo,
    customer: vehicle.customer,
    destination: vehicle.destination,
    hasPartnership: vehicle.hasPartnership,
    partnerName: vehicle.partnerName,
    etd: vehicle.etd,
    bookingReceivedAt: bookingReceivedHistory?.createdAt ?? null,
    eta: vehicle.eta,
    blNo: vehicle.blNo,
    vesselName: vehicle.vesselName,
    freightAgent: vehicle.freightAgent,
    shippingMethod: vehicle.shippingMethod,
    packingAgent: vehicle.packingAgent,
    vanningDate: vehicle.vanningDate,
    containerNumber: vehicle.containerNumber,
    hasInspection: vehicle.hasInspection,
    inspectionDate: vehicle.inspectionDate,
    inspectionCompany: vehicle.inspectionCompany,
    inspectionBy: vehicle.inspectionBy,
    transportBy: vehicle.transportBy,
    vehicleLocation: vehicle.vehicleLocation,
    massoDate: vehicle.massoDate,
    trackingNumber: vehicle.trackingNumber,
    lcNo: vehicle.lcNo,
    docsArrivedDate: vehicle.docsArrivedDate,
    auctionBillPaid: vehicle.auctionBillPaid,
    logBook: vehicle.logBook,
    extraKey: vehicle.extraKey,
    nameChangeDeadline: vehicle.nameChangeDeadline,
    rowColourStatus: vehicle.rowColourStatus,
    docSentDate: vehicle.docSentDate,
    docSentComment: vehicle.docSentComment,
    recycleDate: vehicle.recycleDate,
    jibaishake: vehicle.jibaishake,
    vehicleRemark: vehicle.vehicleRemark,
    deliveryDate: vehicle.deliveryDate,
    paidByCustomer: vehicle.paidByCustomer,
    sellingPrice: vehicle.sellingPrice ? Number(vehicle.sellingPrice) : null,
    sellingPriceCurrency: vehicle.sellingPriceCurrency,
  };
}

/** Resolves a vehicle's serial (the mobile API's URL slug, same as the web
 * detail page) to its internal id, throwing the standard 404 shape instead
 * of returning null — used by routes whose downstream service function
 * (listVehicleStatusHistory, listVehicleFiles, getVehiclePdfImages) is keyed
 * by id, not serial. */
export async function resolveVehicleIdBySerial(orgId: string, serial: string): Promise<string> {
  const vehicle = await getVehicleDetail(orgId, serial);
  if (!vehicle) {
    throw new ServiceError("NOT_FOUND", "Vehicle not found.");
  }
  return vehicle.id;
}

const STATUS_HISTORY_TRIGGER_LABEL: Record<string, string> = {
  ETD_SAVED: "ETD saved",
  ETD_CLEARED: "ETD cleared",
  CRON_JOB: "Automatic — daily job",
  COMPUTED_GUARD: "Computed on read",
  LEGACY_ENTRY: "Entered manually (legacy)",
  CONVERTED_TO_EXPORT: "Converted from Local to Export",
};

export interface StatusHistoryItem {
  id: string;
  fromStatus: ShipmentStatus | null;
  toStatus: ShipmentStatus;
  triggerLabel: string;
  /** null = System (cron/computed guard, no staff action). */
  triggeredByName: string | null;
  createdAt: Date;
}

/** US-17: "every status change with who/what triggered it and when."
 * Chronological (oldest first) so the timeline UI can just render top to
 * bottom. FL vehicles never get StatusHistory rows (shipment status isn't
 * tracked for FL at all — CLAUDE.md), so this naturally comes back empty
 * for them; callers don't need a separate FC check to call it safely, just
 * to decide whether to render the section at all.
 *
 * Not currently called — the detail page's Shipment Timeline moved to the
 * operational milestone list in lib/shipment-milestones.ts (2026-08-07),
 * which better matches how staff actually track a shipment (paid / transport
 * assigned / LC open / booking received / loaded / shipped / delivered)
 * than the narrow Pending→Booking Received→Shipped enum this reads. Kept
 * for the planned "who changed it" audit view, since the underlying
 * StatusHistory rows (actor + trigger + timestamp) are exactly what that
 * needs and this query is already written for them. */
export async function listVehicleStatusHistory(orgId: string, vehicleId: string): Promise<StatusHistoryItem[]> {
  const vehicle = await getPrisma().vehicle.findFirst({
    where: { id: vehicleId, org_id: orgId, deletedAt: null },
    select: { id: true },
  });
  if (!vehicle) return [];

  const rows = await getPrisma().statusHistory.findMany({
    where: { vehicleId, vehicle: { org_id: orgId } },
    orderBy: { createdAt: "asc" },
    select: { id: true, fromStatus: true, toStatus: true, trigger: true, triggeredBy: true, createdAt: true },
  });

  const actorIds = [...new Set(rows.map((r) => r.triggeredBy).filter((id): id is string => id !== null))];
  const actors = actorIds.length
    ? await getPrisma().user.findMany({ where: { id: { in: actorIds }, org_id: orgId }, select: { id: true, name: true } })
    : [];
  const actorNameById = new Map(actors.map((a) => [a.id, a.name]));

  return rows.map((row) => ({
    id: row.id,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    triggerLabel: STATUS_HISTORY_TRIGGER_LABEL[row.trigger] ?? row.trigger,
    triggeredByName: row.triggeredBy ? (actorNameById.get(row.triggeredBy) ?? null) : null,
    createdAt: row.createdAt,
  }));
}


// ─────────────────────────────────────────────────────────────────────────
// Vehicle list query layer (Tech Doc §1/§2, US-06/07/08) — powers the main
// vehicle table: FC/FL toggle, search, per-column filters, sort, pagination.
// ─────────────────────────────────────────────────────────────────────────

// FC (or converted-to-export) vehicle whose row colour is the one that
// overrides shipment status to Cancelled — same condition
// computeEffectiveShipmentStatus checks, just expressed as a where-clause
// fragment so it can be reused as both the CANCELLED branch below and an
// exclusion on the other three branches.
const CANCELLED_WHERE: Prisma.VehicleWhereInput = {
  OR: [{ serialPrefix: "FC" }, { convertedToExport: true }],
  convertedToLocal: false,
  rowColourStatus: { name: { in: [...CANCEL_SHIPMENT_ROW_COLOUR_NAMES] } },
};

/** Same effective-status guard as computeEffectiveShipmentStatus, expressed
 * as a Prisma where-clause instead of a post-fetch check — filtering by
 * status has to agree with what's actually displayed, or a vehicle whose
 * ETD has passed but the daily cron hasn't run yet would show as "Shipped"
 * everywhere while still matching a "Booking Received" filter (and being
 * excluded from a "Shipped" one). Cancelled works the same way: a vehicle
 * whose row colour marks it Cancelled must never also match Pending/Booking
 * Received/Shipped, even though its raw stored column still says one of
 * those. Each branch is self-contained (its own OR, not the top-level one)
 * so it composes safely inside an AND array alongside the free-text
 * search's own top-level OR in buildVehicleListWhere. */
function buildEffectiveShipmentStatusWhere(status: EffectiveShipmentStatus): Prisma.VehicleWhereInput {
  if (status === "CANCELLED") {
    return CANCELLED_WHERE;
  }

  if (status === "PENDING") {
    // The guard only ever promotes BOOKING_RECEIVED -> SHIPPED; it never
    // touches PENDING, so the raw column is already correct here — aside
    // from the Cancelled override, which still needs excluding.
    return { shipmentStatus: "PENDING", NOT: CANCELLED_WHERE };
  }

  const today = todayAtMidnight();

  if (status === "SHIPPED") {
    return {
      NOT: CANCELLED_WHERE,
      OR: [
        { shipmentStatus: "SHIPPED" },
        { shipmentStatus: "BOOKING_RECEIVED", etd: { lt: today } },
      ],
    };
  }

  // BOOKING_RECEIVED: genuinely still booking-received — not past its ETD
  // yet, otherwise the guard would show it as Shipped and this filter would
  // disagree with that. Also excludes Cancelled, same reasoning as above.
  return {
    shipmentStatus: "BOOKING_RECEIVED",
    NOT: CANCELLED_WHERE,
    OR: [{ etd: null }, { etd: { gte: today } }],
  };
}

export type VehicleListSortKey =
  | "serial"
  | "chassisNo"
  | "model"
  | "yom"
  | "shipmentStatus"
  | "purchaseDate"
  | "etd"
  | "eta"
  | "destination"
  | "docsArrivedDate"
  | "nameChangeDeadline"
  | "massoDate"
  | "docSentDate"
  | "recycleDate"
  | "vesselName"
  | "deliveryDate"
  | "sellingPrice";

/** Tri-state filters need a 4th state beyond the field's own null/true/false —
 * "not filtering on this at all" is different from "filtering for blank"
 * (CLAUDE.md tri-state rule: null is a real, distinct value, never a stand-in
 * for "no filter applied"). */
export type TriStateFilterValue = "ALL" | "YES" | "NO" | "BLANK";

/** Same "not filtering" vs. "filtering" distinction as TriStateFilterValue,
 * but for genuinely two-state fields (hasPartnership, convertedToExport) that
 * are never null in the DB — no "not entered" state to represent. */
export type TwoStateFilterValue = "ALL" | "YES" | "NO";

export interface VehicleListParams {
  page: number;
  pageSize: number;
  track: SerialPrefix | "ALL";
  search: string;
  /** Multi-select — an empty array means "no filter" (every status shown),
   * matching how every other "ALL" filter here behaves. */
  shipmentStatus: EffectiveShipmentStatus[];
  destination: string | "ALL";
  /** FL only — filters to vehicles with this exact partner name. Implies
   * hasPartnership = true, since partnerName is only ever written alongside
   * it (see createVehicle/updateVehicle), so no separate clause is needed. */
  partnerName: string | "ALL";
  customerId: string | "ALL";
  rowColourStatusId: string | "ALL";
  /** Excludes one specific row colour status rather than filtering to it —
   * used by the dashboard's "In Progress" transport bar, which means
   * "everything except Transport Complete" (any other status, or none),
   * not "no colour set". Mutually exclusive with rowColourStatusId in
   * practice (nothing sets both), so if both were ever set, the equality
   * filter below takes precedence. */
  rowColourStatusIdNot: string | "ALL";
  brandId: string | "ALL";
  modelId: string | "ALL";
  gradeId: string | "ALL";
  auctionHallId: string | "ALL";
  /** FL only — alternative to auctionHallId, mutually exclusive in the data. */
  supplierId: string | "ALL";
  freightAgentId: string | "ALL";
  packingAgentId: string | "ALL";
  vehicleLocationId: string | "ALL";
  transportById: string | "ALL";
  shippingMethod: ShippingMethod | "ALL";
  auctionBillPaid: TriStateFilterValue;
  logBook: TriStateFilterValue;
  extraKey: TriStateFilterValue;
  /** FL only. */
  hasPartnership: TwoStateFilterValue;
  /** FL only — genuinely nullable in the DB (null until Sold Details is
   * filled in), unlike hasPartnership above. */
  paidByCustomer: TriStateFilterValue;
  /** FL only. */
  sellingPriceCurrency: string | "ALL";
  /** FC only — separates native FC vehicles from ones that started as FL
   * and got converted (lib/vehicle-track.ts). */
  convertedToExport: TwoStateFilterValue;
  /** FL only — mirror of convertedToExport above, for vehicles that started
   * as FC and got converted to local. */
  convertedToLocal: TwoStateFilterValue;
  /** Inclusive date-range bounds on etd/eta — FC only in practice (FL
   * vehicles never carry etd/eta), but not enforced here since a filter
   * against an always-null field on FL rows is harmless (just matches
   * nothing), same treatment every other FC-only filter gets. `null` means
   * that bound isn't set; from/to are independent, so either can be set
   * without the other. */
  etdFrom: Date | null;
  etdTo: Date | null;
  etaFrom: Date | null;
  etaTo: Date | null;
  sortBy: VehicleListSortKey;
  sortDir: "asc" | "desc";
}

export interface VehicleListRow {
  id: string;
  serial: string;
  track: SerialPrefix;
  convertedToExport: boolean;
  convertedToLocal: boolean;
  chassisNo: string | null;
  brandName: string | null;
  modelName: string | null;
  gradeName: string | null;
  yom: number | null;
  auctionItemNo: string | null;
  auctionHallName: string | null;
  supplierName: string | null;
  hasPartnership: boolean;
  partnerName: string | null;
  auctionLotNo: string | null;
  purchaseDate: Date | null;
  customerName: string | null;
  destination: string | null;
  etd: Date | null;
  eta: Date | null;
  blNo: string | null;
  vesselName: string | null;
  freightAgentName: string | null;
  shippingMethod: ShippingMethod | null;
  packingAgentName: string | null;
  vanningDate: Date | null;
  containerNumber: string | null;
  hasInspection: boolean;
  inspectionDate: Date | null;
  inspectionCompanyName: string | null;
  inspectionByName: string | null;
  transportByName: string | null;
  vehicleLocationName: string | null;
  auctionBillPaid: boolean | null;
  logBook: boolean | null;
  extraKey: boolean | null;
  docsArrivedDate: Date | null;
  nameChangeDeadline: Date | null;
  massoDate: Date | null;
  trackingNumber: string | null;
  lcNo: string | null;
  docSentDate: Date | null;
  docSentComment: string | null;
  recycleDate: Date | null;
  jibaishake: string | null;
  vehicleRemark: string | null;
  deliveryDate: Date | null;
  paidByCustomer: boolean | null;
  sellingPrice: number | null;
  sellingPriceCurrency: string | null;
  shipmentStatus: ShipmentStatus;
  effectiveShipmentStatus: EffectiveShipmentStatus;
  rowColourStatus: { id: string; name: string; colour: string; transportCellOnly: boolean } | null;
}

export interface VehicleListResult {
  rows: VehicleListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Same 3-branch mapping repeats for Auction Bill Paid/Log Book/Extra Key —
 * pulled out once rather than copy-pasted three times. */
function applyTriStateFilter(
  where: Prisma.VehicleWhereInput,
  field: "auctionBillPaid" | "logBook" | "extraKey" | "paidByCustomer",
  value: TriStateFilterValue
): void {
  if (value === "YES") where[field] = true;
  else if (value === "NO") where[field] = false;
  else if (value === "BLANK") where[field] = null;
}

function buildVehicleListWhere(orgId: string, params: VehicleListParams): Prisma.VehicleWhereInput {
  const where: Prisma.VehicleWhereInput = { org_id: orgId, deletedAt: null };
  // Collected instead of assigning where.AND directly in each block below,
  // since a later plain `where.AND = [...]` would silently overwrite an
  // earlier one — both the track and shipmentStatus conditions need their
  // own OR-group, and OR-groups can't share the top-level where.OR key
  // (that one's reserved for the free-text search further down).
  const andConditions: Prisma.VehicleWhereInput[] = [];

  // Effective track (lib/vehicle-track.ts) — a vehicle converted to export
  // (or to local, the mirror direction) belongs in that track's list from
  // that point on, even though its serialPrefix (and serial string) never
  // changes.
  if (params.track !== "ALL") {
    andConditions.push(buildTrackWhere(params.track));
  }
  if (params.shipmentStatus.length > 0) {
    // Multiple selected statuses are OR'd together (matches "PENDING or
    // SHIPPED", not "both at once", which no vehicle could ever satisfy).
    andConditions.push({ OR: params.shipmentStatus.map(buildEffectiveShipmentStatusWhere) });
  }
  if (params.rowColourStatusId === "ALL" && params.rowColourStatusIdNot !== "ALL") {
    // "Everything except X" must include vehicles with NO row colour. A plain
    // `{ not: X }` would silently drop them: SQL says NULL <> X is not true, so NULL rows
    // are excluded (verified against real Postgres in tests/db/null-semantics.db.test.ts).
    andConditions.push({
      OR: [{ rowColourStatusId: null }, { rowColourStatusId: { not: params.rowColourStatusIdNot } }],
    });
  }
  if (andConditions.length > 0) where.AND = andConditions;
  if (params.destination !== "ALL") where.destination = params.destination;
  if (params.customerId !== "ALL") where.customerId = params.customerId;
  if (params.rowColourStatusId !== "ALL") {
    where.rowColourStatusId = params.rowColourStatusId;
  }
  // Vehicle stores modelId/gradeId directly, but not brandId — brand is one
  // level up via the model relation.
  if (params.brandId !== "ALL") where.model = { brand_id: params.brandId };
  if (params.modelId !== "ALL") where.modelId = params.modelId;
  if (params.gradeId !== "ALL") where.gradeId = params.gradeId;
  if (params.auctionHallId !== "ALL") where.auctionHallId = params.auctionHallId;
  if (params.supplierId !== "ALL") where.supplierId = params.supplierId;
  if (params.freightAgentId !== "ALL") where.freightAgentId = params.freightAgentId;
  if (params.packingAgentId !== "ALL") where.packingAgentId = params.packingAgentId;
  if (params.vehicleLocationId !== "ALL") where.vehicleLocationId = params.vehicleLocationId;
  if (params.transportById !== "ALL") where.transportById = params.transportById;
  if (params.shippingMethod !== "ALL") where.shippingMethod = params.shippingMethod;
  applyTriStateFilter(where, "auctionBillPaid", params.auctionBillPaid);
  applyTriStateFilter(where, "logBook", params.logBook);
  applyTriStateFilter(where, "extraKey", params.extraKey);
  if (params.hasPartnership !== "ALL") where.hasPartnership = params.hasPartnership === "YES";
  if (params.partnerName !== "ALL") where.partnerName = params.partnerName;
  applyTriStateFilter(where, "paidByCustomer", params.paidByCustomer);
  if (params.sellingPriceCurrency !== "ALL") where.sellingPriceCurrency = params.sellingPriceCurrency;
  if (params.convertedToExport !== "ALL") where.convertedToExport = params.convertedToExport === "YES";
  if (params.convertedToLocal !== "ALL") where.convertedToLocal = params.convertedToLocal === "YES";
  if (params.etdFrom || params.etdTo) {
    where.etd = {
      ...(params.etdFrom ? { gte: params.etdFrom } : {}),
      ...(params.etdTo ? { lte: params.etdTo } : {}),
    };
  }
  if (params.etaFrom || params.etaTo) {
    where.eta = {
      ...(params.etaFrom ? { gte: params.etaFrom } : {}),
      ...(params.etaTo ? { lte: params.etaTo } : {}),
    };
  }

  // US-08: free-text search matches serial, chassis, auction item/lot no,
  // brand/model/grade, supplier, partner name, vessel name, BL/LC number,
  // and customer name — everything else is a dedicated per-column filter,
  // not free text.
  // Customer also has its own dedicated filter dropdown (params.customerId
  // above, search-as-you-type since the list can get large) — kept in
  // search too so typing a customer's name works without opening that
  // dropdown first.
  const search = params.search.trim();
  if (search) {
    where.OR = [
      { serial: { contains: search, mode: "insensitive" } },
      { chassisNo: { contains: search, mode: "insensitive" } },
      { auctionItemNo: { contains: search, mode: "insensitive" } },
      { auctionLotNo: { contains: search, mode: "insensitive" } },
      { model: { name: { contains: search, mode: "insensitive" } } },
      { model: { brand: { name: { contains: search, mode: "insensitive" } } } },
      { grade: { name: { contains: search, mode: "insensitive" } } },
      { customer: { name: { contains: search, mode: "insensitive" } } },
      { supplier: { name: { contains: search, mode: "insensitive" } } },
      { partnerName: { contains: search, mode: "insensitive" } },
      { vesselName: { contains: search, mode: "insensitive" } },
      { blNo: { contains: search, mode: "insensitive" } },
      { lcNo: { contains: search, mode: "insensitive" } },
    ];
  }

  return where;
}

function buildVehicleListOrderBy(
  sortBy: VehicleListSortKey,
  sortDir: "asc" | "desc"
): Prisma.VehicleOrderByWithRelationInput[] {
  switch (sortBy) {
    case "serial":
      // Sort the real numeric column, not the display string (avoids "FC10"
      // sorting before "FC9"). Deliberately NOT grouped by serialPrefix first
      // — a vehicle converted to export (lib/vehicle-track.ts) keeps its
      // original FL-prefixed serial forever, and grouping by prefix would
      // permanently rank every converted vehicle above every native FC
      // vehicle regardless of serial number, since FL's enum ordinal always
      // beats FC's under "desc" — vehicles converted to export would get
      // stuck at the top of the list forever.
      return [{ serialNumber: sortDir }];
    case "chassisNo":
      return [{ chassisNo: sortDir }];
    case "model":
      return [{ model: { name: sortDir } }];
    case "yom":
      return [{ yom: sortDir }];
    case "shipmentStatus":
      return [{ shipmentStatus: sortDir }];
    case "purchaseDate":
      return [{ purchaseDate: sortDir }];
    case "etd":
      return [{ etd: sortDir }];
    case "eta":
      return [{ eta: sortDir }];
    case "destination":
      return [{ destination: sortDir }];
    case "docsArrivedDate":
      return [{ docsArrivedDate: sortDir }];
    case "nameChangeDeadline":
      return [{ nameChangeDeadline: sortDir }];
    case "massoDate":
      return [{ massoDate: sortDir }];
    case "docSentDate":
      return [{ docSentDate: sortDir }];
    case "recycleDate":
      return [{ recycleDate: sortDir }];
    case "vesselName":
      return [{ vesselName: sortDir }];
    case "deliveryDate":
      return [{ deliveryDate: sortDir }];
    case "sellingPrice":
      return [{ sellingPrice: sortDir }];
  }
}

const VEHICLE_LIST_SELECT = {
  id: true,
  serial: true,
  serialPrefix: true,
  convertedToExport: true,
  convertedToLocal: true,
  chassisNo: true,
  auctionItemNo: true,
  auctionLotNo: true,
  yom: true,
  purchaseDate: true,
  destination: true,
  hasPartnership: true,
  partnerName: true,
  deliveryDate: true,
  paidByCustomer: true,
  sellingPrice: true,
  sellingPriceCurrency: true,
  etd: true,
  eta: true,
  blNo: true,
  vesselName: true,
  shippingMethod: true,
  vanningDate: true,
  containerNumber: true,
  hasInspection: true,
  inspectionDate: true,
  auctionBillPaid: true,
  logBook: true,
  extraKey: true,
  docsArrivedDate: true,
  nameChangeDeadline: true,
  massoDate: true,
  trackingNumber: true,
  lcNo: true,
  docSentDate: true,
  docSentComment: true,
  recycleDate: true,
  jibaishake: true,
  vehicleRemark: true,
  shipmentStatus: true,
  model: { select: { name: true, brand: { select: { name: true } } } },
  grade: { select: { name: true } },
  auctionHall: { select: { name: true } },
  supplier: { select: { name: true } },
  customer: { select: { name: true } },
  freightAgent: { select: { name: true } },
  packingAgent: { select: { name: true } },
  transportBy: { select: { name: true } },
  vehicleLocation: { select: { name: true } },
  rowColourStatus: { select: { id: true, name: true, colour: true, transportCellOnly: true } },
  inspectionCompany: { select: { name: true } },
  inspectionBy: { select: { name: true } },
} satisfies Prisma.VehicleSelect;

type VehicleListRawRow = Prisma.VehicleGetPayload<{ select: typeof VEHICLE_LIST_SELECT }>;

function toVehicleListRow(v: VehicleListRawRow): VehicleListRow {
  const effectiveTrack = computeEffectiveTrack(v.serialPrefix, v.convertedToExport, v.convertedToLocal);
  return {
    id: v.id,
    serial: v.serial,
    track: effectiveTrack,
    convertedToExport: v.convertedToExport,
    convertedToLocal: v.convertedToLocal,
    chassisNo: v.chassisNo,
    brandName: v.model?.brand.name ?? null,
    modelName: v.model?.name ?? null,
    gradeName: v.grade?.name ?? null,
    yom: v.yom,
    auctionItemNo: v.auctionItemNo,
    auctionHallName: v.auctionHall?.name ?? null,
    supplierName: v.supplier?.name ?? null,
    auctionLotNo: v.auctionLotNo,
    purchaseDate: v.purchaseDate,
    customerName: v.customer?.name ?? null,
    destination: v.destination,
    hasPartnership: v.hasPartnership,
    partnerName: v.partnerName,
    etd: v.etd,
    eta: v.eta,
    blNo: v.blNo,
    vesselName: v.vesselName,
    freightAgentName: v.freightAgent?.name ?? null,
    shippingMethod: v.shippingMethod,
    packingAgentName: v.packingAgent?.name ?? null,
    vanningDate: v.vanningDate,
    containerNumber: v.containerNumber,
    hasInspection: v.hasInspection,
    inspectionDate: v.inspectionDate,
    inspectionCompanyName: v.inspectionCompany?.name ?? null,
    inspectionByName: v.inspectionBy?.name ?? null,
    transportByName: v.transportBy?.name ?? null,
    vehicleLocationName: v.vehicleLocation?.name ?? null,
    auctionBillPaid: v.auctionBillPaid,
    logBook: v.logBook,
    extraKey: v.extraKey,
    docsArrivedDate: v.docsArrivedDate,
    nameChangeDeadline: v.nameChangeDeadline,
    massoDate: v.massoDate,
    trackingNumber: v.trackingNumber,
    lcNo: v.lcNo,
    docSentDate: v.docSentDate,
    docSentComment: v.docSentComment,
    recycleDate: v.recycleDate,
    jibaishake: v.jibaishake,
    vehicleRemark: v.vehicleRemark,
    deliveryDate: v.deliveryDate,
    paidByCustomer: v.paidByCustomer,
    sellingPrice: v.sellingPrice ? Number(v.sellingPrice) : null,
    sellingPriceCurrency: v.sellingPriceCurrency,
    shipmentStatus: v.shipmentStatus,
    effectiveShipmentStatus: computeEffectiveShipmentStatus(
      v.shipmentStatus,
      v.etd,
      effectiveTrack === "FC" && isCancelShipmentRowColour(v.rowColourStatus?.name)
    ),
    rowColourStatus: v.rowColourStatus,
  };
}

export async function listVehicles(
  orgId: string,
  params: VehicleListParams
): Promise<VehicleListResult> {
  const where = buildVehicleListWhere(orgId, params);
  const skip = (params.page - 1) * params.pageSize;

  // Shipment Status can't be sorted with a DB-level ORDER BY: the column
  // only ever holds the 3 storable values, but the table displays (and
  // this sort has to match) the *effective* status — also dependent on ETD
  // and the cancel-triggering row colours (CANCEL_SHIPMENT_ROW_COLOUR_NAMES),
  // a JS-computed value with no real column behind it (see
  // lib/shipment-status.ts). So this one sort key
  // fetches every matching row instead of a single DB page, sorts by the
  // same computeEffectiveShipmentStatus the table renders, then paginates
  // in memory. Fine at this app's scale (Phase 1, single org, 6-8 staff);
  // every other sort key still does a normal DB ORDER BY + LIMIT/OFFSET.
  if (params.sortBy === "shipmentStatus") {
    const [total, allVehicles] = await Promise.all([
      getPrisma().vehicle.count({ where }),
      getPrisma().vehicle.findMany({ where, select: VEHICLE_LIST_SELECT }),
    ]);
    const sortDirMultiplier = params.sortDir === "asc" ? 1 : -1;
    const rows = allVehicles
      .map(toVehicleListRow)
      .sort(
        (a, b) =>
          sortDirMultiplier *
          (SHIPMENT_STATUS_ORDER.indexOf(a.effectiveShipmentStatus) -
            SHIPMENT_STATUS_ORDER.indexOf(b.effectiveShipmentStatus))
      )
      .slice(skip, skip + params.pageSize);

    return {
      rows,
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    };
  }

  const orderBy = buildVehicleListOrderBy(params.sortBy, params.sortDir);

  const [total, vehicles] = await Promise.all([
    getPrisma().vehicle.count({ where }),
    getPrisma().vehicle.findMany({
      where,
      orderBy,
      skip,
      take: params.pageSize,
      select: VEHICLE_LIST_SELECT,
    }),
  ]);

  const rows: VehicleListRow[] = vehicles.map(toVehicleListRow);

  return {
    rows,
    total,
    page: params.page,
    pageSize: params.pageSize,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}

/** Distinct, non-null destinations actually in use — powers the Destination
 * filter dropdown so it only ever lists values that exist. */
export async function listDistinctDestinations(
  orgId: string,
  track?: TrackFilter
): Promise<string[]> {
  const rows = await getPrisma().vehicle.findMany({
    where: {
      org_id: orgId,
      deletedAt: null,
      destination: { not: null },
      // Optional so the mobile endpoint keeps returning every destination;
      // the web filter bar passes the active tab so it only offers
      // destinations that tab actually has vehicles for.
      ...(track && { AND: [buildTrackWhere(track)] }),
    },
    select: { destination: true },
    distinct: ["destination"],
    orderBy: { destination: "asc" },
  });
  return rows.map((row) => row.destination).filter((d): d is string => d !== null);
}

/** Distinct, non-null partner names actually in use — powers the FL tab's
 * Partner Name filter dropdown, same pattern as listDistinctDestinations
 * above. A vehicle only ever has a partnerName when hasPartnership is true
 * (see createVehicle/updateVehicle), so this list is implicitly already
 * scoped to partnered vehicles. */
export async function listDistinctPartnerNames(
  orgId: string,
  track?: TrackFilter
): Promise<string[]> {
  const rows = await getPrisma().vehicle.findMany({
    where: {
      org_id: orgId,
      deletedAt: null,
      partnerName: { not: null },
      ...(track && { AND: [buildTrackWhere(track)] }),
    },
    select: { partnerName: true },
    distinct: ["partnerName"],
    orderBy: { partnerName: "asc" },
  });
  return rows.map((row) => row.partnerName).filter((p): p is string => p !== null);
}

export interface VehicleFilterOptions {
  tracks: { value: SerialPrefix; label: string }[];
  shipmentStatuses: { value: EffectiveShipmentStatus; label: string }[];
  shippingMethods: ShippingMethod[];
  // TRI_STATE_VALUES/TWO_STATE_VALUES (lib/vehicle-list-url.ts) are typed
  // against the full TriStateFilterValue/TwoStateFilterValue unions (which
  // also include "ALL", the "no filter selected" sentinel) even though
  // their actual contents never include it — matching that type here
  // rather than a hand-narrowed one keeps this in sync with the source
  // arrays without a cast.
  triStateValues: TriStateFilterValue[];
  twoStateValues: TwoStateFilterValue[];
  soldCurrencies: string[];
}

/** The fixed/enum option sets the vehicle list filter panel offers
 * (components/vehicles/vehicle-filters-panel.tsx,
 * vehicle-filters-bar.tsx) that aren't stored in the DB and so have no
 * other lookup endpoint — a mobile client would otherwise have to
 * hardcode these and risk drifting from the web app if they ever change.
 * Not org-scoped (nothing here depends on org data) and takes no params —
 * every value it returns is a compile-time constant already owned
 * elsewhere in this codebase (lib/constants/shipment-status.ts,
 * lib/vehicle-list-url.ts), just assembled into one response. Searchable
 * lookups (brand/model/grade/auction hall/supplier/freight agent/packing
 * agent/vehicle location/transport company) are deliberately NOT included
 * here — those are DB-backed and paginated, so they stay on their own
 * /api/v1/lookups/* search endpoints instead of being dumped in full. */
export function getVehicleFilterOptions(): VehicleFilterOptions {
  return {
    tracks: [
      { value: "FC", label: "FC — Export" },
      { value: "FL", label: "FL — Local" },
    ],
    shipmentStatuses: SHIPMENT_STATUS_ORDER.map((value) => ({
      value,
      label: SHIPMENT_STATUS_META[value].label,
    })),
    shippingMethods: [...SHIPPING_METHODS],
    triStateValues: [...TRI_STATE_VALUES],
    twoStateValues: [...TWO_STATE_VALUES],
    soldCurrencies: [...SOLD_CURRENCIES],
  };
}
