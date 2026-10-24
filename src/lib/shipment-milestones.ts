// Operational shipment milestones for the vehicle detail page's Shipment
// Timeline (distinct from ShipmentStatus/StatusHistory — those track the 3
// stored Pending/Booking Received/Shipped values used everywhere else in
// the app: table, dashboard, filters, badges. This is a separate, richer
// progress view specific to the detail page, derived purely from fields
// already on the vehicle — no DB read of its own, no write path, nothing
// stored. Who/when changed each field is a future "auth log" feature
// (StatusHistory-adjacent, not built yet) — this only tracks *whether* and
// *when the underlying date field says* each step happened.
//
// Pure + framework-agnostic like lib/shipment-status.ts, so both the
// server page and (if ever needed) a client preview can share it.

import { todayAtMidnight } from "./shipment-status.js";

export type ShipmentMilestoneKey =
  | "AUCTION_BILL_PAID"
  | "TRANSPORT_ASSIGNED"
  | "EC_RECEIVED"
  | "INSPECTION_COMPLETED"
  | "LC_OPEN"
  | "BOOKING_RECEIVED"
  | "LOADED"
  | "SHIPPED"
  | "DELIVERED";

export interface ShipmentMilestone {
  key: ShipmentMilestoneKey;
  label: string;
  completed: boolean;
  /** The date this milestone actually completed, when known — null while
   * not yet completed, and also null for the two flag-based steps
   * (Auction Bill Paid, Transport Assigned) since neither has its own
   * dated column, just a value that's set or not. */
  date: Date | null;
}

export interface ShipmentMilestoneInput {
  auctionBillPaid: boolean | null;
  transportBy: { id: string; name: string } | null;
  lcNo: string | null;
  etd: Date | null;
  /** When ETD was actually saved (a StatusHistory row), not the ETD value
   * itself — drives the Booking Received milestone's date instead of etd.
   * null for legacy-entry vehicles with no such row, in which case the
   * milestone falls back to etd (see below). */
  bookingReceivedAt: Date | null;
  eta: Date | null;
  destination: string | null;
  /** Unlike every other field here, this doesn't live on Vehicle directly —
   * it's the earliest createdAt among the vehicle's EC-type VehicleDocument
   * rows (documentType "EC"), resolved by the caller. Completed the moment
   * an EC is uploaded, same shape as etd/eta: null = not yet, a Date = when. */
  ecReceivedAt: Date | null;
  /** Same shape as ecReceivedAt — earliest createdAt among the vehicle's
   * Inspection Report-type VehicleDocument rows (documentType
   * "INSPECTION_REPORT"), resolved by the caller. Completed the moment an
   * inspection report is uploaded. */
  inspectionCompletedAt: Date | null;
  /** Loaded only applies to Container shipments — RORO has no loaded step. */
  shippingMethod: "RORO" | "CONTAINER" | null;
  /** Container only — when the vehicle was loaded into its container. Drives
   * the Loaded milestone the same way etd drives Booking Received. */
  vanningDate: Date | null;
}

// LC Open only applies when shipping to Sri Lanka or Bangladesh — matches
// world-countries' common names, the same strings the Destination field's
// CountrySelect stores (see lib/constants/countries.ts). Exported so other
// LC-aware logic (lib/services/reminder.service.ts's LC reminder + missing-
// document check) reuses this exact set instead of re-declaring it.
export const LC_OPEN_DESTINATIONS = new Set(["Sri Lanka", "Bangladesh"]);

/** EC Received sits between Transport Assigned and Booking Received in the
 * real physical process — completed the moment an EC-type document is
 * uploaded (see ShipmentMilestoneInput.ecReceivedAt). */
export function buildShipmentMilestones(input: ShipmentMilestoneInput): ShipmentMilestone[] {
  const today = todayAtMidnight();
  const etdPassed = input.etd !== null && input.etd.getTime() < today.getTime();
  const etaPassed = input.eta !== null && input.eta.getTime() < today.getTime();
  const vanningDatePassed = input.vanningDate !== null && input.vanningDate.getTime() < today.getTime();

  const milestones: ShipmentMilestone[] = [
    { key: "AUCTION_BILL_PAID", label: "Auction Bill Paid", completed: input.auctionBillPaid === true, date: null },
    { key: "TRANSPORT_ASSIGNED", label: "Rikso Given", completed: input.transportBy !== null, date: null },
    {
      key: "EC_RECEIVED",
      label: "EC Received",
      completed: input.ecReceivedAt !== null,
      date: input.ecReceivedAt,
    },
  ];

  // Unlike the other steps, Inspection Completed only appears once it's
  // actually done — not every vehicle gets an inspection report, so showing
  // it as a permanent "not yet" step would clutter the timeline for ones
  // that will never get one. It never shows as the upcoming/next step;
  // it just appears in its normal spot in the sequence the moment a report
  // is uploaded.
  if (input.inspectionCompletedAt !== null) {
    milestones.push({
      key: "INSPECTION_COMPLETED",
      label: "Inspection Completed",
      completed: true,
      date: input.inspectionCompletedAt,
    });
  }

  if (input.destination && LC_OPEN_DESTINATIONS.has(input.destination)) {
    milestones.push({ key: "LC_OPEN", label: "LC Open", completed: !!input.lcNo, date: null });
  }

  milestones.push({
    key: "BOOKING_RECEIVED",
    label: "Booking Received",
    completed: input.etd !== null,
    date: input.bookingReceivedAt ?? input.etd,
  });

  // Loaded only applies to Container shipments — RORO vehicles never get
  // vanned into a container, so they skip straight from Booking Received to
  // Shipped. Driven by vanningDate passing, same "date passing" trigger
  // Shipped/Delivered already use below (not just "vanningDate is set").
  if (input.shippingMethod === "CONTAINER") {
    milestones.push({
      key: "LOADED",
      label: "Loaded",
      completed: vanningDatePassed,
      date: vanningDatePassed ? input.vanningDate : null,
    });
  }

  milestones.push(
    { key: "SHIPPED", label: "Shipped", completed: etdPassed, date: etdPassed ? input.etd : null },
    { key: "DELIVERED", label: "Delivered", completed: etaPassed, date: etaPassed ? input.eta : null }
  );

  return milestones;
}
