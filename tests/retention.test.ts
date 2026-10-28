// Retention settings and how the daily job runs retention. The deletions themselves are proved against real Postgres in
// tests/db/retention.db.test.ts. Fake data only.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  retention: undefined as undefined | ((orgId: string) => Promise<unknown>),
}));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => ({ organization: { findMany: async () => [{ id: "org_one" }, { id: "org_two" }] } }),
}));
vi.mock("../src/services/reminder.service.js", () => ({
  runDailyVehicleChecks: async () => ({ shippedTransitions: 1, errors: [] as string[] }),
}));
vi.mock("../src/services/retention.service.js", () => ({
  runRetention: (orgId: string) => state.retention!(orgId),
}));

import { defaultJobs } from "../src/scheduler/index.js";

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:password@example.test:5432/dbname",
  MOBILE_JWT_SECRET: "mobile-secret-value-0123456789abcdefXX",
  ORG_ID: "org_x",
};
async function loadEnvFresh(extra: Record<string, string>) {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
  return actual.loadEnv({ ...BASE_ENV, ...extra });
}

describe("retention settings", () => {
  it("RETENTION_DRY_RUN is true unless set to false, in every environment", async () => {
    for (const NODE_ENV of ["development", "test", "production"]) {
      const env = await loadEnvFresh({ NODE_ENV, ...(NODE_ENV === "production" ? { CLIENT_IP_SOURCE: "socket" } : {}) });
      expect(env.RETENTION_DRY_RUN, NODE_ENV).toBe(true);
    }
    expect((await loadEnvFresh({ RETENTION_DRY_RUN: "true" })).RETENTION_DRY_RUN).toBe(true);
    expect((await loadEnvFresh({ RETENTION_DRY_RUN: "false" })).RETENTION_DRY_RUN).toBe(false);
  });

  it.each(["yes", "1", "FALSE", "False", "off", "0"])("RETENTION_DRY_RUN=%s is rejected (only the exact words true and false)", async (bad) => {
    await expect(loadEnvFresh({ RETENTION_DRY_RUN: bad })).rejects.toThrow("RETENTION_DRY_RUN");
  });

  it("default to 30 / 30 / 180 / 14 days", async () => {
    const env = await loadEnvFresh({});
    expect([env.RETENTION_OTP_DAYS, env.RETENTION_SESSION_DAYS, env.RETENTION_ALERT_DAYS, env.UNVERIFIED_ACCOUNT_DAYS]).toEqual([30, 30, 180, 14]);
  });

  it("can be set", async () => {
    const env = await loadEnvFresh({ RETENTION_OTP_DAYS: "7", RETENTION_SESSION_DAYS: "10", RETENTION_ALERT_DAYS: "365", UNVERIFIED_ACCOUNT_DAYS: "3" });
    expect([env.RETENTION_OTP_DAYS, env.RETENTION_SESSION_DAYS, env.RETENTION_ALERT_DAYS, env.UNVERIFIED_ACCOUNT_DAYS]).toEqual([7, 10, 365, 3]);
  });

  it.each(["RETENTION_OTP_DAYS", "RETENTION_SESSION_DAYS", "RETENTION_ALERT_DAYS", "UNVERIFIED_ACCOUNT_DAYS"])("%s rejects 0 (a typo must not wipe everything), negatives, fractions, text and huge values", async (name) => {
    for (const bad of ["0", "-1", "1.5", "abc", "3651"]) await expect(loadEnvFresh({ [name]: bad }), `${name}=${bad}`).rejects.toThrow(name);
  });

  it("accepts the bounds 1 and 3650", async () => {
    await expect(loadEnvFresh({ RETENTION_OTP_DAYS: "1", RETENTION_ALERT_DAYS: "3650" })).resolves.toBeTruthy();
  });
});

describe("the daily job runs retention after the vehicle checks, for every org", () => {
  beforeEach(() => {
    state.retention = async () => ({ otpCodes: 2, customerSessions: 1, refreshTokens: 0, readAlerts: 0, unverifiedAccounts: 0, skipped: 0, dryRun: false });
  });

  it("adds the retention counts to the job's counts", async () => {
    const result = await defaultJobs()[0]!.run();
    expect(result).toMatchObject({ orgs: 2, failedOrgs: 0, counts: { shippedTransitions: 2, otpCodes: 4, customerSessions: 2, retentionSkippedOrgs: 0 } });
  });

  it("a retention failure is reported for that org but never stops the vehicle checks or the other org", async () => {
    const seen: string[] = [];
    state.retention = async (orgId) => {
      seen.push(orgId);
      if (orgId === "org_one") throw new Error("boom");
      return { otpCodes: 3, customerSessions: 0, refreshTokens: 0, readAlerts: 0, unverifiedAccounts: 0, skipped: 0, dryRun: false };
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await defaultJobs()[0]!.run();
    expect(seen).toEqual(["org_one", "org_two"]);
    expect(result).toMatchObject({ orgs: 2, failedOrgs: 1, counts: { shippedTransitions: 2, otpCodes: 3 } });
  });

  it("counts the orgs skipped for want of an administrator", async () => {
    state.retention = async () => ({ otpCodes: 0, customerSessions: 0, refreshTokens: 0, readAlerts: 0, unverifiedAccounts: 0, skipped: 1, dryRun: false });
    const result = await defaultJobs()[0]!.run();
    expect(result).toMatchObject({ counts: { retentionSkippedOrgs: 2 } });
  });
});

describe("one masked summary line per run", () => {
  it("is logged once per run, with counts only (never an org id), and says when it is a dry run", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    state.retention = async () => ({ otpCodes: 2, customerSessions: 1, refreshTokens: 0, readAlerts: 3, unverifiedAccounts: 4, skipped: 0, dryRun: true });
    await defaultJobs()[0]!.run();
    expect(lines).toHaveLength(1); // two orgs, one line
    expect(lines[0]).toBe("retention DRY RUN, nothing removed, would remove: otpCodes=4 customerSessions=2 refreshTokens=0 readAlerts=6 unverifiedAccounts=8 skippedOrgs=0");
    expect(lines[0]).not.toMatch(/org_one|org_two/);
  });

  it("says 'removed' when the job is switched on, and starts from zero on every run", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    state.retention = async () => ({ otpCodes: 1, customerSessions: 0, refreshTokens: 0, readAlerts: 0, unverifiedAccounts: 0, skipped: 0, dryRun: false });
    const job = defaultJobs()[0]!;
    await job.run();
    await job.run();
    expect(lines).toEqual([
      "retention removed: otpCodes=2 customerSessions=0 refreshTokens=0 readAlerts=0 unverifiedAccounts=0 skippedOrgs=0",
      "retention removed: otpCodes=2 customerSessions=0 refreshTokens=0 readAlerts=0 unverifiedAccounts=0 skippedOrgs=0",
    ]);
  });
});
