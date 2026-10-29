// scripts/smoke-test.ps1: it must stay quiet about secrets, and (where PowerShell 7 is installed) it must really pass against a running
// app with the checks that need no account. Fake data only; the app listens on 127.0.0.1 on a free port.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { newVehicleFake } from "./helpers/vehicle-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));

import { buildApp } from "../src/app.js";

const SCRIPT = "scripts/smoke-test.ps1";
const source = readFileSync(SCRIPT, "utf8");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
const hasPwsh = pwsh.status === 0;

describe("smoke-test.ps1 (static)", () => {
  it("never prints a token, a password or a signed address", () => {
    // Every Write-Host goes through Report / Skip, whose arguments are fixed texts; none may mention a secret variable.
    for (const line of source.split("\n").filter((l) => /Write-Host|Write-Output|Write-Verbose|Write-Debug|Out-Host/.test(l))) {
      expect(line, line).not.toMatch(/\$(admin|manager|operator|viewer|ct|customerPassword|password|token)\b|SMOKE_\w*PASSWORD|\.Body|sig=/);
    }
    expect(source).not.toMatch(/Start-Transcript|Set-PSDebug|\$VerbosePreference|\$DebugPreference|-Verbose/);
  });

  it("reads credentials only from the environment and carries none of its own", () => {
    expect(source).toContain("SMOKE_ADMIN_EMAIL");
    expect(source).not.toMatch(/password\s*=\s*"(?!\.\.\.")[^"$]/i);
    expect(source).not.toMatch(/https?:\/\/(?!example\.test|127\.0\.0\.1|your-api\.example\.test)[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it("covers the checks that were asked for", () => {
    for (const text of ["/health", "no-store", "nosniff", "staff login", "refused by the customer zone", "403", "notification stream", "429"]) {
      expect(source, text).toContain(text);
    }
  });
});

// Async on purpose: the app runs in THIS process, so a blocking spawn would stop it from answering.
function runScript(args: string[], env?: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("pwsh", ["-NoProfile", "-File", SCRIPT, ...args], { ...(env ? { env } : {}) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe.skipIf(!hasPwsh)("smoke-test.ps1 (against a running app)", () => {
  let app: FastifyInstance;
  let baseUrl = "";
  beforeAll(async () => {
    state.fake = newVehicleFake();
    app = await buildApp(); // the real rate limiter: the last check needs it
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
  });

  it("passes every check that needs no account, skips the rest, and prints nothing else", async () => {
    const run = await runScript(["-BaseUrl", baseUrl], { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "" });
    const lines = run.stdout.split(/\r?\n/).filter(Boolean);
    expect(run.stdout, run.stdout + run.stderr).not.toMatch(/^FAIL/m);
    expect(run.status).toBe(0);
    for (const line of lines) expect(line).toMatch(/^(PASS|SKIP) {2}\S|^all checks passed$/);
    expect(lines.filter((l) => l.startsWith("PASS")).length).toBeGreaterThanOrEqual(9);
    expect(lines.filter((l) => l.startsWith("SKIP")).length).toBeGreaterThanOrEqual(5);
    expect(run.stdout).toContain("PASS  repeated bad logins end in 429");
  }, 130_000);

  it("fails (exit 1) when the app is not there", async () => {
    const run = await runScript(["-BaseUrl", "http://127.0.0.1:9"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/^FAIL/m);
  }, 130_000);
});
