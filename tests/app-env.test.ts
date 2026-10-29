// APP_ENV, the rules for the public stock image address, and what the server says when it starts. Fake values only.

import { describe, expect, it, vi } from "vitest";

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:password@example.test:5432/dbname",
  MOBILE_JWT_SECRET: "mobile-secret-value-0123456789abcdefXX",
  ORG_ID: "org_x",
  FILE_LINK_SECRET: "link-secret-value-for-tests-0123456789abcdef",
  FILE_LINK_BASE_URL: "https://api.example.test",
};
async function load(extra: Record<string, string>) {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
  return actual.loadEnv({ ...BASE_ENV, ...extra });
}
const message = async (extra: Record<string, string>) => load(extra).then(() => "", (e: Error) => e.message);

describe("APP_ENV", () => {
  it("defaults to development and accepts production, staging and development", async () => {
    expect((await load({})).APP_ENV).toBe("development");
    for (const value of ["production", "staging", "development"]) expect((await load({ APP_ENV: value })).APP_ENV).toBe(value);
  });

  it.each(["prod", "Production", "test", "live", "1"])("rejects %s", async (bad) => {
    expect(await message({ APP_ENV: bad })).toContain("APP_ENV");
  });
});

describe("PUBLIC_STOCK_IMAGE_BASE_URL", () => {
  const NAME = "PUBLIC_STOCK_IMAGE_BASE_URL";

  it.each(["https://img.example.test", "https://img.example.test/", "https://img.example.test/stock", "https://cdn.example.test:8443"])("accepts the https address %s in every APP_ENV", async (good) => {
    for (const APP_ENV of ["production", "staging", "development"]) expect((await load({ APP_ENV, [NAME]: good }))[NAME]).toBe(good);
  });

  it.each([
    ["http://img.example.test", "https"],
    ["ftp://img.example.test", "https"],
    ["//img.example.test", "valid address"],
    ["img.example.test", "valid address"],
    ["https://user:pass@img.example.test", "credentials"],
    ["https://user@img.example.test", "credentials"],
    ["https://img.example.test/?a=1", "query"],
    ["https://img.example.test/?", "query"],
    ["https://img.example.test/#top", "fragment"],
    ["https://img.example.test#", "fragment"],
  ])("rejects %s whatever the APP_ENV (%s)", async (bad, hint) => {
    for (const APP_ENV of ["production", "staging", "development"]) {
      const text = await message({ APP_ENV, [NAME]: bad });
      expect(text, `${APP_ENV} ${bad}`).toContain(NAME);
      expect(text).toContain(hint);
      expect(text, "the message never repeats the value").not.toContain("img.example.test");
    }
  });

  it("an r2.dev address (any subdomain) is refused in production with a clear message", async () => {
    for (const host of ["pub-0123456789abcdef.r2.dev", "r2.dev", "a.b.r2.dev", "PUB-ABC.R2.DEV"]) {
      const text = await message({ APP_ENV: "production", [NAME]: `https://${host}` });
      expect(text, host).toContain(NAME);
      expect(text).toContain("r2.dev");
      expect(text).toContain("custom domain");
      expect(text, "no value in the message").not.toContain("0123456789abcdef");
    }
  });

  it("an r2.dev address is allowed in staging and development", async () => {
    for (const APP_ENV of ["staging", "development"]) expect((await load({ APP_ENV, [NAME]: "https://pub-0123456789abcdef.r2.dev" }))[NAME]).toBeTruthy();
  });

  it("a look-alike host is not r2.dev", async () => {
    for (const host of ["r2.dev.example.test", "notr2.dev", "myr2.dev.test", "r2-dev.example.test"]) {
      expect((await load({ APP_ENV: "production", [NAME]: `https://${host}` }))[NAME], host).toBeTruthy();
    }
  });

  it("not setting it is fine", async () => {
    expect((await load({ APP_ENV: "production" }))[NAME]).toBeUndefined();
  });
});

describe("start-up information", () => {
  it("one line with the settings that matter and nothing secret", async () => {
    vi.resetModules();
    const { startupSummary, buildCommit } = await import("../src/lib/startup-info.js");
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    const env = actual.loadEnv({ ...BASE_ENV, APP_ENV: "staging", SCHEDULER_ENABLED: "true", CLIENT_IP_SOURCE: "header", CLIENT_IP_HEADER: "true-client-ip", RETENTION_DRY_RUN: "false" });
    const line = startupSummary(env, { RENDER_GIT_COMMIT: "0123456789abcdef0123456789abcdef01234567" });
    expect(line).toBe("APP_ENV=staging NODE_ENV=development client-ip=header scheduler=on retention=deleting file-links=on email=off commit=0123456");
    expect(line).not.toMatch(/secret|password|postgresql|org_x/);
    expect(buildCommit({})).toBeNull();
    expect(buildCommit({ GIT_COMMIT: "not a commit" })).toBeNull();
    expect(buildCommit({ GIT_COMMIT: "ABCDEF1234" })).toBe("abcdef1");
    expect(startupSummary(env, {})).toContain("commit=unknown");
  });

  it("the defaults: development, socket, scheduler on (as loaded), retention dry-run", async () => {
    vi.resetModules();
    const { startupSummary } = await import("../src/lib/startup-info.js");
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    expect(startupSummary(actual.loadEnv({ ...BASE_ENV }), {})).toBe("APP_ENV=development NODE_ENV=development client-ip=socket scheduler=on retention=dry-run file-links=on email=off commit=unknown");
  });

  it("an r2.dev stock address outside production gives one masked warning (no host in it)", async () => {
    vi.resetModules();
    const { startupWarnings } = await import("../src/lib/startup-info.js");
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    const warnings = startupWarnings(actual.loadEnv({ ...BASE_ENV, APP_ENV: "staging", PUBLIC_STOCK_IMAGE_BASE_URL: "https://pub-0123456789abcdef.r2.dev" }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("r2.dev");
    expect(warnings[0]).not.toContain("0123456789abcdef");
  });

  it("file links off (no secret or base) gives one masked warning and shows in the summary", async () => {
    vi.resetModules();
    const { startupWarnings, startupSummary } = await import("../src/lib/startup-info.js");
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    const { FILE_LINK_SECRET: _a, FILE_LINK_BASE_URL: _b, ...withoutLinks } = BASE_ENV;
    const env = actual.loadEnv(withoutLinks);
    expect(startupWarnings(env)).toEqual(["FILE_LINK_SECRET and FILE_LINK_BASE_URL are not set: staff file links are off (files show as unavailable)"]);
    expect(startupSummary(env, {})).toContain("file-links=off");
  });

  it("no warning for a custom domain, or when nothing is set", async () => {
    vi.resetModules();
    const { startupWarnings } = await import("../src/lib/startup-info.js");
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    expect(startupWarnings(actual.loadEnv({ ...BASE_ENV, APP_ENV: "staging", PUBLIC_STOCK_IMAGE_BASE_URL: "https://img.example.test" }))).toEqual([]);
    expect(startupWarnings(actual.loadEnv({ ...BASE_ENV }))).toEqual([]);
  });
});
