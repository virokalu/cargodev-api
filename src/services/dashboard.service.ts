// Dashboard stats — Tech Doc §7/§7.1, US-31 through US-35 and US-43. Every
// query is org-scoped and excludes soft-deleted vehicles, same as the
// vehicle list query layer (vehicle.service.ts).

import type { Prisma, ShipmentStatus, ShippingMethod } from "@prisma/client";
import { getPrisma } from "../lib/prisma.js";
import {
  computeEffectiveShipmentStatus,
  isCancelShipmentRowColour,
  CANCEL_SHIPMENT_ROW_COLOUR_NAMES,
} from "../lib/shipment-status.js";

// Effective track (lib/vehicle-track.ts) — an FL vehicle converted to
// export counts as FC in every FC-only KPI below, from the moment it's
// converted, even though its serialPrefix never changes.
const TRACK_FC_OR_CONVERTED: Prisma.VehicleWhereInput = {
  OR: [{ serialPrefix: "FC" }, { convertedToExport: true }],
};

/** Every lookup-based distribution below carries an id alongside the display
 * name — the dashboard charts link each slice/bar straight to that exact
 * value on the vehicles table, which needs the id, not just the label. */
export interface IdNameCount {
  id: string;
  name: string;
  count: number;
}

// Shared by both KPI popups (Pending Shipping, Unpaid Auction Bills) — same
// three at-a-glance details either way: what the vehicle is, how old, and
// whose it is.
export interface VehicleSummary {
  id: string;
  serial: string;
  brand: string | null;
  model: string | null;
  yom: number | null;
  customerName: string | null;
}

export interface DashboardStats {
  totalVehicles: number;
  pendingFc: number;
  bookingReceivedFc: number;
  shippedFc: number;
  pendingVehicles: VehicleSummary[];
  bookingReceivedVehicles: VehicleSummary[];
  trackSplit: { fc: number; fl: number };
  shipmentStatusDistribution: { status: ShipmentStatus; count: number }[];
  exportVolumeByDestination: { destination: string; count: number }[];
  transportByCompany: { id: string; company: string; complete: number; inProgress: number }[];
  transportCompleteStatusId: string | null;
  vehicleLocationDistribution: IdNameCount[];
  transportByDistribution: IdNameCount[];
  freightAgentDistribution: IdNameCount[];
  shippingMethodDistribution: { method: ShippingMethod; count: number }[];
  brandDistribution: IdNameCount[];
  unpaidAuctionBills: VehicleSummary[];
}

const STATUS_ORDER: ShipmentStatus[] = ["PENDING", "BOOKING_RECEIVED", "SHIPPED"];

/** Shared by every "count vehicles grouped by a related lookup" widget
 * (Vehicle Location, Transport By, Freight Agent, Brand) — same
 * tally-then-sort shape each time, just fed a different relation's rows. */
function tallyByIdName(items: ({ id: string; name: string } | null | undefined)[]): IdNameCount[] {
  const tally = new Map<string, IdNameCount>();
  for (const item of items) {
    if (!item) continue;
    const entry = tally.get(item.id) ?? { id: item.id, name: item.name, count: 0 };
    entry.count += 1;
    tally.set(item.id, entry);
  }
  return Array.from(tally.values()).sort((a, b) => b.count - a.count);
}

