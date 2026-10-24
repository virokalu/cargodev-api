import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildShipmentMilestones,
  LC_OPEN_DESTINATIONS,
  type ShipmentMilestoneInput,
} from "../src/lib/shipment-milestones.js";

const past = new Date(2026, 5, 1);
const future = new Date(2026, 6, 1);

const base: ShipmentMilestoneInput = {
  auctionBillPaid: null,
  transportBy: null,
  lcNo: null,
  etd: null,
  bookingReceivedAt: null,
  eta: null,
  destination: null,
  ecReceivedAt: null,
  inspectionCompletedAt: null,
  shippingMethod: null,
  vanningDate: null,
};

const keys = (input: Partial<ShipmentMilestoneInput>) =>
  buildShipmentMilestones({ ...base, ...input }).map((m) => m.key);
const find = (input: Partial<ShipmentMilestoneInput>, key: string) =>
  buildShipmentMilestones({ ...base, ...input }).find((m) => m.key === key);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("buildShipmentMilestones", () => {
  it("returns the base sequence for a bare vehicle", () => {
    expect(keys({})).toEqual([
      "AUCTION_BILL_PAID",
      "TRANSPORT_ASSIGNED",
      "EC_RECEIVED",
      "BOOKING_RECEIVED",
      "SHIPPED",
      "DELIVERED",
    ]);
  });

  it("only treats auctionBillPaid === true as completed (null and false are not)", () => {
    expect(find({ auctionBillPaid: true }, "AUCTION_BILL_PAID")?.completed).toBe(true);
    expect(find({ auctionBillPaid: false }, "AUCTION_BILL_PAID")?.completed).toBe(false);
    expect(find({ auctionBillPaid: null }, "AUCTION_BILL_PAID")?.completed).toBe(false);
  });

  it("completes Rikso Given when a transport company is set", () => {
    expect(find({ transportBy: { id: "t1", name: "Test Transport" } }, "TRANSPORT_ASSIGNED")?.completed).toBe(true);
  });

  it("only shows Inspection Completed once a report exists", () => {
    expect(keys({})).not.toContain("INSPECTION_COMPLETED");
    const m = find({ inspectionCompletedAt: past }, "INSPECTION_COMPLETED");
    expect(m).toMatchObject({ completed: true, date: past });
  });

  it("shows LC Open only for the LC destinations, completed by lcNo", () => {
    expect(LC_OPEN_DESTINATIONS.has("Sri Lanka")).toBe(true);
    expect(keys({ destination: "Kenya" })).not.toContain("LC_OPEN");
    expect(find({ destination: "Sri Lanka" }, "LC_OPEN")?.completed).toBe(false);
    expect(find({ destination: "Bangladesh", lcNo: "LC-TEST-1" }, "LC_OPEN")?.completed).toBe(true);
  });

  it("Booking Received completes with an ETD and prefers bookingReceivedAt for its date", () => {
    const bookedAt = new Date(2026, 4, 20);
    expect(find({ etd: future }, "BOOKING_RECEIVED")).toMatchObject({ completed: true, date: future });
    expect(find({ etd: future, bookingReceivedAt: bookedAt }, "BOOKING_RECEIVED")?.date).toBe(bookedAt);
    expect(find({}, "BOOKING_RECEIVED")?.completed).toBe(false);
  });

  it("includes Loaded only for CONTAINER, completed once the vanning date has passed", () => {
    expect(keys({ shippingMethod: "RORO" })).not.toContain("LOADED");
    expect(find({ shippingMethod: "CONTAINER", vanningDate: past }, "LOADED")).toMatchObject({
      completed: true,
      date: past,
    });
    expect(find({ shippingMethod: "CONTAINER", vanningDate: future }, "LOADED")).toMatchObject({
      completed: false,
      date: null,
    });
  });

  it("completes Shipped and Delivered when the ETD / ETA are before today", () => {
    expect(find({ etd: past, eta: past }, "SHIPPED")?.completed).toBe(true);
    expect(find({ etd: past, eta: past }, "DELIVERED")?.completed).toBe(true);
    expect(find({ etd: future, eta: future }, "SHIPPED")).toMatchObject({ completed: false, date: null });
    expect(find({ etd: future, eta: future }, "DELIVERED")).toMatchObject({ completed: false, date: null });
  });

  it("keeps the milestone order: Loaded sits between Booking Received and Shipped", () => {
    const order = keys({ shippingMethod: "CONTAINER", destination: "Sri Lanka", inspectionCompletedAt: past });
    expect(order).toEqual([
      "AUCTION_BILL_PAID",
      "TRANSPORT_ASSIGNED",
      "EC_RECEIVED",
      "INSPECTION_COMPLETED",
      "LC_OPEN",
      "BOOKING_RECEIVED",
      "LOADED",
      "SHIPPED",
      "DELIVERED",
    ]);
  });
});
