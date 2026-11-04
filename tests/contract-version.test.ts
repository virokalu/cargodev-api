// G10 and G12 against the staff contract document: the version the API sends equals the version written in the document, the changelog is
// in order, and the timeline table (section 5.5) lists exactly the steps and labels the code derives. Fake data only.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from "../src/config/contract-version.js";
import { buildShipmentMilestones } from "../src/lib/shipment-milestones.js";

const DOC = readFileSync("docs/staff-frontend-integration.md", "utf8");
const top = DOC.split(/\r?\n/).slice(0, 5).join("\n");
const VERSION_AT_TOP = /\*\*Contract version:\*\* (\d+\.\d+\.\d+) \(\d{4}-\d{2}-\d{2}\)/;

describe("the contract version", () => {
  it("the constant the API sends as X-Contract-Version equals the version at the top of the document", () => {
    const match = VERSION_AT_TOP.exec(top);
    expect(match, "no version at the top of the document").not.toBeNull();
    expect(CONTRACT_VERSION).toBe(match![1]);
    expect(CONTRACT_VERSION_HEADER).toBe("X-Contract-Version");
  });

  it("is a MAJOR.MINOR.PATCH number", () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the changelog has a row for the current version at the top, newest first", () => {
    const rows = [...DOC.matchAll(/^\| (\d+\.\d+\.\d+) \| \d{4}-\d{2}-\d{2} \|/gm)].map((m) => m[1]!);
    expect(rows[0]).toBe(CONTRACT_VERSION);
    const rank = (v: string) => {
      const [a, b, c] = v.split(".").map(Number);
      return a! * 1_000_000 + b! * 1_000 + c!;
    };
    for (let i = 1; i < rows.length; i += 1) expect(rank(rows[i - 1]!), `${rows[i - 1]} must come after ${rows[i]}`).toBeGreaterThan(rank(rows[i]!));
  });
});

describe("the timeline steps in the document are the ones the code derives (G12)", () => {
  const past = new Date("2020-01-01T00:00:00Z");
  const everything = buildShipmentMilestones({
    auctionBillPaid: true,
    transportBy: { id: "t", name: "T" },
    lcNo: "LC-1",
    etd: past,
    bookingReceivedAt: past,
    eta: past,
    destination: "Sri Lanka",
    ecReceivedAt: past,
    inspectionCompletedAt: past,
    shippingMethod: "CONTAINER",
    vanningDate: past,
  });

  it("with every conditional step switched on there are nine steps, in this order, with these labels", () => {
    expect(everything.map((s) => [s.key, s.label])).toEqual([
      ["AUCTION_BILL_PAID", "Auction Bill Paid"],
      ["TRANSPORT_ASSIGNED", "Rikso Given"],
      ["EC_RECEIVED", "EC Received"],
      ["INSPECTION_COMPLETED", "Inspection Completed"],
      ["LC_OPEN", "LC Open"],
      ["BOOKING_RECEIVED", "Booking Received"],
      ["LOADED", "Loaded"],
      ["SHIPPED", "Shipped"],
      ["DELIVERED", "Delivered"],
    ]);
    expect(everything.every((s) => s.completed)).toBe(true);
  });

  it("the document's table lists the same keys and labels in the same order", () => {
    const rows = [...DOC.matchAll(/^\| `([A-Z_]+)` \| ([^|]+) \|/gm)].map((m) => [m[1]!, m[2]!.trim()]);
    const fromDoc = rows.filter(([key]) => everything.some((step) => step.key === key));
    expect(fromDoc).toEqual(everything.map((s) => [s.key, s.label]));
  });
});
