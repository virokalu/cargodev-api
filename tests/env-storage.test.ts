import { beforeEach, describe, expect, it, vi } from "vitest";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/dbname",
  MOBILE_JWT_SECRET: "test-only-dummy-value-0123456789abcdef",
  ORG_ID: "org_test_a",
};
const r2 = { R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_ACCESS_KEY_ID: "key-example", R2_SECRET_ACCESS_KEY: "secret-example", R2_BUCKET_NAME: "bucket-example" };

beforeEach(() => vi.resetModules());
const load = async () => (await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js")).loadEnv;

describe("object storage environment", () => {
  it("none of the R2 credentials is fine (storage simply off), and customer files are cached privately for 5 minutes by default", async () => {
    const env = (await load())({ ...base });
    expect(env.R2_BUCKET_NAME).toBeUndefined();
    expect(env.CUSTOMER_FILE_CACHE_SECONDS).toBe(300);
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
    ["-1", false],
    ["0", true],
    ["300", true],
    ["86400", true],
    ["86401", false],
    ["abc", false],
    ["1.5", false],
  ])("CUSTOMER_FILE_CACHE_SECONDS=%s is accepted: %s", async (value, ok) => {
    const loadEnv = await load();
    if (ok) expect(loadEnv({ ...base, CUSTOMER_FILE_CACHE_SECONDS: value }).CUSTOMER_FILE_CACHE_SECONDS).toBe(Number(value));
    else expect(() => loadEnv({ ...base, CUSTOMER_FILE_CACHE_SECONDS: value })).toThrow(/CUSTOMER_FILE_CACHE_SECONDS/);
  });

  it.each(["acct-example", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0", "0123456789abcdef0123456789abcdeg", "0123456789abcdef0123456789abcdef.evil.example"])(
    "R2_ACCOUNT_ID must be the 32-character account id (rejects %j)",
    async (id) => {
      const loadEnv = await load();
      expect(() => loadEnv({ ...base, ...r2, R2_ACCOUNT_ID: id })).toThrow(/R2_ACCOUNT_ID/);
    }
  );

  it("the error names the variable and never prints its value", async () => {
    const loadEnv = await load();
    let message = "";
    try {
      loadEnv({ ...base, ...r2, R2_ACCOUNT_ID: "not-an-account-id" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("R2_ACCOUNT_ID");
    expect(message).not.toContain("not-an-account-id");
  });
});
