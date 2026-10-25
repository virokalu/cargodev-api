// The safety guard for the real-database harness. These run in the normal `npm test` (no database
// needed): the guard is what stops the harness, which DROPS the public schema, from ever being
// aimed at a database that matters.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HARNESS_SENTINEL,
  UnsafeTestDatabaseError,
  assertSafeTestDatabaseUrl,
  decideSchemaWipe,
} from "./db/guard.js";

const ok = "postgresql://postgres:example-throwaway@127.0.0.1:55432/cargodev_test";
const check = (url: string | undefined, env: Record<string, string | undefined> = {}) => assertSafeTestDatabaseUrl(url, env);

describe("assertSafeTestDatabaseUrl: accepted", () => {
  it.each([
    "postgresql://user:password@localhost:5432/cargodev_test",
    "postgresql://user:password@127.0.0.1:55432/cargodev_test",
    "postgres://user:password@[::1]:5432/cargodev_test",
    "postgresql://user:password@LOCALHOST/cargodev_test",
    "postgresql://user:password@localhost:5432/cargodev_test_ci_run_42",
  ])("%s", (url) => {
    expect(() => check(url)).not.toThrow();
  });

  it("returns the parsed parts and the original url for the driver", () => {
    expect(check(ok)).toMatchObject({ host: "127.0.0.1", port: 55432, database: "cargodev_test", user: "postgres", url: ok });
  });

  it("accepts the CI service container host only when CI=true", () => {
    const url = "postgresql://user:password@postgres:5432/cargodev_test";
    expect(() => check(url, { CI: "true" })).not.toThrow();
    expect(() => check(url, {})).toThrow(UnsafeTestDatabaseError);
    expect(() => check(url, { CI: "false" })).toThrow(UnsafeTestDatabaseError);
  });
});

describe("assertSafeTestDatabaseUrl: refused", () => {
  it.each([undefined, "", "   "])("a missing URL (%j) says how to start the database", (value) => {
    expect(() => check(value)).toThrow(/TEST_DATABASE_URL is not set/);
    expect(() => check(value)).toThrow(/db:test:up/);
  });

  it.each([
    ["a remote hostname", "postgresql://user:password@db.example.com:5432/cargodev_test"],
    ["a cloud-style hostname", "postgresql://user:password@pooler.region.example-cloud.net:6543/cargodev_test"],
    ["a private network address", "postgresql://user:password@10.0.0.5:5432/cargodev_test"],
    ["a public IP", "postgresql://user:password@203.0.113.9:5432/cargodev_test"],
    ["localhost as a prefix of another host", "postgresql://user:password@localhost.evil.example.com/cargodev_test"],
    ["localhost as a user name (the host is elsewhere)", "postgresql://localhost@db.example.com/cargodev_test"],
    ["0.0.0.0", "postgresql://user:password@0.0.0.0:5432/cargodev_test"],
  ])("%s", (_name, url) => {
    expect(() => check(url)).toThrow(UnsafeTestDatabaseError);
    expect(() => check(url)).toThrow(/Only localhost/);
  });

  it.each(["host", "hostaddr", "service", "servicefile"])(
    "a ?%s= parameter that could redirect the connection elsewhere",
    (param) => {
      expect(() => check(`postgresql://user:password@localhost:5432/cargodev_test?${param}=db.example.com`)).toThrow(/redirect the connection/);
    }
  );

  it.each([
    "postgresql://user:password@localhost:5432/postgres",
    "postgresql://user:password@localhost:5432/cargodev",
    "postgresql://user:password@localhost:5432/production",
    "postgresql://user:password@localhost:5432/my_cargodev_test",
    "postgresql://user:password@localhost:5432/",
    "postgresql://user:password@localhost:5432",
  ])("a database name that is not a cargodev_test database: %s", (url) => {
    expect(() => check(url)).toThrow(/must start with "cargodev_test"/);
  });

  it.each(["mysql://u:p@localhost:3306/cargodev_test", "http://localhost/cargodev_test", "file:./cargodev_test"])(
    "a non-postgres URL: %s",
    (url) => {
      expect(() => check(url)).toThrow(/postgres/);
    }
  );

  it("a malformed URL", () => {
    expect(() => check("not a url at all")).toThrow(/not a valid URL/);
  });

  it("never puts the password in an error message", () => {
    // Built at runtime so no secret-looking literal sits in the source (the secret scan has no allow-list).
    const secret = ["hunter2", "do", "not", "leak"].join("-");
    for (const url of [
      `postgresql://user:${secret}@db.example.com/cargodev_test`,
      `postgresql://user:${secret}@localhost/production`,
      `mysql://u:${secret}@localhost/cargodev_test`,
      `postgresql://user:${secret}@localhost/cargodev_test?host=elsewhere`,
      `postgresql://user:${secret}@[broken`,
    ]) {
      let message = "";
      try {
        check(url);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
  });

  it("states that nothing was changed", () => {
    expect(() => check("postgresql://user:password@db.example.com/cargodev_test")).toThrow(/Nothing was changed/);
  });
});

describe("the guard never consults the application's DATABASE_URL", () => {
  const prod = "postgresql://prod:example-secret@db.prod.example.com:5432/cargodev";

  it("a real-looking DATABASE_URL in the environment does not make an unset TEST_DATABASE_URL acceptable", () => {
    expect(() => check(undefined, { DATABASE_URL: prod })).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it("and does not affect a valid TEST_DATABASE_URL either way", () => {
    expect(() => check(ok, { DATABASE_URL: prod })).not.toThrow();
    expect(check(ok, { DATABASE_URL: prod }).host).toBe("127.0.0.1");
  });

  it("no harness source reads DATABASE_URL (setup-env only overwrites it with an unreachable address)", () => {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "db");
    const files = [dir, path.join(dir, "helpers")].flatMap((d) =>
      readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => path.join(d, f))
    );
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const reads = /process\.env(\.DATABASE_URL|\[["']DATABASE_URL["']\])(?!\s*=[^=])/.test(source);
      expect(reads, `${path.basename(file)} must not read DATABASE_URL`).toBe(false);
    }
    const setup = readFileSync(path.join(dir, "setup-env.ts"), "utf8");
    expect(setup).toMatch(/DATABASE_URL"\] = "postgresql:\/\/user:password@invalid\.invalid/);
  });
});

describe("decideSchemaWipe: only an empty or harness-made database may be wiped", () => {
  it("an empty database is fine", () => {
    expect(decideSchemaWipe({ tableCount: 0, comment: null })).toBe("empty");
  });
  it("a database this harness built earlier is fine", () => {
    expect(decideSchemaWipe({ tableCount: 23, comment: HARNESS_SENTINEL })).toBe("harness");
  });
  it("a database that has tables but no harness marker is refused (e.g. a real database behind a tunnel)", () => {
    expect(decideSchemaWipe({ tableCount: 23, comment: null })).toBe("refuse");
    expect(decideSchemaWipe({ tableCount: 1, comment: "something else" })).toBe("refuse");
    expect(decideSchemaWipe({ tableCount: 400, comment: "standard public schema" })).toBe("refuse");
  });
  it("a marker with a different value does not count, even with no tables it is simply empty", () => {
    expect(decideSchemaWipe({ tableCount: 0, comment: "other" })).toBe("empty");
  });
});
