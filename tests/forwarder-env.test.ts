// TRUSTED_FORWARDER_SECRET and TRUSTED_FORWARDER_SECRET_PREVIOUS (ADR 0008): optional, 32+ bytes, different from every other secret and
// from each other; a previous one needs a current one. Fake values only.

import { describe, expect, it, vi } from "vitest";

const STRONG = ["forwarder", "env", "value", "0123456789abcdef", "XYZ"].join("-");
const OTHER = ["forwarder", "older", "value", "0123456789abcdef", "XYZ"].join("-");
const BASE_ENV = {
  DATABASE_URL: "postgresql://user:password@example.test:5432/dbname",
  MOBILE_JWT_SECRET: ["mobile", "env", "value", "0123456789abcdef", "XXXX"].join("-"),
  ORG_ID: "org_x",
};
async function load(extra: Record<string, string>) {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
  return actual.loadEnv({ ...BASE_ENV, ...extra });
}
const message = async (extra: Record<string, string>) => load(extra).then(() => "", (e: Error) => e.message);

describe("TRUSTED_FORWARDER_SECRET", () => {
  it("is optional: nothing set means the feature is off", async () => {
    const env = await load({});
    expect([env.TRUSTED_FORWARDER_SECRET, env.TRUSTED_FORWARDER_SECRET_PREVIOUS]).toEqual([undefined, undefined]);
  });

  it("must be at least 32 bytes", async () => {
    expect(await message({ TRUSTED_FORWARDER_SECRET: "x".repeat(31) })).toContain("TRUSTED_FORWARDER_SECRET must be at least 32 bytes");
    expect((await load({ TRUSTED_FORWARDER_SECRET: "x".repeat(32) })).TRUSTED_FORWARDER_SECRET).toHaveLength(32);
  });

  it("must differ from every other secret", async () => {
    const same: Array<Record<string, string>> = [
      { MOBILE_JWT_SECRET: STRONG },
      { FILE_LINK_SECRET: STRONG, FILE_LINK_BASE_URL: "https://api.example.test" },
      { FILE_LINK_SECRET: OTHER, FILE_LINK_SECRET_PREVIOUS: STRONG, FILE_LINK_BASE_URL: "https://api.example.test" },
      { CUSTOMER_JWT_SECRET: STRONG, OTP_PEPPER: ["pepper", "env", "value", "0123456789abcdef", "XXXXXX"].join("-") },
      { CUSTOMER_JWT_SECRET: ["customer", "env", "value", "0123456789abcdef", "XXX"].join("-"), OTP_PEPPER: STRONG },
    ];
    for (const extra of same) {
      expect(await message({ ...extra, TRUSTED_FORWARDER_SECRET: STRONG }), JSON.stringify(Object.keys(extra))).toMatch(/must differ|differ from/);
    }
  });

  it("and the file-link secret must differ from it too", async () => {
    expect(await message({ TRUSTED_FORWARDER_SECRET: STRONG, FILE_LINK_SECRET: STRONG, FILE_LINK_BASE_URL: "https://api.example.test" })).toContain("FILE_LINK_SECRET must differ from every other secret");
    expect(await message({ TRUSTED_FORWARDER_SECRET: OTHER, TRUSTED_FORWARDER_SECRET_PREVIOUS: STRONG, FILE_LINK_SECRET: STRONG, FILE_LINK_BASE_URL: "https://api.example.test" })).toContain("FILE_LINK_SECRET must differ from every other secret");
  });
});

describe("TRUSTED_FORWARDER_SECRET_PREVIOUS", () => {
  it("is fine next to a current secret", async () => {
    const env = await load({ TRUSTED_FORWARDER_SECRET: STRONG, TRUSTED_FORWARDER_SECRET_PREVIOUS: OTHER });
    expect(env.TRUSTED_FORWARDER_SECRET_PREVIOUS).toBe(OTHER);
  });

  it("needs a current secret", async () => {
    expect(await message({ TRUSTED_FORWARDER_SECRET_PREVIOUS: OTHER })).toContain("needs TRUSTED_FORWARDER_SECRET");
  });

  it("must be 32 bytes, differ from the current secret and from every other secret", async () => {
    expect(await message({ TRUSTED_FORWARDER_SECRET: STRONG, TRUSTED_FORWARDER_SECRET_PREVIOUS: "x".repeat(31) })).toContain("at least 32 bytes");
    expect(await message({ TRUSTED_FORWARDER_SECRET: STRONG, TRUSTED_FORWARDER_SECRET_PREVIOUS: STRONG })).toContain("must differ from TRUSTED_FORWARDER_SECRET");
    expect(await message({ TRUSTED_FORWARDER_SECRET: STRONG, TRUSTED_FORWARDER_SECRET_PREVIOUS: BASE_ENV.MOBILE_JWT_SECRET })).toContain("must differ from every other secret");
  });
});
