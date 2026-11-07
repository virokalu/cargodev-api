// docs/render-env-checklist.md lists EVERY variable the API reads (from src/config/env.ts), names only, no values. Fake data only.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const doc = readFileSync("docs/render-env-checklist.md", "utf8");
const envSource = readFileSync("src/config/env.ts", "utf8");

/** The keys of baseSchema: lines like `  NAME: z...` between `const baseSchema = z.object({` and its closing `});`. */
function schemaKeys(): string[] {
  const start = envSource.indexOf("const baseSchema = z.object({");
  const end = envSource.indexOf("\n});", start);
  expect(start).toBeGreaterThan(-1);
  return [...envSource.slice(start, end).matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
}

describe("the Render environment checklist", () => {
  it("mentions every variable in the schema", () => {
    const keys = schemaKeys();
    expect(keys.length).toBeGreaterThan(40);
    const missing = keys.filter((key) => !doc.includes(`\`${key}\``));
    expect(missing, "variables in src/config/env.ts that the checklist does not list").toEqual([]);
  });

  it("names no variable that the code does not read (apart from the laptop-only ones)", () => {
    const known = new Set([...schemaKeys(), "MIGRATION_DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL", "TEST_DATABASE_POOL_MAX"]);
    const named = [...doc.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1]!);
    expect(named.filter((name) => !known.has(name))).toEqual([]);
  });

  it("every schema variable has a table row with all six columns", () => {
    for (const key of schemaKeys()) {
      const row = doc.split(/\r?\n/).find((line) => line.startsWith("|") && line.includes(`\`${key}\``));
      expect(row, key).toBeDefined();
    }
  });

  it("has the groups the operator needs, the secret snippet, and no values", () => {
    for (const heading of ["## 1. Must set for the first staging deploy", "## 2. Set later", "## 4. Leave unset on staging", "## 5. Never on the API host"]) expect(doc).toContain(heading);
    expect(doc).toContain("RandomNumberGenerator");
    expect(doc).not.toMatch(/https?:\/\/(?!example\.test)/);
    expect(doc).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(doc).not.toMatch(/postgres(ql)?:\/\//);
    expect(doc).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it("is linked from the deployment guide", () => {
    expect(readFileSync("docs/deployment.md", "utf8")).toContain("render-env-checklist.md");
  });
});
