// Closed value lists shared by vehicle.service and the vehicle query schema, so they
// cannot drift apart. (The CargoDev web UI's URL parsing/building helpers that lived
// next to these are web-only and are not ported.)

import type { ShipmentStatus } from "./constants/shipment-status.js";
import type { ShippingMethod } from "@prisma/client";
import type {
  TriStateFilterValue,
  TwoStateFilterValue,
  VehicleListSortKey,
} from "../services/vehicle.service.js";

export const SORT_KEYS: VehicleListSortKey[] = [
  "serial",
  "chassisNo",
  "model",
  "yom",
  "shipmentStatus",
  "purchaseDate",
  "etd",
  "eta",
  "destination",
  "docsArrivedDate",
  "nameChangeDeadline",
  "massoDate",
  "docSentDate",
  "recycleDate",
  "vesselName",
  "deliveryDate",
  "sellingPrice",
];

export const SHIPMENT_STATUSES: ShipmentStatus[] = ["PENDING", "BOOKING_RECEIVED", "SHIPPED", "CANCELLED"];
export const SHIPPING_METHODS: ShippingMethod[] = ["RORO", "CONTAINER"];
export const TRI_STATE_VALUES: TriStateFilterValue[] = ["YES", "NO", "BLANK"];
export const TWO_STATE_VALUES: TwoStateFilterValue[] = ["YES", "NO"];
export const SOLD_CURRENCIES = ["JPY", "LKR", "USD"];
