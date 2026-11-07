// The signature is compared with crypto.timingSafeEqual (constant time), not with a plain equality. Fake values only.

import { describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      spy.calls += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

import { checkForwardedAddress, signForwardedAddress } from "../src/lib/trusted-forwarder.js";

const SECRET = ["forwarder", "compare", "value", "0123456789abcdef", "XYZ"].join("-");
const PREVIOUS = ["forwarder", "compare", "older", "0123456789abcdef", "XYZ"].join("-");

describe("constant-time comparison", () => {
  it("compares against every configured secret with timingSafeEqual", () => {
    const signature = signForwardedAddress(SECRET, "203.0.113.5", 1_800_000_000);
    const before = spy.calls;
    const result = checkForwardedAddress({ secrets: [SECRET, PREVIOUS], ip: "203.0.113.5", timestamp: "1800000000", signature, nowSeconds: 1_800_000_000 });
    expect(result).toEqual({ ok: true, ip: "203.0.113.5" });
    expect(spy.calls - before).toBe(2); // the match on the first secret does not skip the second
  });
});
