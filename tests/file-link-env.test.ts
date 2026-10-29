// The FILE_LINK_* settings (ADR 0007): both secret and base or neither (both in production), a strong secret that differs from every other
// secret, the previous one for rotation, an https origin, and a TTL inside its cap. Fake values only.

import { describe, expect, it, vi } from "vitest";

const STRONG = "link-secret-value-for-tests-0123456789abcdef";
const OTHER = "older-link-secret-value-for-tests-0123456789ab";
const BASE_ENV = {
  DATABASE_URL: "postgresql://user:password@example.test:5432/dbname",
  MOBILE_JWT_SECRET: "mobile-secret-value-0123456789abcdefXX",
  ORG_ID: "org_x",
};
async function load(extra: Record<string, string>) {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
  return actual.loadEnv({ ...BASE_ENV, ...extra });
}
const message = async (extra: Record<string, string>) => load(extra).then(() => "", (e: Error) => e.message);
const ON = { FILE_LINK_SECRET: STRONG, FILE_LINK_BASE_URL: "https://api.example.test" };

describe("defaults and the happy path", () => {
  it("links are optional outside production: nothing set is fine, and the TTLs default to 300 and 900", async () => {
    const env = await load({});
    expect([env.FILE_LINK_SECRET, env.FILE_LINK_BASE_URL, env.FILE_LINK_TTL_SECONDS, env.FILE_LINK_MAX_TTL_SECONDS]).toEqual([undefined, undefined, 300, 900]);
  });

  it("both set is fine, with or without a previous secret", async () => {
    expect((await load(ON)).FILE_LINK_SECRET).toBe(STRONG);
    expect((await load({ ...ON, FILE_LINK_SECRET_PREVIOUS: OTHER })).FILE_LINK_SECRET_PREVIOUS).toBe(OTHER);
  });
});

describe("the secret", () => {
  it("must be at least 32 bytes (in bytes, not characters)", async () => {
    expect(await message({ ...ON, FILE_LINK_SECRET: "x".repeat(31) })).toContain("FILE_LINK_SECRET must be at least 32 bytes");
    expect((await load({ ...ON, FILE_LINK_SECRET: "x".repeat(32) })).FILE_LINK_SECRET).toHaveLength(32);
    // 16 two-byte characters are 32 bytes but only 16 characters: counted in bytes, they pass
    expect((await load({ ...ON, FILE_LINK_SECRET: "é".repeat(16) })).FILE_LINK_SECRET).toHaveLength(16);
  });

  it("must differ from every other secret", async () => {
    const same = [
      ["MOBILE_JWT_SECRET", { MOBILE_JWT_SECRET: STRONG }],
      ["CUSTOMER_JWT_SECRET", { CUSTOMER_JWT_SECRET: STRONG, OTP_PEPPER: "pepper-value-0123456789abcdefXXXXXXXX" }],
      ["OTP_PEPPER", { CUSTOMER_JWT_SECRET: "customer-secret-value-0123456789abcdefX", OTP_PEPPER: STRONG }],
      ["R2_SECRET_ACCESS_KEY", { R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: STRONG, R2_BUCKET_NAME: "b" }],
      ["TURNSTILE_SECRET", { TURNSTILE_SECRET: STRONG }],
      ["RESEND_API_KEY", { RESEND_API_KEY: STRONG }],
      ["EXPO_ACCESS_TOKEN", { EXPO_ACCESS_TOKEN: STRONG }],
    ] as const;
    for (const [name, extra] of same) {
      const text = await message({ ...ON, ...extra });
      expect(text, name).toContain("FILE_LINK_SECRET must differ from every other secret");
      expect(text, "the message never repeats the value").not.toContain(STRONG);
    }
  });

  it("the previous secret: needs the current one, is 32+ bytes, differs from the current one and from every other secret", async () => {
    expect(await message({ FILE_LINK_SECRET_PREVIOUS: OTHER })).toContain("FILE_LINK_SECRET_PREVIOUS needs FILE_LINK_SECRET");
    expect(await message({ ...ON, FILE_LINK_SECRET_PREVIOUS: "short" })).toContain("FILE_LINK_SECRET_PREVIOUS must be at least 32 bytes");
    expect(await message({ ...ON, FILE_LINK_SECRET_PREVIOUS: STRONG })).toContain("FILE_LINK_SECRET_PREVIOUS must differ from FILE_LINK_SECRET");
    expect(await message({ ...ON, FILE_LINK_SECRET_PREVIOUS: BASE_ENV.MOBILE_JWT_SECRET })).toContain("FILE_LINK_SECRET_PREVIOUS must differ from every other secret");
  });
});

