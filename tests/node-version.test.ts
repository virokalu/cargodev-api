// ONE Node version for the project: the major in .nvmrc is the Dockerfile's, CI's and the minimum in package.json, and an older Node
// fails clearly. Fake data only.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { problemWith, requiredMajor } = require("../scripts/check-node.cjs") as {
  problemWith: (version: string, required: number) => string | null;
  requiredMajor: () => number;
};

const text = (file: string) => readFileSync(file, "utf8");
const nvmrcMajor = Number(text(".nvmrc").trim().replace(/^v/, "").split(".")[0]);

describe("one Node version everywhere", () => {
  it(".nvmrc names a major", () => {
    expect(Number.isInteger(nvmrcMajor)).toBe(true);
    expect(requiredMajor()).toBe(nvmrcMajor);
  });

  it("the Dockerfile image is that major", () => {
    const image = /^ARG NODE_IMAGE=node:(\d+)\./m.exec(text("Dockerfile"));
    expect(image, "the Dockerfile has no ARG NODE_IMAGE=node:<version>").not.toBeNull();
    expect(Number(image![1])).toBe(nvmrcMajor);
  });

  it("package.json engines.node is that major or newer", () => {
    const engines = (JSON.parse(text("package.json")) as { engines: { node: string } }).engines.node;
    expect(engines).toBe(`>=${nvmrcMajor}.0.0`);
  });

  it("CI reads the version from .nvmrc and never names its own", () => {
    const ci = text(".github/workflows/ci.yml");
    expect(ci.match(/node-version-file: \.nvmrc/g)?.length).toBe(ci.match(/actions\/setup-node@/g)?.length);
    expect(ci).not.toMatch(/^\s*node-version: /m);
  });

  it("the README and the deployment guide name it", () => {
    expect(text("README.md")).toContain(`Node ${nvmrcMajor}`);
    expect(text("docs/deployment.md")).toContain(`Node ${nvmrcMajor}`);
  });

  it("npm test and npm run test:db check the version before the runner starts", () => {
    const scripts = (JSON.parse(text("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["pretest"]).toContain("check-node.cjs");
    expect(scripts["pretest:db"]).toContain("check-node.cjs");
  });
});

describe("an older Node fails clearly", () => {
  it("refuses an older major with a message that says what to do", () => {
    for (const old of ["12.11.1", "v18.17.0", "20.19.0", "22.17.0", "23.9.0"]) {
      const message = problemWith(old, 24);
      expect(message, old).not.toBeNull();
      expect(message).toContain("needs Node 24 or newer");
      expect(message).toContain(old.replace(/^v/, ""));
      expect(message).toContain("nvm use");
    }
  });

  it("accepts the required major and anything newer", () => {
    for (const fine of ["24.0.0", "24.22.1", "v26.5.0", "30.1.0"]) expect(problemWith(fine, 24), fine).toBeNull();
  });

  it("refuses a version it cannot read", () => {
    expect(problemWith("nonsense", 24)).not.toBeNull();
  });
});

describe("the test setup files fail on an older Node", () => {
  it("both setup files carry the check", () => {
    for (const file of ["tests/setup-env.ts", "tests/db/setup-env.ts"]) {
      expect(text(file)).toMatch(/< 24\)/);
      expect(text(file)).toContain("needs Node 24 or newer");
    }
  });
});
