// Shared shipment-status display metadata — used by the Add Vehicle form
// (manual status picker for legacy records) and the vehicle table (status
// column). One source of truth so the colours never drift between screens.
//
// CANCELLED is not a real stored value (the underlying Vehicle.shipmentStatus
// column, and the DB enum backing it, only ever hold the three statuses
// below) — it's a computed display-only status shown whenever an FC
// vehicle's row colour is one of CANCEL_SHIPMENT_ROW_COLOUR_NAMES ("Unit
// Canceled", "Resold in Auction"), exactly like the existing
// BOOKING_RECEIVED -> SHIPPED "computed guard on read" never writes to the
// column either. See lib/shipment-status.ts.

/** The statuses that can actually be stored (and picked manually for a
 * legacy record) — matches the Prisma ShipmentStatus enum column exactly.
 * CANCELLED is deliberately not part of this type: it's never a real column
 * value, so anything that only ever deals with the stored/storable status
 * (the ETD-transition logic, the manual legacy picker) is typed against
 * this narrower type instead of the full ShipmentStatus below. */
export type StorableShipmentStatus = "PENDING" | "BOOKING_RECEIVED" | "SHIPPED";

export type ShipmentStatus = StorableShipmentStatus | "CANCELLED";

export const STORABLE_SHIPMENT_STATUSES: StorableShipmentStatus[] = [
  "PENDING",
  "BOOKING_RECEIVED",
  "SHIPPED",
];

/** Canonical Pending → Booking Received → Shipped → Cancelled order — used
 * to sort the vehicles table by Shipment Status against the *effective*
 * status (see lib/shipment-status.ts), since the underlying DB enum has no
 * CANCELLED value to sort by in the first place. */
export const SHIPMENT_STATUS_ORDER: ShipmentStatus[] = [
  "PENDING",
  "BOOKING_RECEIVED",
  "SHIPPED",
  "CANCELLED",
];

export const SHIPMENT_STATUS_META: Record<
  ShipmentStatus,
  { label: string; badgeVariant: "warning" | "info" | "success" | "destructive" }
> = {
  PENDING: { label: "Pending", badgeVariant: "warning" },
  BOOKING_RECEIVED: { label: "Booking Received", badgeVariant: "info" },
  SHIPPED: { label: "Shipped", badgeVariant: "success" },
  CANCELLED: { label: "Shipment Cancelled", badgeVariant: "destructive" },
};
