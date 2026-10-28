// scripts/check-build-inputs.sh: every file the Docker build copies must be in the COMMIT. Runs the real script with `sh` against
// throwaway git repositories in a temp folder (this repository's index and history are never touched). Fake data only.
// Starting processes is slow on Windows, so each case checks several things in one run.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "check-build-inputs.sh");
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const DOCKERFILE = `FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
FROM node:24-slim AS runtime
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
CMD ["node", "dist/server.js"]
`;
const DOCKERIGNORE = `.env
.env.*
node_modules
dist
tests
docs
*.md
!package.json
*.sql
scripts
`;
const COMPLETE: Record<string, string> = {
  Dockerfile: DOCKERFILE,
  ".dockerignore": DOCKERIGNORE,
  "package.json": "{}",
  "package-lock.json": "{}",
  ".npmrc": "ignore-scripts=true",
  "tsconfig.json": "{}",
  "tsconfig.build.json": "{}",
  "prisma/schema.prisma": "// schema",
  "prisma/migrations/1_init/migration.sql": "-- sql",
  "src/server.ts": "export {};",
  "README.md": "# readme",
};

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

/** A new repository with `files` committed (a value of null is written to disk but NOT committed). */
function repo(files: Record<string, string | null>) {
  const dir = mkdtempSync(path.join(tmpdir(), "inputs-"));
  made.push(dir);
  const write = (name: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  };
  git(dir, "init", "-q");
  for (const [name, content] of Object.entries(files)) if (content !== null) write(name, content);
  git(dir, "add", "-A"); // inside the throwaway repository only
  git(dir, "commit", "-q", "--allow-empty", "-m", "test");
  for (const [name, content] of Object.entries(files)) if (content === null) write(name, COMPLETE[name] ?? "x"); // on disk only
  return dir;
}

