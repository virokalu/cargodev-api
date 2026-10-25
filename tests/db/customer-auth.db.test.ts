// The customer zone against real Postgres: the SQL the in-memory fake cannot prove (NULL filters,
// unique indexes, foreign keys, increments). Parallel behaviour is in customer-auth.concurrency.db.test.ts.

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
const ORG = "org_test_a"; // equals ORG_ID in tests/db/setup-env.ts
const OTHER_ORG = "org_test_b";
const PASSWORD = ["example", "Password", "12345"].join("-");
const NEW_PASSWORD = ["example", "Another", "Password", "678"].join("-");

let app: FastifyInstance;
const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/customer/v1${path}`, payload: body as object, headers });
const code = () => /\b(\d{6})\b/.exec(sent.at(-1)?.text ?? "")![1]!;

beforeAll(async () => {
  app = await buildApp({ rateLimit: false });
});
afterAll(async () => {
  await app.close();
  await closeTestPrisma();
});
beforeEach(async () => {
  await resetDb(prisma);
  for (const id of [ORG, OTHER_ORG]) await prisma.organization.create({ data: { id, name: `Org ${id}` } });
  sent.length = 0;
  resetShadowLockouts();
  identifierLimiter.reset();
});

async function signUp(email: string) {
  await call("/auth/register", { name: "Real Db Person", email });
  return call("/auth/verify-email", { email, code: code(), password: PASSWORD });
}

describe("the whole flow on real SQL", () => {
  it("register, verify, login, read the profile, refresh, log out", async () => {
    expect((await signUp("flow@example.test")).statusCode).toBe(200);

    const login = (await call("/auth/login", { email: "flow@example.test", password: PASSWORD })).json().data;
    const me = await app.inject({ method: "GET", url: "/api/customer/v1/me", headers: { authorization: `Bearer ${login.accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data).toMatchObject({ email: "flow@example.test", language: "en" });

    const refreshed = (await call("/auth/refresh", { refreshToken: login.refreshToken })).json().data;
    expect((await call("/auth/refresh", { refreshToken: login.refreshToken })).statusCode).toBe(403);
    expect((await call("/auth/logout", { refreshToken: refreshed.refreshToken })).statusCode).toBe(200);
    expect((await call("/auth/refresh", { refreshToken: refreshed.refreshToken })).statusCode).toBe(403);

    const sessions = await prisma.customerSession.findMany({ where: { org_id: ORG } });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(await prisma.activityLog.count({ where: { org_id: ORG, action: { startsWith: "CUSTOMER_" } } })).toBe(2);
  });

  it("the new columns keep their intended defaults: a registered customer is unverified, passwordless and not login-enabled", async () => {
    await call("/auth/register", { name: "Pending Person", email: "pending@example.test" });
    const row = await prisma.user.findFirstOrThrow({ where: { org_id: ORG, email: "pending@example.test" } });
    expect(row).toMatchObject({ userType: "CUSTOMER", password: null, emailVerifiedAt: null, loginEnabled: false, deletedAt: null, language: null });
  });
});

