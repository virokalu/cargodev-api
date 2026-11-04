// `fieldErrors` is { "field": "one message" } everywhere, the shape the original contract shows (docs/legacy/mobile-api-reference.md lines
// 93-97): one STRING per field, never an array. Checked on every error answer of the staff examples, on the type and on the source. Fake data only.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { EXAMPLES, installFakeStorage, makeCtx, newContractWorld, removeFakeStorage } from "./helpers/staff-contract-examples.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const state = vi.hoisted(() => {
  process.env["R2_PUBLIC_URL"] = "https://files.example.test";
  return { fake: undefined as unknown };
});
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { buildApp } from "../src/app.js";
import { setTrustTokenClaimsForTests } from "../src/lib/staff-auth-seam.js";
import { clearStaffAuthCache } from "../src/services/staff-auth-state.service.js";

let app: FastifyInstance;
beforeAll(async () => {
  setTrustTokenClaimsForTests(false);
  installFakeStorage();
  state.fake = newContractWorld();
  app = await buildApp({ rateLimit: false, publicStockEnabled: true });
});
afterAll(async () => {
  await app.close();
  removeFakeStorage();
  setTrustTokenClaimsForTests(true);
});

describe("fieldErrors are one string per field", () => {
  it("on every error answer of every staff example", async () => {
    let withFieldErrors = 0;
    const bad: string[] = [];
    for (const example of EXAMPLES.filter((e) => e.status >= 400)) {
      const fake = newContractWorld();
      state.fake = fake;
      clearStaffAuthCache();
      const reply = await example.run(makeCtx(app, fake));
      const fieldErrors = (reply.body as { error?: { fieldErrors?: unknown } }).error?.fieldErrors;
      if (fieldErrors === undefined) continue;
      withFieldErrors += 1;
      if (typeof fieldErrors !== "object" || fieldErrors === null || Array.isArray(fieldErrors)) bad.push(`${example.id}: not an object`);
      else for (const [key, value] of Object.entries(fieldErrors)) if (typeof value !== "string" || key === "" || value === "") bad.push(`${example.id}.${key}: ${typeof value}`);
    }
    expect(withFieldErrors).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  it("the type forbids anything else, and no source file declares or builds an array-valued fieldErrors", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk("src");
    expect(readFileSync("src/lib/errors.ts", "utf8")).toContain("public fieldErrors?: Record<string, string>");
    expect(readFileSync("src/lib/response.ts", "utf8")).toContain("fieldErrors?: Record<string, string>");
    const offenders = files.filter((file) => /fieldErrors[^\n]*(string\[\]|Array<string>)/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