function check(dir: string, ref?: string) {
  const result = spawnSync("sh", ref ? [script, ref] : [script], { cwd: dir, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const without = (...names: string[]) => Object.fromEntries(Object.entries(COMPLETE).filter(([n]) => !names.includes(n)));

describe("a complete commit", () => {
  it("passes and says how many sources it checked; --from stages and --chown flags do not confuse it; *.md, *.sql and scripts in .dockerignore leave the sources alone", () => {
    const { code, out } = check(repo(COMPLETE));
    expect(code).toBe(0);
    expect(out).toMatch(/OK, every one of the 8 COPY\/ADD sources/);
  });
});

describe("the Render failure: the Dockerfile is not in the commit", () => {
  it("fails and names the Dockerfile when it is missing from the commit", () => {
    const { code, out } = check(repo(without("Dockerfile")));
    expect(code).toBe(1);
    expect(out).toContain("Dockerfile: not in commit");
  });

  it("fails when the Dockerfile exists on disk but was never committed (the untracked-file case), and when a needed file is only on disk", () => {
    const { code, out } = check(repo({ ...COMPLETE, Dockerfile: null }));
    expect(code).toBe(1);
    expect(out).toContain("Dockerfile: not in commit");
    const second = check(repo({ ...COMPLETE, "tsconfig.build.json": null }));
    expect(second.code).toBe(1);
    expect(second.out).toContain("tsconfig.build.json: no file");
  });

  it("fails for a wrong capital letter, pointing at the file it found", () => {
    const { code, out } = check(repo({ ...without("Dockerfile"), dockerfile: DOCKERFILE }));
    expect(code).toBe(1);
    expect(out).toContain("something similar is at: dockerfile");
  });

  it("fails for a Dockerfile in a subfolder", () => {
    const { code, out } = check(repo({ ...without("Dockerfile"), "docker/Dockerfile": DOCKERFILE }));
    expect(code).toBe(1);
    expect(out).toContain("docker/Dockerfile");
  });

  it("checks the commit you name, not the one you are on; an unreadable commit is exit 2, not a pass", () => {
    const dir = repo(COMPLETE);
    git(dir, "rm", "-q", "--cached", "Dockerfile");
    git(dir, "commit", "-q", "-m", "drop the Dockerfile");
    expect(check(dir).code).toBe(1); // HEAD has no Dockerfile
    expect(check(dir, "HEAD~1").code).toBe(0); // the commit before it does
    const unreadable = check(dir, "no-such-commit");
    expect(unreadable.code).toBe(2);
    expect(unreadable.out).toContain("cannot read commit");
  });
});

describe("every COPY source must be in the commit", () => {
  it("lists EVERY missing source (files and whole folders), not only the first; a lookalike name does not count", () => {
    const files = { ...without("package.json", "package-lock.json", ".npmrc", "tsconfig.json", "tsconfig.build.json"), "tsconfig.json.bak": "{}", "package.json.old": "{}" };
    for (const name of Object.keys(files)) if (name.startsWith("src/") || name.startsWith("prisma/")) delete (files as Record<string, string>)[name];
    const { code, out } = check(repo(files));
    expect(code).toBe(1);
    for (const missing of ["package.json", "package-lock.json", ".npmrc", "tsconfig.json", "tsconfig.build.json", "src", "prisma"]) expect(out, missing).toContain(`${missing}: no file`);
  });
});

describe("only the names count, and only in the commit", () => {
  it("a file that merely ends with a source's name does not count, nor does the same name in another folder", () => {
    const files = { ...without("tsconfig.json", "package-lock.json"), "old-tsconfig.json": "{}", "docs/package-lock.json": "{}", "xpackage-lock.json": "{}" };
    const { code, out } = check(repo(files));
    expect(code).toBe(1);
    expect(out).toContain("tsconfig.json: no file");
    expect(out).toContain("package-lock.json: no file");
  });

  it("the Dockerfile is read AS COMMITTED: a COPY that exists only in the committed file is checked even if the file on disk was edited", () => {
    const dir = repo({ ...COMPLETE, Dockerfile: `${DOCKERFILE}COPY extra.txt ./\n` });
    writeFileSync(path.join(dir, "Dockerfile"), DOCKERFILE); // edited on disk after the commit
    const { code, out } = check(dir);
    expect(code).toBe(1);
    expect(out).toContain("extra.txt: no file");
  });

  it("and a COPY added to the Dockerfile on disk but not committed is not held against the commit", () => {
    const dir = repo(COMPLETE);
    writeFileSync(path.join(dir, "Dockerfile"), `${DOCKERFILE}COPY extra.txt ./\n`);
    expect(check(dir).code).toBe(0);
  });
});

describe(".dockerignore must not leave out what the build copies", () => {
  it("a root-level pattern (*.ts) does not reach into a folder: * does not cross a slash, as in Docker", () => {
    const files = { ...without("src/server.ts"), "src/deep/only.ts": "export {};", ".dockerignore": `${DOCKERIGNORE}*.ts\n` };
    expect(check(repo(files)).code).toBe(0);
    // ...but ** does
    expect(check(repo({ ...files, ".dockerignore": `${DOCKERIGNORE}**/*.ts\n` })).code).toBe(1);
  });

  it("fails for every way of excluding a source outright (plain name, leading slash and trailing slash, exact file)", () => {
    const { code, out } = check(repo({ ...COMPLETE, ".dockerignore": `${DOCKERIGNORE}prisma\n/src/\ntsconfig.build.json\n` }));
    expect(code).toBe(1);
    expect(out).toContain("prisma: every file in it is excluded by .dockerignore");
    expect(out).toContain("src: every file in it is excluded by .dockerignore");
    expect(out).toContain("tsconfig.build.json: every file in it is excluded by .dockerignore");
    expect(out).not.toContain("tsconfig.json: every file");
  });

  it("fails for ** patterns (src/** and **/package-lock.json)", () => {
    const { code, out } = check(repo({ ...COMPLETE, ".dockerignore": `${DOCKERIGNORE}src/**\n**/package-lock.json\n` }));
    expect(code).toBe(1);
    expect(out).toContain("src: every file in it is excluded");
    expect(out).toContain("package-lock.json: every file in it is excluded");
  });

  it("a negation puts the file back, excluding only SOME files of a source is fine, and no .dockerignore at all is fine", () => {
    expect(check(repo({ ...COMPLETE, ".dockerignore": `${DOCKERIGNORE}tsconfig.build.json\n!tsconfig.build.json\nsrc/**/*.test.ts\n`, "src/a.test.ts": "x" })).code).toBe(0);
    expect(check(repo(without(".dockerignore"))).code).toBe(0);
  });

  it("reads the .dockerignore AS COMMITTED, not the one on disk", () => {
    const dir = repo(COMPLETE);
    writeFileSync(path.join(dir, ".dockerignore"), `${DOCKERIGNORE}src\n`); // edited, not committed
    expect(check(dir).code).toBe(0);
  });
});

describe("it is read-only and wired in", () => {
  it("leaves the repository exactly as it was (no staging, no new files)", () => {
    const dir = repo({ ...COMPLETE, "tsconfig.build.json": null });
    const before = git(dir, "status", "--porcelain=v1", "--ignored").stdout;
    check(dir);
    expect(git(dir, "status", "--porcelain=v1", "--ignored").stdout).toBe(before);
  });

  it("the script runs no write command", () => {
    const code = readFileSync(script, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    for (const forbidden of ["git add", "git commit", "git push", "git reset", "git checkout", "git restore", "git rm", "git mv", "git stash", "git clean", "rm -", "mv ", "> /"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("this repository's own commit passes (a fresh clone has every file the image build copies)", () => {
    const { code, out } = check(root);
    expect(out).toContain("OK");
    expect(code).toBe(0);
  });

  it("CI runs it before the image is built, and the docs describe it", () => {
    const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
    const imageJob = ci.slice(ci.indexOf("  image:"), ci.indexOf("  secret-scan:"));
    expect(imageJob).toContain("sh scripts/check-build-inputs.sh");
    expect(imageJob.indexOf("check-build-inputs")).toBeLessThan(imageJob.indexOf("docker build"));
    expect(readFileSync(path.join(root, "docs", "deployment.md"), "utf8")).toContain("check-build-inputs");
  });
});