describe("one-time codes (NULL and increment semantics)", () => {
  it("a new code retires the old one: exactly one live (usedAt IS NULL) row", async () => {
    await call("/auth/register", { name: "N", email: "codes@example.test" });
    await call("/auth/resend-verification", { email: "codes@example.test" });
    await call("/auth/resend-verification", { email: "codes@example.test" });
    const all = await prisma.otpCode.findMany({ where: { org_id: ORG } });
    expect(all).toHaveLength(3);
    expect(all.filter((o) => o.usedAt === null)).toHaveLength(1);
  });

  it("attempts count up by one per check in the database, and a spent code stays spent", async () => {
    await call("/auth/register", { name: "N", email: "attempts@example.test" });
    const live = code();
    const wrong = live === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await call("/auth/verify-email", { email: "attempts@example.test", code: wrong, password: PASSWORD });
    const otp = await prisma.otpCode.findFirstOrThrow({ where: { org_id: ORG, usedAt: null } });
    expect(otp.attempts).toBe(5);
    expect((await call("/auth/verify-email", { email: "attempts@example.test", code: live, password: PASSWORD })).statusCode).toBe(400);
    expect((await prisma.otpCode.findFirstOrThrow({ where: { id: otp.id } })).attempts).toBe(5);
  });

  it("the stored code is an HMAC, never the code", async () => {
    await call("/auth/register", { name: "N", email: "hmac@example.test" });
    const otp = await prisma.otpCode.findFirstOrThrow({ where: { org_id: ORG } });
    expect(otp.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(otp.codeHash).not.toContain(code());
  });
});

describe("addresses and organisations", () => {
  it("the same address can exist in two organisations, but not twice in one", async () => {
    await prisma.user.create({ data: { org_id: ORG, userType: "CUSTOMER", name: "A", email: "same@example.test" } });
    await prisma.user.create({ data: { org_id: OTHER_ORG, userType: "CUSTOMER", name: "B", email: "same@example.test" } });
    await expect(prisma.user.create({ data: { org_id: ORG, userType: "CUSTOMER", name: "C", email: "same@example.test" } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("registering an address that exists in ANOTHER org does not touch that org", async () => {
    await prisma.user.create({ data: { org_id: OTHER_ORG, userType: "CUSTOMER", name: "B", email: "elsewhere@example.test" } });
    await call("/auth/register", { name: "Here", email: "elsewhere@example.test" });
    expect(await prisma.user.count({ where: { org_id: OTHER_ORG } })).toBe(1);
    expect(await prisma.user.count({ where: { org_id: ORG, email: "elsewhere@example.test" } })).toBe(1);
  });
});

describe("delete account against real foreign keys", () => {
  it("anonymises the row, frees the address, ends sessions, removes codes and device tokens, and keeps the vehicle", async () => {
    await signUp("gone@example.test");
    const customer = await prisma.user.findFirstOrThrow({ where: { org_id: ORG, email: "gone@example.test" } });
    await prisma.vehicle.create({ data: { org_id: ORG, serialPrefix: "FC", serialNumber: 1, serial: "FC1", customerId: customer.id } });
    await prisma.deviceToken.create({ data: { org_id: ORG, userId: customer.id, expoPushToken: "ExponentPushToken[example-db]", platform: "ios" } });
    const login = (await call("/auth/login", { email: "gone@example.test", password: PASSWORD })).json().data;

    const res = await call("/auth/delete-account", { password: PASSWORD }, { authorization: `Bearer ${login.accessToken}` });
    expect(res.statusCode).toBe(200);

    const after = await prisma.user.findFirstOrThrow({ where: { id: customer.id } });
    expect(after).toMatchObject({ name: "Deleted customer", email: null, password: null, loginEnabled: false, emailVerifiedAt: null });
    expect(after.deletedAt).not.toBeNull();
    expect(await prisma.customerSession.count({ where: { userId: customer.id, revokedAt: null } })).toBe(0);
    expect(await prisma.deviceToken.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.otpCode.count({ where: { userId: customer.id } })).toBe(0);
    expect((await prisma.vehicle.findFirstOrThrow({ where: { serial: "FC1" } })).customerId).toBe(customer.id);

    // The unique (org, email) slot is free: two deleted customers can both have a null email, and the address can be reused.
    expect((await call("/auth/register", { name: "Back Again", email: "gone@example.test" })).statusCode).toBe(202);
    expect(await prisma.user.count({ where: { org_id: ORG, email: "gone@example.test" } })).toBe(1);
  });
});

describe("password reset on real SQL", () => {
  it("a reset ends every session and the old password stops working", async () => {
    await signUp("reset@example.test");
    const login = (await call("/auth/login", { email: "reset@example.test", password: PASSWORD })).json().data;
    await call("/auth/forgot-password", { email: "reset@example.test" });
    expect((await call("/auth/reset-password", { email: "reset@example.test", code: code(), newPassword: NEW_PASSWORD })).statusCode).toBe(200);
    expect((await call("/auth/refresh", { refreshToken: login.refreshToken })).statusCode).toBe(403);
    expect((await call("/auth/login", { email: "reset@example.test", password: PASSWORD })).statusCode).toBe(400);
    expect((await call("/auth/login", { email: "reset@example.test", password: NEW_PASSWORD })).statusCode).toBe(200);
  });
});
