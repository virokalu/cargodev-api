import { beforeEach, describe, expect, it, vi } from "vitest";

const base = {
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_dummy",
  MOBILE_JWT_SECRET: "test-only-dummy-value-0123456789abcdef",
  ORG_ID: "org_test_a",
};

// loadEnv caches its first result, so load a fresh copy of the module for each case.
beforeEach(() => vi.resetModules());
const load = async () => (await import("../src/config/env.js")).loadEnv;

describe("loadEnv", () => {
  it("accepts the minimum required variables and applies defaults", async () => {
    const env = (await load())({ ...base });
    expect(env).toMatchObject({ PORT: 4000, LOG_LEVEL: "info", TRUST_PROXY_HOPS: 0, SSE_MAX_CONNECTIONS: 500, DAILY_JOB_UTC_HOUR: 2 });
    expect(env.SCHEDULER_ENABLED).toBe(true);
    expect(env.CORS_ALLOWED_ORIGINS).toBe("");
    expect(env.EXPO_ACCESS_TOKEN).toBeUndefined();
  });

  it("treats an EMPTY optional variable as not set (a copied .env.example must start)", async () => {
    const env = (await load())({
      ...base,
      EXPO_ACCESS_TOKEN: "",
      CORS_ALLOWED_ORIGINS: "",
      LOG_LEVEL: "",
      TRUST_PROXY_HOPS: "",
      PORT: "  ",
    });
    expect(env.EXPO_ACCESS_TOKEN).toBeUndefined();
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.PORT).toBe(4000);
  });

  it("an empty REQUIRED variable is reported as missing, by name only", async () => {
    const loadEnv = await load();
    for (const name of ["DATABASE_URL", "MOBILE_JWT_SECRET", "ORG_ID"] as const) {
      expect(() => loadEnv({ ...base, [name]: "" })).toThrow(`Invalid environment variables: ${name}. See docs/env.md.`);
    }
  });

  it("reports every invalid name and never echoes a value", async () => {
    const loadEnv = await load();
    let message = "";
    try {
      loadEnv({ ...base, MOBILE_JWT_SECRET: "too-short-secret", TRUST_PROXY_HOPS: "banana", SSE_MAX_CONNECTIONS: "0" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/MOBILE_JWT_SECRET/);
    expect(message).toMatch(/TRUST_PROXY_HOPS/);
    expect(message).toMatch(/SSE_MAX_CONNECTIONS/);
    expect(message).not.toContain("too-short-secret");
    expect(message).not.toContain("banana");
  });

  it("a real optional value is still used", async () => {
    const env = (await load())({ ...base, EXPO_ACCESS_TOKEN: "example-expo-value", SCHEDULER_ENABLED: "false" });
    expect(env.EXPO_ACCESS_TOKEN).toBe("example-expo-value");
    expect(env.SCHEDULER_ENABLED).toBe(false);
  });

  it("the shipped .env.example is itself a valid configuration once its placeholders are filled in", async () => {
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(new URL("../.env.example", import.meta.url), "utf8").split(/\r?\n/);
    const vars = Object.fromEntries(
      lines.filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
    );
    // Only the placeholder values a developer must replace.
    vars["ORG_ID"] = "org_local_dev";
    vars["MOBILE_JWT_SECRET"] = "x".repeat(40);
    const env = (await load())(vars);
    expect(env.PORT).toBe(4000);
  });
});