export async function getDashboardStats(orgId: string): Promise<DashboardStats> {
  const baseWhere = { org_id: orgId, deletedAt: null };

  const [
    totalVehicles,
    fcCount,
    fcStatusRows,
    exportDestinationGroups,
    transportRows,
    vehicleLocationRows,
    freightAgentRows,
    shippingMethodGroups,
    brandRows,
    unpaidBills,
  ] = await Promise.all([
    getPrisma().vehicle.count({ where: baseWhere }),
    // Effective track (lib/vehicle-track.ts) — an FL vehicle converted to
    // export counts as FC here too. flCount below is just totalVehicles
    // minus this, so it stays correct without a second query.
    getPrisma().vehicle.count({ where: { ...baseWhere, ...TRACK_FC_OR_CONVERTED } }),
    getPrisma().vehicle.findMany({
      where: { ...baseWhere, ...TRACK_FC_OR_CONVERTED },
      select: {
        id: true,
        serial: true,
        shipmentStatus: true,
        etd: true,
        yom: true,
        model: { select: { name: true, brand: { select: { name: true } } } },
        customer: { select: { name: true } },
        rowColourStatus: { select: { name: true } },
      },
    }),
    getPrisma().vehicle.groupBy({
      by: ["destination"],
      where: { ...baseWhere, ...TRACK_FC_OR_CONVERTED, destination: { not: null } },
      _count: true,
    }),
    getPrisma().vehicle.findMany({
      where: { ...baseWhere, transportById: { not: null } },
      select: {
        transportBy: { select: { id: true, name: true } },
        rowColourStatus: { select: { id: true, transportCellOnly: true } },
      },
    }),
    getPrisma().vehicle.findMany({
      where: { ...baseWhere, vehicleLocationId: { not: null } },
      select: { vehicleLocation: { select: { id: true, name: true } } },
    }),
    getPrisma().vehicle.findMany({
      where: { ...baseWhere, freightAgentId: { not: null } },
      select: { freightAgent: { select: { id: true, name: true } } },
    }),
    getPrisma().vehicle.groupBy({
      by: ["shippingMethod"],
      where: { ...baseWhere, shippingMethod: { not: null } },
      _count: true,
    }),
    getPrisma().vehicle.findMany({
      where: { ...baseWhere, modelId: { not: null } },
      select: { model: { select: { brand: { select: { id: true, name: true } } } } },
    }),
    getPrisma().vehicle.findMany({
      where: {
        ...baseWhere,
        OR: [{ auctionBillPaid: null }, { auctionBillPaid: false }],
        // A cancelled deal's unpaid bill isn't something staff need chasing
        // anymore — excluded at the query level so it's reflected in both
        // the KPI count and the popup list.
        NOT: { rowColourStatus: { name: { in: [...CANCEL_SHIPMENT_ROW_COLOUR_NAMES] } } },
      },
      select: {
        id: true,
        serial: true,
        yom: true,
        model: { select: { name: true, brand: { select: { name: true } } } },
        customer: { select: { name: true } },
      },
      orderBy: { serial: "asc" },
      // No `take` here (same as the Pending Shipping query above) — this
      // powers both the KPI card's count (unpaidAuctionBills.length) and
      // its popup list, so capping it would silently undercount the badge
      // and truncate the list with no "+N more" indicator once the real
      // total passed the cap. Confirmed bug: it was previously capped at
      // 15, so the card stuck at "15" forever regardless of the real count.
    }),
  ]);

  const trackSplit = { fc: fcCount, fl: totalVehicles - fcCount };

  // Shipment status is derived and has a known staleness window (the daily
  // cron hasn't flipped BOOKING_RECEIVED -> SHIPPED yet even though today is
  // past ETD) — the vehicle list corrects for this on read via
  // computeEffectiveShipmentStatus, so the dashboard counts do the same
  // instead of trusting the raw stored column.
  const statusTally: Record<ShipmentStatus, number> = {
    PENDING: 0,
    BOOKING_RECEIVED: 0,
    SHIPPED: 0,
  };
  const pendingVehicles: VehicleSummary[] = [];
  const bookingReceivedVehicles: VehicleSummary[] = [];
  for (const row of fcStatusRows) {
    const cancelled = isCancelShipmentRowColour(row.rowColourStatus?.name);
    const effective = computeEffectiveShipmentStatus(row.shipmentStatus, row.etd, cancelled);
    // Cancelled vehicles aren't Pending, Booking Received, or Shipped —
    // they don't belong in any of these three dashboard buckets.
    if (effective === "CANCELLED") continue;
    statusTally[effective]++;
    const summary: VehicleSummary = {
      id: row.id,
      serial: row.serial,
      brand: row.model?.brand?.name ?? null,
      model: row.model?.name ?? null,
      yom: row.yom,
      customerName: row.customer?.name ?? null,
    };
    if (effective === "PENDING") pendingVehicles.push(summary);
    else if (effective === "BOOKING_RECEIVED") bookingReceivedVehicles.push(summary);
  }
  pendingVehicles.sort((a, b) => a.serial.localeCompare(b.serial));
  bookingReceivedVehicles.sort((a, b) => a.serial.localeCompare(b.serial));
  const shipmentStatusDistribution = STATUS_ORDER.map((status) => ({
    status,
    count: statusTally[status],
  })).filter((entry) => entry.count > 0);

  const exportVolumeByDestination = exportDestinationGroups
    .map((group) => ({ destination: group.destination as string, count: group._count }))
    .sort((a, b) => b.count - a.count);

  // Complete/In-Progress split by company, plus the id of the org's
  // Transport-Complete row colour status (captured off whichever row hits
  // it first) — the dashboard's "Complete" bar segment links to
  // ?transport=<id>&rowColour=<transportCompleteStatusId>, so both ids need
  // to survive the tally, not just the display names.
  const transportTally = new Map<string, { id: string; company: string; complete: number; inProgress: number }>();
  let transportCompleteStatusId: string | null = null;
  for (const row of transportRows) {
    const company = row.transportBy;
    if (!company) continue;
    const entry = transportTally.get(company.id) ?? { id: company.id, company: company.name, complete: 0, inProgress: 0 };
    if (row.rowColourStatus?.transportCellOnly) {
      entry.complete++;
      transportCompleteStatusId ??= row.rowColourStatus.id;
    } else {
      entry.inProgress++;
    }
    transportTally.set(company.id, entry);
  }
  const transportByCompany = Array.from(transportTally.values());

  const vehicleLocationDistribution = tallyByIdName(vehicleLocationRows.map((v) => v.vehicleLocation));
  const transportByDistribution = tallyByIdName(transportRows.map((v) => v.transportBy));
  const freightAgentDistribution = tallyByIdName(freightAgentRows.map((v) => v.freightAgent));
  const brandDistribution = tallyByIdName(brandRows.map((v) => v.model?.brand));

  const shippingMethodDistribution = shippingMethodGroups
    .map((group) => ({ method: group.shippingMethod as ShippingMethod, count: group._count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalVehicles,
    pendingFc: statusTally.PENDING,
    bookingReceivedFc: statusTally.BOOKING_RECEIVED,
    shippedFc: statusTally.SHIPPED,
    pendingVehicles,
    bookingReceivedVehicles,
    trackSplit,
    shipmentStatusDistribution,
    exportVolumeByDestination,
    transportByCompany,
    transportCompleteStatusId,
    vehicleLocationDistribution,
    transportByDistribution,
    freightAgentDistribution,
    shippingMethodDistribution,
    brandDistribution,
    unpaidAuctionBills: unpaidBills.map((v) => ({
      id: v.id,
      serial: v.serial,
      brand: v.model?.brand?.name ?? null,
      model: v.model?.name ?? null,
      yom: v.yom,
      customerName: v.customer?.name ?? null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Trend charts (§7.1) — added post-spec, US-43. Four selectable monthly
// time series, all bucketed in JS (Prisma has no native "group by month",
// and raw SQL is off the table per CLAUDE.md rule 3) via a "YYYY-MM" key.
// ─────────────────────────────────────────────────────────────────────────

export interface BookingsVsArrivalsPoint {
  month: string;
  bookings: number;
  arrivals: number;
}

export interface VehiclesEnteredPoint {
  month: string;
  count: number;
}

export interface CumulativeGrowthPoint {
  month: string;
  total: number;
}

export interface DocsTurnaroundPoint {
  month: string;
  avgDays: number;
}

export interface DashboardTrends {
  bookingsVsArrivals: BookingsVsArrivalsPoint[];
  vehiclesEntered: VehiclesEnteredPoint[];
  cumulativeGrowth: CumulativeGrowthPoint[];
  docsTurnaround: DocsTurnaroundPoint[];
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** "2026-05" -> "May 2026" — sorts correctly as a string (zero-padded month)
 * but reads naturally once resolved back to a label for the chart axis. */
function monthLabel(key: string): string {
  const [year = 0, month = 1] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export async function getDashboardTrends(orgId: string): Promise<DashboardTrends> {
  const baseWhere = { org_id: orgId, deletedAt: null };

  const [fcDateRows, createdRows, docsRows] = await Promise.all([
    getPrisma().vehicle.findMany({
      where: { ...baseWhere, ...TRACK_FC_OR_CONVERTED },
      select: { etd: true, eta: true },
    }),
    getPrisma().vehicle.findMany({ where: baseWhere, select: { createdAt: true } }),
    getPrisma().vehicle.findMany({
      where: { ...baseWhere, purchaseDate: { not: null }, docsArrivedDate: { not: null } },
      select: { purchaseDate: true, docsArrivedDate: true },
    }),
  ]);

  // Bookings vs Arrivals — FC only, ETD month vs ETA month.
  const bookingsTally = new Map<string, number>();
  const arrivalsTally = new Map<string, number>();
  for (const row of fcDateRows) {
    if (row.etd) bookingsTally.set(monthKey(row.etd), (bookingsTally.get(monthKey(row.etd)) ?? 0) + 1);
    if (row.eta) arrivalsTally.set(monthKey(row.eta), (arrivalsTally.get(monthKey(row.eta)) ?? 0) + 1);
  }
  const bookingsArrivalsMonths = Array.from(
    new Set([...bookingsTally.keys(), ...arrivalsTally.keys()])
  ).sort();
  const bookingsVsArrivals = bookingsArrivalsMonths.map((key) => ({
    month: monthLabel(key),
    bookings: bookingsTally.get(key) ?? 0,
    arrivals: arrivalsTally.get(key) ?? 0,
  }));

  // Vehicles entered — all vehicles, by createdAt month.
  const enteredTally = new Map<string, number>();
  for (const row of createdRows) {
    const key = monthKey(row.createdAt);
    enteredTally.set(key, (enteredTally.get(key) ?? 0) + 1);
  }
  const enteredMonths = Array.from(enteredTally.keys()).sort();
  const vehiclesEntered = enteredMonths.map((key) => ({
    month: monthLabel(key),
    count: enteredTally.get(key) ?? 0,
  }));

  // Cumulative growth — same monthly counts as above, running total.
  let runningTotal = 0;
  const cumulativeGrowth = vehiclesEntered.map((point) => {
    runningTotal += point.count;
    return { month: point.month, total: runningTotal };
  });

  // Docs turnaround — average days from purchaseDate to docsArrivedDate,
  // bucketed by the month docs actually arrived in.
  const turnaroundTally = new Map<string, { totalDays: number; count: number }>();
  for (const row of docsRows) {
    const days = Math.round(
      (row.docsArrivedDate!.getTime() - row.purchaseDate!.getTime()) / (1000 * 60 * 60 * 24)
    );
    const key = monthKey(row.docsArrivedDate!);
    const entry = turnaroundTally.get(key) ?? { totalDays: 0, count: 0 };
    entry.totalDays += days;
    entry.count += 1;
    turnaroundTally.set(key, entry);
  }
  const turnaroundMonths = Array.from(turnaroundTally.keys()).sort();
  const docsTurnaround = turnaroundMonths.map((key) => {
    const entry = turnaroundTally.get(key)!;
    return { month: monthLabel(key), avgDays: Math.round(entry.totalDays / entry.count) };
  });

  return { bookingsVsArrivals, vehiclesEntered, cumulativeGrowth, docsTurnaround };
}
