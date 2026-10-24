import { describe, expect, it } from "vitest";
import { buildTrackWhere, computeEffectiveTrack } from "../src/lib/vehicle-track.js";

describe("computeEffectiveTrack", () => {
  it("uses the serial prefix when nothing is converted", () => {
    expect(computeEffectiveTrack("FC", false, false)).toBe("FC");
    expect(computeEffectiveTrack("FL", false, false)).toBe("FL");
  });
  it("treats an FL vehicle converted to export as FC", () => {
    expect(computeEffectiveTrack("FL", true, false)).toBe("FC");
  });
  it("treats an FC vehicle converted to local as FL", () => {
    expect(computeEffectiveTrack("FC", false, true)).toBe("FL");
  });
});

describe("buildTrackWhere", () => {
  it("returns no restriction for ALL", () => {
    expect(buildTrackWhere("ALL")).toEqual({});
  });
  it("FC includes native FC and FL converted to export, minus FC converted to local", () => {
    expect(buildTrackWhere("FC")).toEqual({
      AND: [{ OR: [{ serialPrefix: "FC" }, { convertedToExport: true }] }, { convertedToLocal: false }],
    });
  });
  it("FL includes native FL (not converted) and FC converted to local", () => {
    expect(buildTrackWhere("FL")).toEqual({
      OR: [
        { serialPrefix: "FL", convertedToExport: false },
        { serialPrefix: "FC", convertedToLocal: true },
      ],
    });
  });
});
