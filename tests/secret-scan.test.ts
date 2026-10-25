// The shared secret scan (scripts/secret-scan.sh): connection strings with credentials, and the rule that
// .env.example holds placeholders only. Runs the real script with `sh`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "secret-scan.sh");
const dir = mkdtempSync(path.join(tmpdir(), "scan-"));

/** Runs the scan over one file with the given name and content. */
function scan(name: string, content: string) {
  writeFileSync(path.join(dir, name), content);
  // Paths are read relative to the cwd, like git prints them.
  const result = spawnSync("sh", [script], { cwd: dir, input: `${name}\n`, encoding: "utf8" });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

// Built at runtime so this file itself never contains a credentialed URL.
const url = (user: string, pass: string, host = "db.internal.test") => ["postgresql://", user, ":", pass, "@", host, ":5432/app"].join("");
const REAL = "Xk29fj3Lqp0";

describe("connection strings with credentials", () => {
  it.each([
    ["a real-looking password", url("app", REAL)],
    ["a real-looking password with a placeholder-looking user", url("user", REAL)],
    ["a cloud pooler url", url("postgres.abcdefghijkl", "Hq8w2zRt", "aws-0-region.pooler.cloud.test")],
    ["the postgres:// scheme", `postgres://app:${REAL}@db.internal.test/app`],
  ])("is flagged: %s", (_n, value) => {
    const r = scan(".env.example", `DATABASE_URL="${value}"\n`);
    expect(r.code).toBe(1);
    expect(r.output).toContain("Connection string with credentials");
  });

  it("the report masks the credentials", () => {
    const r = scan("notes.md", `see ${url("app", REAL)}\n`);
    expect(r.code).toBe(1);
    expect(r.output).not.toContain(REAL);
    expect(r.output).not.toContain("app:");
  });

  it.each([
    ["the word PASSWORD", url("USER", "PASSWORD", "HOST")],
    ["lower case password", url("user", "password")],
    ["a value containing example", url("tester", "example-throwaway")],
    ["changeme", url("app", "changeme")],
    ["an angle-bracket placeholder", url("app", "<your-password>")],
    ["shell variables", "postgresql://${USER_NAME}:${PASSWORD}@127.0.0.1:5432/app"],
    ["no password at all", "postgresql://app@db.internal.test/app"],
  ])("is accepted: %s", (_n, value) => {
    expect(scan(".env.example", `DATABASE_URL=${value}\n`).code).toBe(0);
  });

  it.each(["a.ts", "a.md", "a.yml", "a.json", "a.sh", ".env.example"])("is checked in %s", (name) => {
    expect(scan(name, `x ${url("app", REAL)}\n`).code).toBe(1);
  });

  it("is not checked in lock files", () => {
    expect(scan("package-lock.json", url("app", REAL)).code).toBe(0);
  });
});

describe(".env.example contains only placeholders", () => {
  const file = path.join(root, ".env.example");

  it("exists, so a new developer has something to copy", () => {
    expect(existsSync(file)).toBe(true);
  });

  it("passes the same scan CI runs", () => {
    const result = spawnSync("sh", [script], { cwd: root, input: ".env.example\n", encoding: "utf8" });
    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);
  });

  it("has no credentialed connection string unless the password is a placeholder", () => {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/postgres(?:ql)?:\/\/([^:/@\s"']+):([^@\s"']+)@/g)) {
      expect(match[2]!.toLowerCase()).toMatch(/example|changeme|placeholder|^password$|^<.*>$|\$/);
    }
  });
});

describe(".gitignore", () => {
  it("ignores real env files but keeps .env.example, in that order", () => {
    const lines = readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    const at = (pattern: string) => lines.indexOf(pattern);
    expect(at(".env")).toBeGreaterThanOrEqual(0);
    expect(at(".env.*")).toBeGreaterThan(at(".env"));
    expect(at("!.env.example")).toBeGreaterThan(at(".env.*"));
    expect(lines).not.toContain(".env*");
  });
});
