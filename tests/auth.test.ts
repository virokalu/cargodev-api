import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";
import { verifyStaffCredentials } from "../src/services/staff-auth.service.js";
import {
  loginMobile,
  logoutMobile,
  refreshMobileToken,
  revokeAllUserTokens,
} from "../src/services/mobile-auth.service.js";
import { ACCESS_TOKEN_TTL_SECONDS, AccessTokenError, signAccessToken, verifyAccessToken } from "../src/lib/mobile-jwt.js";

const GOOD = "example-Good-Passw0rd";
const meta = { ip: "203.0.113.7", userAgent: "test-agent" };

let fake: FakePrisma;

beforeEach(() => {
  resetShadowLockouts();
  fake = createFakePrisma();
  state.fake = fake;
  const base = { userType: "STAFF", loginEnabled: true, failedLoginAttempts: 0, lockoutUntil: null, phone: null };
  fake.seed(
    "user",
    { ...base, id: "staff_a1", org_id: ORG_A, name: "Staff A", email: "staff.a@example.test", role: "MANAGER", password: bcrypt.hashSync(GOOD, 4) },
    { ...base, id: "staff_b1", org_id: ORG_B, name: "Staff B", email: "staff.b@example.test", role: "MANAGER", password: bcrypt.hashSync(GOOD, 4) },
    { ...base, id: "staff_off", org_id: ORG_A, name: "Disabled", email: "off@example.test", role: "VIEWER", loginEnabled: false, password: bcrypt.hashSync(GOOD, 4) },
    { ...base, id: "cust_a1", org_id: ORG_A, name: "Buyer", email: "buyer@example.test", role: null, userType: "CUSTOMER", password: bcrypt.hashSync(GOOD, 4) }
  );
});

const userRow = (id: string) => fake.rows("user").find((r) => r["id"] === id)!;

