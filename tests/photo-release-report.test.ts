import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatPhotoReport } from "../scripts/photo-report-format.js";

const root = path.resolve(import.meta.dirname, "..");

describe("formatPhotoReport", () => {
  it("shows a serial and counts per vehicle, and a total", () => {
    const lines = formatPhotoReport([
      { serial: "FC101", total: 5, released: 2 },
      { serial: "FC102", total: 3, released: 0 },
    ]);
    expect(lines[0]).toBe("serial        photos  released  hidden");
    expect(lines[1]).toBe("FC101              5         2       3");
    expect(lines[2]).toBe("FC102              3         0       3");
    expect(lines.at(-1)).toBe("2 vehicle(s) with photos, 8 photo(s): 2 released, 6 hidden");
  });

  it("when the release column does not exist yet it says so and shows only totals", () => {
    const lines = formatPhotoReport([{ serial: "FC101", total: 4, released: null }]);
    expect(lines[0]).toContain("unknown");
    expect(lines.at(-1)).toBe("1 vehicle(s) with photos, 4 photo(s)");
  });

  it("an empty list is a clean report", () => {
    expect(formatPhotoReport([]).at(-1)).toBe("0 vehicle(s) with photos, 0 photo(s): 0 released, 0 hidden");
  });

  it("only ever prints what it is given: a serial and numbers", () => {
    const text = formatPhotoReport([{ serial: "FC101", total: 1, released: 1 }]).join("\n");
    expect(text).not.toMatch(/https?:|org\/|\.jpg|\.png/);
  });
});

describe("the report script's safety properties", () => {
  const source = readFileSync(path.join(root, "scripts", "photo-release-report.ts"), "utf8");
  const code = source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("is read-only: the session is read-only and it issues no write statement", () => {
    expect(code).toContain("SET default_transaction_read_only = on");
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/);
  });

  it("targets MIGRATION_DATABASE_URL only", () => {
    expect(code.match(/process\.env\[[^\]]*\]/g)).toEqual(['process.env["MIGRATION_DATABASE_URL"]']);
  });

  it("never selects a photo URL or key", () => {
    expect(code).not.toMatch(/p\.url|"url"|\burl\b\s+FROM/i);
    expect(code).not.toMatch(/SELECT[^`]*\bp\.\w*url/i);
  });

  it("is an npm script", () => {
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts["photos:release-report"]).toContain("photo-release-report.ts");
  });
});
