// Pure track-effective logic, same shape as lib/shipment-status.ts's
// computeEffectiveShipmentStatus — no Prisma, no server-only imports, so
// both the service layer and a client component could share it if ever
// needed. serialPrefix (and the serial string built from it) is permanent —
// re-numbering a vehicle would erase real history and complicate the
// per-prefix SerialCounter — but a vehicle can still need to *behave* like
// the other track from some point on, in either direction: an FL vehicle
// that ends up being exported instead of sold locally (Vehicle.
// convertedToExport), or a native FC vehicle that ends up being sold
// locally instead of exported (Vehicle.convertedToLocal). The two flags
// are mutually exclusive in practice — convertedToExport only ever gets
// set on an FL-rooted row, convertedToLocal only ever on an FC-rooted one.

import type { Prisma, SerialPrefix } from "@prisma/client";

/** The vehicle list's track param — a real track, or "ALL" (only reachable
 * through the mobile API; the web UI has just the FC/FL tabs). */
export type TrackFilter = SerialPrefix | "ALL";

export function computeEffectiveTrack(
  serialPrefix: SerialPrefix,
  convertedToExport: boolean,
  convertedToLocal: boolean
): SerialPrefix {
  if (convertedToExport) return "FC";
  if (convertedToLocal) return "FL";
  return serialPrefix;
}

/** The Prisma `where` for "vehicles that belong to this effective track" —
 * the DB-side twin of computeEffectiveTrack above. Shared by the vehicle
 * list query and by the filter-option lookups (only offer a Brand/Hall/etc.
 * that at least one vehicle in the active tab actually uses), so the two
 * can never disagree about what "belongs to the Local tab" means. */
export function buildTrackWhere(track: TrackFilter): Prisma.VehicleWhereInput {
  if (track === "ALL") return {};
  if (track === "FC") {
    return {
      AND: [
        { OR: [{ serialPrefix: "FC" }, { convertedToExport: true }] },
        { convertedToLocal: false },
      ],
    };
  }
  return {
    OR: [
      { serialPrefix: "FL", convertedToExport: false },
      { serialPrefix: "FC", convertedToLocal: true },
    ],
  };
}