describe("the base address", () => {
  it.each(["https://api.example.test", "https://api.example.test/", "https://api.example.test:8443"])("accepts the https origin %s", async (good) => {
    expect((await load({ ...ON, FILE_LINK_BASE_URL: good })).FILE_LINK_BASE_URL).toBe(good);
  });

  it.each([
    ["http://api.example.test", "https"],
    ["https://user:pass@api.example.test", "credentials"],
    ["https://api.example.test/?a=1", "query"],
    ["https://api.example.test/?", "query"],
    ["https://api.example.test/#x", "fragment"],
    ["https://api.example.test/files", "origin only"],
    ["https://api.example.test/api/", "origin only"],
    ["api.example.test", "valid"],
  ])("rejects %s", async (bad, hint) => {
    const text = await message({ ...ON, FILE_LINK_BASE_URL: bad });
    expect(text).toContain("FILE_LINK_BASE_URL");
    expect(text).toContain(hint);
  });

  it("outside production both or neither: one without the other stops the start", async () => {
    expect(await message({ FILE_LINK_SECRET: STRONG })).toContain("FILE_LINK_BASE_URL is required when FILE_LINK_SECRET is set");
    expect(await message({ FILE_LINK_BASE_URL: "https://api.example.test" })).toContain("FILE_LINK_SECRET is required when FILE_LINK_BASE_URL is set");
  });
});

describe("production", () => {
  const production = { NODE_ENV: "production", CLIENT_IP_SOURCE: "socket" };

  it("both are required, whether production is set by NODE_ENV or by APP_ENV", async () => {
    for (const env of [production, { APP_ENV: "production" }]) {
      const text = await message(env);
      expect(text).toContain("FILE_LINK_SECRET is required in production");
      expect(text).toContain("FILE_LINK_BASE_URL is required in production");
    }
    expect(await message({ ...production, FILE_LINK_SECRET: STRONG })).toContain("FILE_LINK_BASE_URL is required in production");
    expect(await message({ ...production, FILE_LINK_BASE_URL: "https://api.example.test" })).toContain("FILE_LINK_SECRET is required in production");
    expect((await load({ ...production, ...ON })).FILE_LINK_SECRET).toBe(STRONG);
  });

  it("staging does not require them", async () => {
    expect((await load({ APP_ENV: "staging" })).FILE_LINK_SECRET).toBeUndefined();
  });
});

describe("the lifetimes", () => {
  it.each([
    ["FILE_LINK_TTL_SECONDS", "29"],
    ["FILE_LINK_TTL_SECONDS", "901"],
    ["FILE_LINK_TTL_SECONDS", "0"],
    ["FILE_LINK_TTL_SECONDS", "-1"],
    ["FILE_LINK_TTL_SECONDS", "300.5"],
    ["FILE_LINK_TTL_SECONDS", "abc"],
    ["FILE_LINK_MAX_TTL_SECONDS", "29"],
    ["FILE_LINK_MAX_TTL_SECONDS", "901"],
  ])("%s=%s is rejected, naming the setting", async (name, value) => {
    expect(await message({ ...ON, [name]: value })).toContain(name);
  });

  it("accepts the bounds 30 and 900", async () => {
    const env = await load({ ...ON, FILE_LINK_TTL_SECONDS: "30", FILE_LINK_MAX_TTL_SECONDS: "900" });
    expect([env.FILE_LINK_TTL_SECONDS, env.FILE_LINK_MAX_TTL_SECONDS]).toEqual([30, 900]);
    expect((await load({ ...ON, FILE_LINK_TTL_SECONDS: "900" })).FILE_LINK_TTL_SECONDS).toBe(900);
  });

  it("the TTL may not exceed the cap", async () => {
    expect(await message({ ...ON, FILE_LINK_TTL_SECONDS: "600", FILE_LINK_MAX_TTL_SECONDS: "300" })).toContain("FILE_LINK_TTL_SECONDS must not exceed FILE_LINK_MAX_TTL_SECONDS");
    expect((await load({ ...ON, FILE_LINK_TTL_SECONDS: "300", FILE_LINK_MAX_TTL_SECONDS: "300" })).FILE_LINK_TTL_SECONDS).toBe(300);
  });
});

describe("the old setting is gone", () => {
  it("STAFF_SIGNED_URL_TTL_SECONDS is no longer read (the staff presigned-link path was removed)", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/config/env.ts", "utf8")).not.toContain("STAFF_SIGNED_URL_TTL_SECONDS");
    expect(readFileSync("src/lib/object-storage.ts", "utf8")).not.toMatch(/signStaffFileUrl|presignGet/);
    expect(readFileSync("src/lib/r2-object-store.ts", "utf8")).not.toMatch(/presignGet/);
  });
});
