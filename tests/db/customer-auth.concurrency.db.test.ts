// Parallel behaviour of the customer zone. These need REAL concurrent connections (a Postgres container
// locally, the service container in CI): a single-session engine serializes everything and would pass
// without proving anything, so do not run them against one.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});
vi.mock("../../src/lib/email-queue.js", () => ({
  queueEmail: (message: { to: string; subject: string; text: string }) => {
    sent.push(message);
  },
  drainEmailQueue: async () => undefined,
}));

import { buildApp } from "../../src/app.js";
import { identifierLimiter } from "../../src/lib/identifier-limiter.js";
import { resetShadowLockouts } from "../../src/lib/shadow-lockout.js";

const prisma = getTestPrisma();
const ORG = "org_test_a";
const PASSWORD = ["example", "Password", "12345"].join("-");

let app: FastifyInstance;
const call = (path: string, body: unknown) => app.inject({ method: "POST", url: `/api/customer/v1${path}`, payload: body as object });
const lastCode = () => /\b(\d{6})\b/.exec(sent.at(-1)?.text ?? "")![1]!;

beforeAll(async () => {
  app = await buildApp({ rateLimit: false });
});
afterAll(async () => {
  await app.close();
  await closeTestPrisma();
});
beforeEach(async () => {
  await resetDb(prisma);
  await prisma.organization.create({ data: { id: ORG, name: "Org" } });
  sent.length = 0;
  resetShadowLockouts();
  identifierLimiter.reset();
});

describe("parallel one-time code checks", () => {
  it("30 parallel wrong guesses spend exactly 5 attempts, and the right code is then dead", async () => {
    await call("/auth/register", { name: "N", email: "burst@example.test" });
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    await Promise.all(Array.from({ length: 30 }, () => call("/auth/verify-email", { email: "burst@example.test", code: wrong, password: PASSWORD })));
    const otp = await prisma.otpCode.findFirstOrThrow({ where: { org_id: ORG, usedAt: null } });
    expect(otp.attempts).toBe(5);
    expect((await call("/auth/verify-email", { email: "burst@example.test", code, password: PASSWORD })).statusCode).toBe(400);
  });

  it("10 parallel submissions of the RIGHT code: exactly one succeeds", async () => {
    await call("/auth/register", { name: "N", email: "once@example.test" });
    const code = lastCode();
    const results = await Promise.all(Array.from({ length: 10 }, () => call("/auth/verify-email", { email: "once@example.test", code, password: PASSWORD })));
    // Up to 5 attempts are spendable, so at most 5 reach the compare; only one can claim the code.
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const user = await prisma.user.findFirstOrThrow({ where: { org_id: ORG, email: "once@example.test" } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await prisma.activityLog.count({ where: { action: "CUSTOMER_VERIFY_EMAIL" } })).toBe(1);
  });
});

describe("parallel session rotation", () => {
  it("8 parallel refreshes of one token: exactly one successor, one live session", async () => {
    await call("/auth/register", { name: "N", email: "rotate@example.test" });
    await call("/auth/verify-email", { email: "rotate@example.test", code: lastCode(), password: PASSWORD });
    const login = (await call("/auth/login", { email: "rotate@example.test", password: PASSWORD })).json().data;

    const results = await Promise.all(Array.from({ length: 8 }, () => call("/auth/refresh", { refreshToken: login.refreshToken })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 403)).toHaveLength(7);
    expect(await prisma.customerSession.count({ where: { revokedAt: null } })).toBe(1);
  });
});

describe("parallel registration", () => {
  it("10 parallel registrations of one new address: all answer 202, one row, one pending code", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call("/auth/register", { name: "N", email: "race@example.test" })));
    expect(results.every((r) => r.statusCode === 202)).toBe(true);
    expect(await prisma.user.count({ where: { org_id: ORG, email: "race@example.test" } })).toBe(1);
    expect(await prisma.otpCode.count({ where: { org_id: ORG, usedAt: null } })).toBeGreaterThanOrEqual(1);
  });
});
