// The shared secret scan (scripts/secret-scan.sh): connection strings with credentials, and the rule that
// .env.example holds placeholders only. Runs the real script with `sh`.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Each case starts a shell; on a loaded Windows machine that can take several seconds.
vi.setConfig({ testTimeout: 30_000 });

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

// ---------------------------------------------------------------------------------------------
describe("the pre-commit hook (.husky/pre-commit) in a throwaway repository", () => {
  // The real hook and the real scan are copied into a new repository, a file is STAGED there, and the hook is run.
  vi.setConfig({ testTimeout: 120_000 });
  const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd, encoding: "utf8" });

  function repoWithHook() {
    const repo = mkdtempSync(path.join(tmpdir(), "hook-"));
    git(repo, "init", "-q");
    mkdirSync(path.join(repo, "scripts"));
    mkdirSync(path.join(repo, ".husky"));
    copyFileSync(script, path.join(repo, "scripts", "secret-scan.sh"));
    copyFileSync(path.join(root, ".husky", "pre-commit"), path.join(repo, ".husky", "pre-commit"));
    return repo;
  }
  const runHook = (repo: string) => {
    const result = spawnSync("sh", [".husky/pre-commit"], { cwd: repo, encoding: "utf8" });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  };
  // Built at runtime so this file never contains a secret-looking assignment.
  const FAKE_SECRET = ["const ", "pass", "word", " = ", JSON.stringify("Xk29fj3Lqp0Zz"), ";\n"].join("");

  it("invokes the scan the way CI does: file names on stdin, one per line, from the staged list", () => {
    const hook = readFileSync(path.join(root, ".husky", "pre-commit"), "utf8");
    expect(hook).toContain("git diff --cached --name-only --diff-filter=ACM | sh scripts/secret-scan.sh");
    const code = hook.split(/\r?\n/).filter((line) => !line.trim().startsWith("#")).join(" ");
    expect(code).not.toContain("|| true"); // a finding must block the commit (the comments mention it; the code must not use it)
  });

  it("a staged fake secret blocks the commit (non-zero exit, names the file)", () => {
    const repo = repoWithHook();
    writeFileSync(path.join(repo, "leak.ts"), FAKE_SECRET);
    git(repo, "add", "--", "leak.ts");
    const { code, output } = runHook(repo);
    expect(code).not.toBe(0);
    expect(output).toContain("leak.ts");
  });

  it("a staged clean file passes, and so does a staged file whose value is a placeholder", () => {
    const repo = repoWithHook();
    writeFileSync(path.join(repo, "clean.ts"), "export const answer = 42;\n");
    writeFileSync(path.join(repo, "placeholder.ts"), `const apiKey = "example-placeholder-value";\n`);
    git(repo, "add", "--", "clean.ts", "placeholder.ts");
    expect(runHook(repo).code).toBe(0);
  });

  it("a fake secret that is NOT staged is not the hook's business (only the staged list is scanned)", () => {
    const repo = repoWithHook();
    writeFileSync(path.join(repo, "clean.ts"), "export const answer = 42;\n");
    git(repo, "add", "--", "clean.ts");
    writeFileSync(path.join(repo, "unstaged-leak.ts"), FAKE_SECRET);
    expect(runHook(repo).code).toBe(0);
  });

  it("a staged file that is DELETED in the commit is skipped, not an error", () => {
    const repo = repoWithHook();
    writeFileSync(path.join(repo, "gone.ts"), "export const x = 1;\n");
    git(repo, "add", "--", "gone.ts");
    git(repo, "commit", "-q", "-m", "add");
    git(repo, "rm", "-q", "--", "gone.ts");
    expect(runHook(repo).code).toBe(0);
  });

  it("the scan reads the file on disk, not the staged copy: a leak added after staging is caught (so stage what you scanned)", () => {
    const repo = repoWithHook();
    writeFileSync(path.join(repo, "later.ts"), "export const x = 1;\n");
    git(repo, "add", "--", "later.ts");
    writeFileSync(path.join(repo, "later.ts"), FAKE_SECRET); // edited after staging
    expect(runHook(repo).code).not.toBe(0);
  });
});
