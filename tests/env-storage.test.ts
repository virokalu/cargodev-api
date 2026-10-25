import { beforeEach, describe, expect, it, vi } from "vitest";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/dbname",
  MOBILE_JWT_SECRET: "test-only-dummy-value-0123456789abcdef",
  ORG_ID: "org_test_a",
};
const r2 = { R2_ACCOUNT_ID: "acct-example", R2_ACCESS_KEY_ID: "key-example", R2_SECRET_ACCESS_KEY: "secret-example", R2_BUCKET_NAME: "bucket-example" };

beforeEach(() => vi.resetModules());
const load = async () => (await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js")).loadEnv;

describe("object storage environment", () => {
  it("none of the R2 credentials is fine (storage simply off), and the signed-link lifetime defaults to 10 minutes", async () => {
    const env = (await load())({ ...base });
    expect(env.R2_BUCKET_NAME).toBeUndefined();
    expect(env.SIGNED_URL_TTL_SECONDS).toBe(600);
  });

  it("all four is fine", async () => {
    expect((await load())({ ...base, ...r2 }).R2_BUCKET_NAME).toBe("bucket-example");
  });

  it.each(Object.keys(r2))("any single credential without the rest is refused at startup, by name and never by value (%s)", async (name) => {
    const loadEnv = await load();
    let message = "";
    try {
      loadEnv({ ...base, [name]: (r2 as Record<string, string>)[name]! });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Invalid environment variables");
    expect(message).not.toContain((r2 as Record<string, string>)[name]!);
    for (const other of Object.keys(r2).filter((n) => n !== name)) expect(message).toContain(other);
  });

  it("three of four is refused, naming the missing one", async () => {
    const { R2_BUCKET_NAME: _missing, ...three } = r2;
    void _missing;
    expect(() => void (load as never)).not.toThrow();
    const loadEnv = await load();
    expect(() => loadEnv({ ...base, ...three })).toThrow(/R2_BUCKET_NAME/);
  });

  it.each([
    ["299", false],
    ["300", true],
    ["600", true],
    ["900", true],
    ["901", false],
    ["abc", false],
    ["1.5", false],
  ])("SIGNED_URL_TTL_SECONDS=%s is accepted: %s", async (value, ok) => {
    const loadEnv = await load();
    if (ok) expect(loadEnv({ ...base, SIGNED_URL_TTL_SECONDS: value }).SIGNED_URL_TTL_SECONDS).toBe(Number(value));
    else expect(() => loadEnv({ ...base, SIGNED_URL_TTL_SECONDS: value })).toThrow(/SIGNED_URL_TTL_SECONDS/);
  });
});