describe("verifyStaffCredentials", () => {
  it("returns the user for valid credentials, matching the email case-insensitively", async () => {
    const user = await verifyStaffCredentials("  STAFF.A@Example.test ", GOOD);
    expect(user).toEqual({ id: "staff_a1", name: "Staff A", email: "staff.a@example.test", role: "MANAGER", orgId: ORG_A });
  });

  it("returns null for a wrong password and counts the failure", async () => {
    expect(await verifyStaffCredentials("staff.a@example.test", "example-wrong")).toBeNull();
    expect(userRow("staff_a1")["failedLoginAttempts"]).toBe(1);
  });

  it("returns null for unknown, disabled and customer accounts", async () => {
    expect(await verifyStaffCredentials("nobody@example.test", GOOD)).toBeNull();
    expect(await verifyStaffCredentials("off@example.test", GOOD)).toBeNull();
    expect(await verifyStaffCredentials("buyer@example.test", GOOD)).toBeNull();
  });

  it("only looks in the default org, so another org's staff cannot log in", async () => {
    expect(await verifyStaffCredentials("staff.b@example.test", GOOD)).toBeNull();
  });

  it("locks the account for 15 minutes after 5 failures and then refuses even the right password", async () => {
    for (let i = 0; i < 5; i++) await verifyStaffCredentials("staff.a@example.test", "example-wrong");
    const lockoutUntil = userRow("staff_a1")["lockoutUntil"] as Date;
    expect(lockoutUntil.getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    await expect(verifyStaffCredentials("staff.a@example.test", GOOD)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a successful login resets the failure counter", async () => {
    await verifyStaffCredentials("staff.a@example.test", "example-wrong");
    await verifyStaffCredentials("staff.a@example.test", GOOD);
    expect(userRow("staff_a1")["failedLoginAttempts"]).toBe(0);
    expect(userRow("staff_a1")["lockoutUntil"]).toBeNull();
  });
});

describe("access tokens", () => {
  const payload = { sub: "staff_a1", orgId: ORG_A, role: "MANAGER" as const, name: "Staff A", email: "staff.a@example.test" };

  it("round-trips the claims", async () => {
    expect(await verifyAccessToken(await signAccessToken(payload))).toEqual(payload);
  });

  it("rejects a garbage token", async () => {
    await expect(verifyAccessToken("not.a.jwt")).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects a token signed with a different secret", async () => {
    const forged = await new SignJWT({ orgId: ORG_A, role: "ADMINISTRATOR", name: "X", email: null })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("staff_a1")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("a-different-secret-value-0123456789abcdef"));
    await expect(verifyAccessToken(forged)).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects a token with an unknown role", async () => {
    const bad = await new SignJWT({ orgId: ORG_A, role: "SUPERUSER", name: "X", email: null })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("staff_a1")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("test-only-dummy-value-0123456789abcdef"));
    await expect(verifyAccessToken(bad)).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const token = await signAccessToken(payload);
      vi.setSystemTime(Date.now() + (ACCESS_TOKEN_TTL_SECONDS + 5) * 1000);
      await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(AccessTokenError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loginMobile", () => {
  it("returns a token pair and the user, with the org taken from the user row", async () => {
    const result = await loginMobile({ email: "staff.a@example.test", password: GOOD }, meta);
    expect(result.accessTokenExpiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(result.user).toMatchObject({ id: "staff_a1", orgId: ORG_A, role: "MANAGER" });
    expect(await verifyAccessToken(result.accessToken)).toMatchObject({ sub: "staff_a1", orgId: ORG_A });
  });

  it("stores only the sha256 hash of the refresh token, with the client ip and agent", async () => {
    const result = await loginMobile({ email: "staff.a@example.test", password: GOOD }, meta);
    const stored = fake.rows("refreshToken")[0]!;
    expect(stored["tokenHash"]).toBe(createHash("sha256").update(result.refreshToken).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(result.refreshToken);
    expect(stored).toMatchObject({ org_id: ORG_A, userId: "staff_a1", createdByIp: "203.0.113.7", userAgent: "test-agent" });
  });

  it("rejects bad credentials with a generic message", async () => {
    await expect(loginMobile({ email: "staff.a@example.test", password: "example-wrong" }, meta)).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Invalid email or password.",
    });
    await expect(loginMobile({ email: "nobody@example.test", password: GOOD }, meta)).rejects.toMatchObject({
      message: "Invalid email or password.",
    });
  });

  it("rejects a malformed body with field errors", async () => {
    const error = await loginMobile({ email: "nope", password: "" }, meta).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION" });
    expect(Object.keys((error as { fieldErrors: object }).fieldErrors)).toEqual(expect.arrayContaining(["email", "password"]));
  });
});

describe("refreshMobileToken", () => {
  const login = () => loginMobile({ email: "staff.a@example.test", password: GOOD }, meta);

  it("rotates: returns a new pair and revokes the old token, linking the replacement", async () => {
    const first = await login();
    const second = await refreshMobileToken({ refreshToken: first.refreshToken }, meta);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const [oldRow, newRow] = fake.rows("refreshToken");
    expect(oldRow?.["revokedAt"]).toBeInstanceOf(Date);
    expect(oldRow?.["replacedByTokenId"]).toBe(newRow?.["id"]);
    expect(newRow?.["revokedAt"] ?? null).toBeNull();
  });

  it("refuses to reuse a rotated (revoked) token", async () => {
    const first = await login();
    await refreshMobileToken({ refreshToken: first.refreshToken }, meta);
    await expect(refreshMobileToken({ refreshToken: first.refreshToken }, meta)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an unknown token", async () => {
    await expect(refreshMobileToken({ refreshToken: "unknown-token-value" }, meta)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an expired token", async () => {
    const first = await login();
    fake.rows("refreshToken")[0]!["expiresAt"] = new Date(Date.now() - 1000);
    await expect(refreshMobileToken({ refreshToken: first.refreshToken }, meta)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses once the user has been deactivated, and reflects a role change", async () => {
    const first = await login();
    userRow("staff_a1")["role"] = "OPERATOR";
    const second = await refreshMobileToken({ refreshToken: first.refreshToken }, meta);
    expect(second.user.role).toBe("OPERATOR");
    userRow("staff_a1")["loginEnabled"] = false;
    await expect(refreshMobileToken({ refreshToken: second.refreshToken }, meta)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a missing token with a validation error", async () => {
    await expect(refreshMobileToken({}, meta)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("logoutMobile", () => {
  it("revokes the token, so it can no longer refresh", async () => {
    const first = await loginMobile({ email: "staff.a@example.test", password: GOOD }, meta);
    await logoutMobile({ refreshToken: first.refreshToken });
    await expect(refreshMobileToken({ refreshToken: first.refreshToken }, meta)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is idempotent for unknown and already-revoked tokens", async () => {
    await expect(logoutMobile({ refreshToken: "unknown-token-value" })).resolves.toBeUndefined();
    const first = await loginMobile({ email: "staff.a@example.test", password: GOOD }, meta);
    await logoutMobile({ refreshToken: first.refreshToken });
    await expect(logoutMobile({ refreshToken: first.refreshToken })).resolves.toBeUndefined();
  });
});

describe("revokeAllUserTokens", () => {
  afterEach(() => vi.useRealTimers());

  it("revokes only that user's active tokens in that org", async () => {
    fake.seed(
      "refreshToken",
      { id: "rt_1", org_id: ORG_A, userId: "staff_a1", revokedAt: null },
      { id: "rt_2", org_id: ORG_A, userId: "staff_off", revokedAt: null },
      { id: "rt_3", org_id: ORG_B, userId: "staff_a1", revokedAt: null }
    );
    await revokeAllUserTokens(fake.client, ORG_A, "staff_a1");
    const revoked = (id: string) => fake.rows("refreshToken").find((r) => r["id"] === id)?.["revokedAt"];
    expect(revoked("rt_1")).toBeInstanceOf(Date);
    expect(revoked("rt_2")).toBeNull();
    expect(revoked("rt_3")).toBeNull();
  });
});

describe("refresh token reuse and races", () => {
  const login = () => loginMobile({ email: "staff.a@example.test", password: GOOD }, meta);
  const rows = () => fake.rows("refreshToken");
  const activeCount = () => rows().filter((r) => !r["revokedAt"]).length;

  it("two concurrent refreshes of one token yield exactly one successor", async () => {
    const first = await login();
    const results = await Promise.allSettled([
      refreshMobileToken({ refreshToken: first.refreshToken }, meta),
      refreshMobileToken({ refreshToken: first.refreshToken }, meta),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "FORBIDDEN" });
    expect(rows()).toHaveLength(2); // original + one successor, no orphan
    expect(activeCount()).toBe(1);
  });

  it("reusing a rotated token well after rotation revokes every session for the user", async () => {
    const first = await login();
    const second = await refreshMobileToken({ refreshToken: first.refreshToken }, meta);
    rows()[0]!["revokedAt"] = new Date(Date.now() - 60_000); // rotated a minute ago

    await expect(refreshMobileToken({ refreshToken: first.refreshToken }, meta)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(activeCount()).toBe(0);
    await expect(refreshMobileToken({ refreshToken: second.refreshToken }, meta)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reusing a rotated token within the grace window rejects but keeps the live session", async () => {
    const first = await login();
    const second = await refreshMobileToken({ refreshToken: first.refreshToken }, meta);
    await expect(refreshMobileToken({ refreshToken: first.refreshToken }, meta)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(activeCount()).toBe(1);
    await expect(refreshMobileToken({ refreshToken: second.refreshToken }, meta)).resolves.toBeDefined();
  });

  it("a logged-out token being replayed does not revoke the user's other sessions", async () => {
    const phone = await login();
    const tablet = await login();
    await logoutMobile({ refreshToken: phone.refreshToken });
    rows()[0]!["revokedAt"] = new Date(Date.now() - 60_000);
    await expect(refreshMobileToken({ refreshToken: phone.refreshToken }, meta)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(refreshMobileToken({ refreshToken: tablet.refreshToken }, meta)).resolves.toBeDefined();
  });

  it("reuse detection never touches another user's tokens", async () => {
    const mine = await login();
    fake.seed("refreshToken", { id: "rt_other", org_id: ORG_B, userId: "staff_b1", revokedAt: null, tokenHash: "x" });
    await refreshMobileToken({ refreshToken: mine.refreshToken }, meta);
    rows()[0]!["revokedAt"] = new Date(Date.now() - 60_000);
    await expect(refreshMobileToken({ refreshToken: mine.refreshToken }, meta)).rejects.toBeDefined();
    expect(rows().find((r) => r["id"] === "rt_other")?.["revokedAt"]).toBeNull();
  });
});
