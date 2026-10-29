// npm run r2:audit: counts only, read-only, nothing printed that could identify a bucket, an address or an object. Fake data only.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { countObjectsByPrefix, countUrlRows, formatAudit, likePrefix, type QueryClient } from "../scripts/r2-audit.js";

describe("npm run r2:audit (read-only)", () => {
  function fakeLister(pages: string[][]) {
    return async (token?: string) => {
      const index = token ? Number(token) : 0;
      const keys = pages[index] ?? [];
      return { keys, ...(index + 1 < pages.length ? { next: String(index + 1) } : {}) };
    };
  }

  it("counts objects per top-level folder across pages, and returns counts only", async () => {
    const result = await countObjectsByPrefix(fakeLister([[`org/${ORG_A}/vehicles/x/photos/a.jpg`, `org/${ORG_A}/vehicles/x/photos/b.jpg`, "stray.txt"], [`uploads/one.jpg`, `org/${ORG_B}/vehicles/y/documents/c.pdf`]]));
    expect(Object.fromEntries(result.byPrefix)).toEqual({ org: 3, "(root)": 1, uploads: 1 });
    expect(result.total).toBe(5);
    expect(JSON.stringify([...result.byPrefix])).not.toMatch(/a\.jpg|photos|vehicles|\.pdf/);
  });

  it("an empty bucket is zero", async () => {
    expect((await countObjectsByPrefix(fakeLister([[]]))).total).toBe(0);
  });

  it("counts database rows on the configured public address versus elsewhere, with the address escaped in the pattern", async () => {
    const asked: { sql: string; params?: unknown[] }[] = [];
    const client: QueryClient = {
      query: async (sql, params) => {
        asked.push({ sql, ...(params ? { params } : {}) });
        return { rows: [{ total: 10, matching: 7 }] };
      },
    };
    const counts = await countUrlRows(client, "https://files.example.test/");
    expect(counts).toEqual([
      { column: "VehiclePhoto.url", total: 10, onPublicHost: 7, elsewhere: 3 },
      { column: "VehicleDocument.url", total: 10, onPublicHost: 7, elsewhere: 3 },
      { column: "Vehicle.auctionSheetUrl", total: 10, onPublicHost: 7, elsewhere: 3 },
    ]);
    expect(asked.every((q) => /^SELECT /.test(q.sql) && !/INSERT|UPDATE|DELETE|DROP|ALTER/i.test(q.sql))).toBe(true);
    expect(asked[0]!.params).toEqual(["https://files.example.test/%"]);
    expect(likePrefix("https://a_b.example.test")).toBe("https://a\\_b.example.test/%");
  });

  it("the report holds numbers and fixed labels only", async () => {
    const report = formatAudit({
      objects: await countObjectsByPrefix(fakeLister([[`org/${ORG_A}/vehicles/x/photos/secret-name.jpg`]])),
      urls: [{ column: "VehiclePhoto.url", total: 4, onPublicHost: 3, elsewhere: 1 }],
    });
    expect(report).toContain("org: 1");
    expect(report).toContain("VehiclePhoto.url: 4 rows, 3 on the configured public address, 1 elsewhere");
    expect(report).not.toMatch(/secret-name|https?:|@|vehicles|photos\//);
  });

  it("the script only lists and counts: no write call, no credential or address printed, no error object printed", () => {
    const source = readFileSync("scripts/r2-audit.ts", "utf8");
    const code = source.split(String.fromCharCode(10)).filter((line) => !line.trimStart().startsWith("//")).join(String.fromCharCode(10));
    for (const forbidden of ["PutObject", "DeleteObject", "CopyObject", "putObject", "deleteKey", "INSERT", "UPDATE ", "DELETE FROM", "MIGRATION_DATABASE_URL", "DIRECT_URL"]) expect(code, forbidden).not.toContain(forbidden);
    expect(code).toContain("ListObjectsV2Command");
    expect(code).toContain("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    // every console call prints a fixed message or the formatted report, never a variable such as a credential or an error
    expect(code).not.toMatch(/console\.(?:log|error)\((?!"|formatAudit\()/);
  });
});
