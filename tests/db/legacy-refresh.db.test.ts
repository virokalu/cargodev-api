// The original mobile contract says a refresh token is single-use (docs/legacy/mobile-api-reference.md line 29) and that every failure is
// 403 "Session expired. Please sign in again." (lines 67-69). When several refreshes with the SAME token arrive at the same instant, only
// real concurrent connections can show that exactly one wins and every loser gets that same 403, never a 500. Fake data only.

import bcrypt from "bcryptjs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { ServiceError } from "../../src/lib/errors.js";
import { loginMobile, refreshMobileToken } from "../../src/services/mobile-auth.service.js";

const prisma = getTestPrisma();
const ORG = "org_test_a";
const PASSWORD = ["example", "Db", "Password", "12345"].join("-");
const meta = { ip: "127.0.0.1" };

beforeEach(async () => {
  expect(Number(process.env["TEST_DATABASE_POOL_MAX"] ?? 10)).toBeGreaterThanOrEqual(2);
  await resetDb(prisma);
  await prisma.organization.create({ data: { id: ORG, name: ORG } });
  await prisma.user.create({
    data: { id: "staff_one", org_id: ORG, userType: "STAFF", name: "One", role: "MANAGER", loginEnabled: true, email: "one@example.test", password: await bcrypt.hash(PASSWORD, 4) },
  });
});
afterAll(closeTestPrisma);

describe("refresh tokens are single-use, also when several arrive at once", () => {
  it("six simultaneous refreshes with one token: exactly one new pair, five identical 403 'Session expired. Please sign in again.'", async () => {
    const first = await loginMobile({ email: "one@example.test", password: PASSWORD }, meta);
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => refreshMobileToken({ refreshToken: first.refreshToken }, meta)));

    const wins = settled.filter((r) => r.status === "fulfilled");
    const losses = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(5);
    for (const loss of losses) {
      expect(loss.reason).toBeInstanceOf(ServiceError);
      expect((loss.reason as ServiceError).code).toBe("FORBIDDEN");
      expect((loss.reason as ServiceError).message).toBe("Session expired. Please sign in again.");
    }
    // one live refresh token remains for the person (the one that was just issued)
    expect(await prisma.refreshToken.count({ where: { userId: "staff_one", revokedAt: null } })).toBe(1);
  });
});
