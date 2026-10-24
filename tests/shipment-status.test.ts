import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeEffectiveShipmentStatus,
  computeShipmentStatusAfterEtdChange,
  deriveShipmentStatusFromEtd,
  isCancelShipmentRowColour,
  todayAtMidnight,
} from "../src/lib/shipment-status.js";

// "Today" is 15 June 2026, midday local time.
const yesterday = new Date(2026, 5, 14);
const today = new Date(2026, 5, 15);
const tomorrow = new Date(2026, 5, 16);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("todayAtMidnight", () => {
  it("returns local midnight of the current day", () => {
    expect(todayAtMidnight().getTime()).toBe(today.getTime());
  });
});

describe("isCancelShipmentRowColour", () => {
  it("matches the two cancelling row colour names", () => {
    expect(isCancelShipmentRowColour("Unit Canceled")).toBe(true);
    expect(isCancelShipmentRowColour("Resold in Auction")).toBe(true);
  });
  it("does not match other names, null or undefined", () => {
    expect(isCancelShipmentRowColour("Transport Complete")).toBe(false);
    expect(isCancelShipmentRowColour(null)).toBe(false);
    expect(isCancelShipmentRowColour(undefined)).toBe(false);
  });
});

describe("computeEffectiveShipmentStatus", () => {
  it("returns CANCELLED whenever cancelled is true", () => {
    expect(computeEffectiveShipmentStatus("PENDING", null, true)).toBe("CANCELLED");
    expect(computeEffectiveShipmentStatus("SHIPPED", yesterday, true)).toBe("CANCELLED");
  });
  it("promotes BOOKING_RECEIVED to SHIPPED once the ETD is before today", () => {
    expect(computeEffectiveShipmentStatus("BOOKING_RECEIVED", yesterday, false)).toBe("SHIPPED");
  });
  it("keeps BOOKING_RECEIVED when the ETD is today or later", () => {
    expect(computeEffectiveShipmentStatus("BOOKING_RECEIVED", today, false)).toBe("BOOKING_RECEIVED");
    expect(computeEffectiveShipmentStatus("BOOKING_RECEIVED", tomorrow, false)).toBe("BOOKING_RECEIVED");
  });
  it("never promotes PENDING, even with a past ETD", () => {
    expect(computeEffectiveShipmentStatus("PENDING", yesterday, false)).toBe("PENDING");
  });
  it("leaves BOOKING_RECEIVED alone when there is no ETD", () => {
    expect(computeEffectiveShipmentStatus("BOOKING_RECEIVED", null, false)).toBe("BOOKING_RECEIVED");
  });
});

describe("deriveShipmentStatusFromEtd", () => {
  it("is PENDING without an ETD", () => {
    expect(deriveShipmentStatusFromEtd(null)).toBe("PENDING");
  });
  it("is SHIPPED for a past ETD and BOOKING_RECEIVED otherwise", () => {
    expect(deriveShipmentStatusFromEtd(yesterday)).toBe("SHIPPED");
    expect(deriveShipmentStatusFromEtd(today)).toBe("BOOKING_RECEIVED");
    expect(deriveShipmentStatusFromEtd(tomorrow)).toBe("BOOKING_RECEIVED");
  });
});

describe("computeShipmentStatusAfterEtdChange", () => {
  it("moves PENDING to BOOKING_RECEIVED when an ETD is added", () => {
    expect(computeShipmentStatusAfterEtdChange("PENDING", false, true)).toBe("BOOKING_RECEIVED");
  });
  it("reverts to PENDING when the ETD is cleared, from any status", () => {
    expect(computeShipmentStatusAfterEtdChange("BOOKING_RECEIVED", true, false)).toBe("PENDING");
    expect(computeShipmentStatusAfterEtdChange("SHIPPED", true, false)).toBe("PENDING");
  });
  it("does not transition when the ETD only changes date", () => {
    expect(computeShipmentStatusAfterEtdChange("BOOKING_RECEIVED", true, true)).toBe("BOOKING_RECEIVED");
  });
  it("does not move a non-PENDING status when an ETD is added", () => {
    expect(computeShipmentStatusAfterEtdChange("SHIPPED", false, true)).toBe("SHIPPED");
  });
  it("does nothing when there was and is no ETD", () => {
    expect(computeShipmentStatusAfterEtdChange("PENDING", false, false)).toBe("PENDING");
  });
});
