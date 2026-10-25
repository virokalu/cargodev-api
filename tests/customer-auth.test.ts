import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A } from "./helpers/fixtures.js";
import { CUSTOMER_PASSWORD, NEW_PASSWORD, bearerFor, codeFrom, newCustomerFake, post, request } from "./helpers/customer-fixtures.js";

const state = vi.hoisted(() => ({
  fake: undefined as unknown,
  selfSignup: true,
  sent: [] as { to: string; subject: string; text: string }[],
}));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/email-queue.js", () => ({
  queueEmail: (message: { to: string; subject: string; text: string }) => {
    state.sent.push(message);
  },
  drainEmailQueue: async () => undefined,
}));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), CUSTOMER_SELF_SIGNUP: state.selfSignup }) };
});

import { buildApp } from "../src/app.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";

let app: FastifyInstance;
let fake: FakePrisma;
const rows = (model: string) => fake.rows(model);
const user = (id: string) => rows("user").find((r) => r["id"] === id)!;
const userByEmail = (email: string) => rows("user").find((r) => r["email"] === email);

beforeEach(async () => {
  fake = newCustomerFake();
  state.fake = fake;
  state.selfSignup = true;
  state.sent = [];
  resetShadowLockouts();
  identifierLimiter.reset();
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await app.close();
  vi.useRealTimers();
});

const register = (email: string, extra: Record<string, unknown> = {}) => post(app, "/auth/register", { name: "New Person", email, ...extra });

/** Registers, reads the emailed code, verifies and sets the password. */
async function signUp(email: string) {
  await register(email);
  const code = codeFrom(state.sent.at(-1));
  return post(app, "/auth/verify-email", { email, code, password: CUSTOMER_PASSWORD });
}

describe("register: the answer never depends on the address", () => {
  it("a new address: 202, a verification code is emailed, an unverified passwordless row exists", async () => {
    const res = await register("new.person@example.test");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ data: { accepted: true } });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.to).toBe("new.person@example.test");
    const row = userByEmail("new.person@example.test")!;
    expect(row["userType"]).toBe("CUSTOMER");
    expect(row["password"] ?? null).toBeNull();
    expect(row["emailVerifiedAt"] ?? null).toBeNull();
    expect(row["loginEnabled"] ?? false).toBe(false);
    expect(rows("activityLog").map((r) => r["action"])).toEqual(["CUSTOMER_REGISTER"]);
  });

  it("the same status and body for a new address, a verified customer, a pending one, a staff address and a deleted account", async () => {
    await register("pending@example.test");
    const bodies = [];
    for (const email of ["brand.new@example.test", "a1@example.test", "pending@example.test", "staff@example.test", "disabled@example.test"]) {
      const res = await register(email);
      bodies.push({ status: res.statusCode, body: res.json(), headers: res.headers["content-type"] });
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
  });

  it("an existing customer gets an 'already registered' email and nothing else changes", async () => {
    const before = rows("user").length;
    await register("a1@example.test");
    expect(rows("user")).toHaveLength(before);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.subject).toMatch(/already have an account/i);
    expect(state.sent[0]!.text).not.toMatch(/\b\d{6}\b/);
  });

  it("a staff address sends nothing and changes nothing", async () => {
    const before = rows("user").length;
    await register("staff@example.test");
    expect(state.sent).toHaveLength(0);
    expect(rows("user")).toHaveLength(before);
  });

  it("registering a pending address again sends a fresh code that retires the old one", async () => {
    await register("pending@example.test");
    const first = codeFrom(state.sent.at(-1));
    await register("pending@example.test");
    const second = codeFrom(state.sent.at(-1));
    expect(rows("user").filter((r) => r["email"] === "pending@example.test")).toHaveLength(1);
    const pendingId = userByEmail("pending@example.test")!["id"];
    expect(rows("otpCode").filter((o) => o["userId"] === pendingId && o["usedAt"] == null)).toHaveLength(1);
    // The first code no longer works (unless the two random codes happen to be equal).
    if (first !== second) {
      const res = await post(app, "/auth/verify-email", { email: "pending@example.test", code: first, password: CUSTOMER_PASSWORD });
      expect(res.statusCode).toBe(400);
    }
  });

  it("with CUSTOMER_SELF_SIGNUP=false register does nothing but still answers the same", async () => {
    state.selfSignup = false;
    const res = await register("closed@example.test");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ data: { accepted: true } });
    expect(userByEmail("closed@example.test")).toBeUndefined();
    expect(state.sent).toHaveLength(0);
  });

  it("rejects fields the server owns (strict body) and a bad email", async () => {
    let n = 0;
    for (const extra of [{ orgId: "org_x" }, { loginEnabled: true }, { role: "ADMINISTRATOR" }, { userType: "STAFF" }, { password: CUSTOMER_PASSWORD }]) {
      const res = await register(`x${++n}@example.test`, extra);
      expect(res.statusCode).toBe(400);
    }
    expect((await post(app, "/auth/register", { name: "N", email: "not-an-email" })).statusCode).toBe(400);
    expect(userByEmail("x1@example.test")).toBeUndefined();
  });

  it("the new customer always belongs to the server's org, never one the client names", async () => {
    await register("scoped@example.test");
    expect(userByEmail("scoped@example.test")!["org_id"]).toBe(ORG_A);
  });
});

describe("verify-email: the code, and choosing the password", () => {
  it("a correct code activates the account, stores a bcrypt hash (never the password) and allows login", async () => {
    const res = await signUp("fresh@example.test");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { verified: true } });
    const row = userByEmail("fresh@example.test")!;
    expect(row["emailVerifiedAt"]).toBeInstanceOf(Date);
    expect(row["loginEnabled"]).toBe(true);
    expect(String(row["password"])).toMatch(/^\$2[aby]\$/);
    expect(String(row["password"])).not.toContain(CUSTOMER_PASSWORD);
    expect(rows("activityLog").map((r) => r["action"])).toContain("CUSTOMER_VERIFY_EMAIL");
    expect((await post(app, "/auth/login", { email: "fresh@example.test", password: CUSTOMER_PASSWORD })).statusCode).toBe(200);
  });

  it("the stored code is a hash, not the code", async () => {
    await register("hashed@example.test");
    const code = codeFrom(state.sent.at(-1));
    for (const otp of rows("otpCode")) {
      expect(String(otp["codeHash"])).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(otp)).not.toContain(`"${code}"`);
    }
  });

  it("a wrong code, an unknown address and an account that is already verified all answer identically", async () => {
    await register("pending@example.test");
    const answers = [];
    for (const [email, code] of [["pending@example.test", "000000"], ["nobody@example.test", "123456"], ["a1@example.test", "123456"], ["staff@example.test", "123456"]] as const) {
      const res = await post(app, "/auth/verify-email", { email, code, password: CUSTOMER_PASSWORD });
      answers.push({ status: res.statusCode, body: res.json() });
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0]!.status).toBe(400);
  });

  it("an expired code (10 minutes) is refused", async () => {
    await register("slow@example.test");
    const code = codeFrom(state.sent.at(-1));
    const otp = rows("otpCode").find((o) => o["usedAt"] == null)!;
    otp["expiresAt"] = new Date(Date.now() - 1000);
    const res = await post(app, "/auth/verify-email", { email: "slow@example.test", code, password: CUSTOMER_PASSWORD });
    expect(res.statusCode).toBe(400);
  });

  it("the code lives for 10 minutes", async () => {
    await register("ttl@example.test");
    const otp = rows("otpCode").find((o) => o["usedAt"] == null)!;
    const lifetime = (otp["expiresAt"] as Date).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(9 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(10 * 60_000);
  });

  it("is single use", async () => {
    await register("once@example.test");
    const code = codeFrom(state.sent.at(-1));
    expect((await post(app, "/auth/verify-email", { email: "once@example.test", code, password: CUSTOMER_PASSWORD })).statusCode).toBe(200);
    expect((await post(app, "/auth/verify-email", { email: "once@example.test", code, password: NEW_PASSWORD })).statusCode).toBe(400);
  });

  it("after 5 attempts the code is dead, even if the next guess is right", async () => {
    await register("guess@example.test");
    const code = codeFrom(state.sent.at(-1));
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      expect((await post(app, "/auth/verify-email", { email: "guess@example.test", code: wrong, password: CUSTOMER_PASSWORD })).statusCode).toBe(400);
    }
    const res = await post(app, "/auth/verify-email", { email: "guess@example.test", code, password: CUSTOMER_PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(userByEmail("guess@example.test")!["emailVerifiedAt"]).toBeUndefined();
  });

  it("20 parallel wrong guesses spend at most 5 attempts (an attempt is reserved before the code is compared)", async () => {
    await register("burst@example.test");
    const code = codeFrom(state.sent.at(-1));
    const wrong = code === "000000" ? "111111" : "000000";
    await Promise.all(
      Array.from({ length: 20 }, () => post(app, "/auth/verify-email", { email: "burst@example.test", code: wrong, password: CUSTOMER_PASSWORD }))
    );
    const otp = rows("otpCode").find((o) => o["usedAt"] == null)!;
    expect(otp["attempts"]).toBe(5);
  });

  it("a password-reset code cannot verify an email (the purpose is part of the hash)", async () => {
    await register("pending@example.test");
    const pending = userByEmail("pending@example.test")!;
    // Staff enable login, then a reset code is issued for the same user.
    pending["loginEnabled"] = true;
    await post(app, "/auth/forgot-password", { email: "pending@example.test" });
    const resetCode = codeFrom(state.sent.at(-1));
    const res = await post(app, "/auth/verify-email", { email: "pending@example.test", code: resetCode, password: CUSTOMER_PASSWORD });
    expect(res.statusCode).toBe(400);
  });

  it("the password must meet the policy (12 characters, 72 bytes)", async () => {
    await register("policy@example.test");
    const code = codeFrom(state.sent.at(-1));
    expect((await post(app, "/auth/verify-email", { email: "policy@example.test", code, password: "short" })).statusCode).toBe(400);
    expect((await post(app, "/auth/verify-email", { email: "policy@example.test", code, password: "x".repeat(73) })).statusCode).toBe(400);
  });

  it("with CUSTOMER_SELF_SIGNUP=false a verified account still cannot sign in until staff enable login", async () => {
    await register("both@example.test");
    const code = codeFrom(state.sent.at(-1));
    state.selfSignup = false;
    await post(app, "/auth/verify-email", { email: "both@example.test", code, password: CUSTOMER_PASSWORD });
    expect(userByEmail("both@example.test")!["loginEnabled"]).not.toBe(true);
    expect((await post(app, "/auth/login", { email: "both@example.test", password: CUSTOMER_PASSWORD })).statusCode).toBe(400);
  });
});

describe("resend-verification", () => {
  it("answers the same for every address and only emails a pending one", async () => {
    await register("pending@example.test");
    state.sent = [];
    const answers = [];
    for (const email of ["pending@example.test", "a1@example.test", "nobody@example.test", "staff@example.test"]) {
      const res = await post(app, "/auth/resend-verification", { email });
      answers.push({ status: res.statusCode, body: res.json() });
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.to).toBe("pending@example.test");
  });
});

describe("login", () => {
  it("returns a customer access token and an opaque refresh token; only the hash of the refresh token is stored", async () => {
    const res = await post(app, "/auth/login", { email: "A1@Example.test ", password: CUSTOMER_PASSWORD });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(Object.keys(data).sort()).toEqual(["accessToken", "accessTokenExpiresIn", "refreshToken", "refreshTokenExpiresAt", "user"]);
    expect(Object.keys(data.user).sort()).toEqual(["email", "id", "name"]);
    expect(data.accessTokenExpiresIn).toBe(15 * 60);
    const sessions = rows("customerSession");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!["tokenHash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sessions)).not.toContain(data.refreshToken);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("a wrong password, an unknown address, an unverified, disabled, deleted or staff account all answer identically", async () => {
    const attempts = [
      ["a1@example.test", "wrong-example-password"],
      ["nobody@example.test", CUSTOMER_PASSWORD],
      ["unverified@example.test", CUSTOMER_PASSWORD],
      ["disabled@example.test", CUSTOMER_PASSWORD],
      ["staff@example.test", CUSTOMER_PASSWORD],
      ["invited@example.test", CUSTOMER_PASSWORD],
    ] as const;
    const answers = [];
    for (const [email, password] of attempts) {
      const res = await post(app, "/auth/login", { email, password });
      answers.push({ status: res.statusCode, body: res.json() });
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0]!.status).toBe(400);
    expect(rows("customerSession")).toHaveLength(0);
  });

  it("5 failures lock a real account for 15 minutes, with the same message a fake address gets", async () => {
    for (let i = 0; i < 5; i++) await post(app, "/auth/login", { email: "a2@example.test", password: "wrong-example-password" });
    const real = await post(app, "/auth/login", { email: "a2@example.test", password: CUSTOMER_PASSWORD });
    expect(real.statusCode).toBe(403);

    for (let i = 0; i < 5; i++) await post(app, "/auth/login", { email: "ghost@example.test", password: "wrong-example-password" });
    const fake = await post(app, "/auth/login", { email: "ghost@example.test", password: CUSTOMER_PASSWORD });
    expect(fake.statusCode).toBe(403);
    expect(fake.json()).toEqual(real.json());
  });

  it("locking one fake address does not affect another", async () => {
    for (let i = 0; i < 5; i++) await post(app, "/auth/login", { email: "ghost@example.test", password: "wrong-example-password" });
    expect((await post(app, "/auth/login", { email: "ghost2@example.test", password: "x" })).statusCode).toBe(400);
  });

  it("a staff account's failures do not lock the customer with the same local part, and vice versa (separate keys)", async () => {
    for (let i = 0; i < 5; i++) await post(app, "/auth/login", { email: "staff@example.test", password: "wrong-example-password" });
    expect((await post(app, "/auth/login", { email: "staff@example.test", password: CUSTOMER_PASSWORD })).statusCode).toBe(403);
    // The staff login endpoint has its own counters (src/lib/shadow-lockout.ts keys are prefixed here).
    expect((await post(app, "/auth/login", { email: "a1@example.test", password: CUSTOMER_PASSWORD })).statusCode).toBe(200);
  });

  it("rejects extra fields", async () => {
    expect((await post(app, "/auth/login", { email: "a1@example.test", password: CUSTOMER_PASSWORD, orgId: "org_x" })).statusCode).toBe(400);
  });
});

describe("refresh and logout", () => {
  const login = async (email = "a1@example.test") => (await post(app, "/auth/login", { email, password: CUSTOMER_PASSWORD })).json().data;

  it("rotates: the old token stops working and a new one works", async () => {
    const first = await login();
    const res = await post(app, "/auth/refresh", { refreshToken: first.refreshToken });
    expect(res.statusCode).toBe(200);
    const second = res.json().data;
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await post(app, "/auth/refresh", { refreshToken: first.refreshToken })).statusCode).toBe(403);
    expect((await post(app, "/auth/refresh", { refreshToken: second.refreshToken })).statusCode).toBe(200);
  });

  it("reuse within the 10 second grace is a rejection only; the live session survives", async () => {
    const first = await login();
    const second = (await post(app, "/auth/refresh", { refreshToken: first.refreshToken })).json().data;
    expect((await post(app, "/auth/refresh", { refreshToken: first.refreshToken })).statusCode).toBe(403);
    expect((await post(app, "/auth/refresh", { refreshToken: second.refreshToken })).statusCode).toBe(200);
  });

  it("reuse AFTER the grace is treated as theft: every session of the customer ends", async () => {
    const first = await login();
    const second = (await post(app, "/auth/refresh", { refreshToken: first.refreshToken })).json().data;
    const other = await login(); // another device
    const rotated = rows("customerSession").find((s) => s["replacedByTokenId"])!;
    rotated["revokedAt"] = new Date(Date.now() - 60_000);
    expect((await post(app, "/auth/refresh", { refreshToken: first.refreshToken })).statusCode).toBe(403);
    expect((await post(app, "/auth/refresh", { refreshToken: second.refreshToken })).statusCode).toBe(403);
    expect((await post(app, "/auth/refresh", { refreshToken: other.refreshToken })).statusCode).toBe(403);
  });

  it("parallel refreshes of one token produce exactly one successor", async () => {
    const first = await login();
    const results = await Promise.all(Array.from({ length: 5 }, () => post(app, "/auth/refresh", { refreshToken: first.refreshToken })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(rows("customerSession").filter((s) => s["revokedAt"] == null)).toHaveLength(1);
  });

  it("an expired, unknown or malformed token is 403 / 400", async () => {
    const first = await login();
    rows("customerSession")[0]!["expiresAt"] = new Date(Date.now() - 1000);
    expect((await post(app, "/auth/refresh", { refreshToken: first.refreshToken })).statusCode).toBe(403);
    expect((await post(app, "/auth/refresh", { refreshToken: "nope" })).statusCode).toBe(403);
    expect((await post(app, "/auth/refresh", {})).statusCode).toBe(400);
  });

  it("a disabled, deleted or unverified account cannot refresh", async () => {
    for (const mutate of [{ loginEnabled: false }, { deletedAt: new Date() }, { emailVerifiedAt: null }]) {
      const session = await login();
      Object.assign(user("cust_a1"), mutate);
      expect((await post(app, "/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(403);
      Object.assign(user("cust_a1"), { loginEnabled: true, deletedAt: null, emailVerifiedAt: new Date() });
    }
  });

  it("logout revokes the token and is idempotent", async () => {
    const session = await login();
    expect((await post(app, "/auth/logout", { refreshToken: session.refreshToken })).statusCode).toBe(200);
    expect((await post(app, "/auth/logout", { refreshToken: session.refreshToken })).statusCode).toBe(200);
    expect((await post(app, "/auth/logout", { refreshToken: "unknown" })).statusCode).toBe(200);
    expect((await post(app, "/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(403);
  });
});

describe("forgot and reset password", () => {
  it("forgot answers the same for every address and only emails an account that can sign in", async () => {
    const answers = [];
    for (const email of ["a1@example.test", "nobody@example.test", "staff@example.test", "disabled@example.test", "unverified@example.test"]) {
      const res = await post(app, "/auth/forgot-password", { email });
      answers.push({ status: res.statusCode, body: res.json() });
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(state.sent.map((m) => m.to)).toEqual(["a1@example.test"]);
  });

  it("a correct code sets the new password, ends every session and clears the lockout", async () => {
    const session = (await post(app, "/auth/login", { email: "a1@example.test", password: CUSTOMER_PASSWORD })).json().data;
    user("cust_a1")["failedLoginAttempts"] = 3;
    await post(app, "/auth/forgot-password", { email: "a1@example.test" });
    const code = codeFrom(state.sent.at(-1));
    const res = await post(app, "/auth/reset-password", { email: "a1@example.test", code, newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(user("cust_a1")["failedLoginAttempts"]).toBe(0);
    expect((await post(app, "/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(403);
    expect((await post(app, "/auth/login", { email: "a1@example.test", password: CUSTOMER_PASSWORD })).statusCode).toBe(400);
    expect((await post(app, "/auth/login", { email: "a1@example.test", password: NEW_PASSWORD })).statusCode).toBe(200);
    expect(rows("activityLog").map((r) => r["action"])).toContain("CUSTOMER_RESET_PASSWORD");
  });

  it("a customer staff created (login on, no password, email not verified) gets in through reset", async () => {
    await post(app, "/auth/forgot-password", { email: "invited@example.test" });
    const code = codeFrom(state.sent.at(-1));
    expect((await post(app, "/auth/reset-password", { email: "invited@example.test", code, newPassword: NEW_PASSWORD })).statusCode).toBe(200);
    expect(user("cust_invited")["emailVerifiedAt"]).toBeInstanceOf(Date);
    expect((await post(app, "/auth/login", { email: "invited@example.test", password: NEW_PASSWORD })).statusCode).toBe(200);
  });

  it("a wrong code, an unknown address and a staff address answer identically; the code dies after 5 attempts", async () => {
    await post(app, "/auth/forgot-password", { email: "a1@example.test" });
    const code = codeFrom(state.sent.at(-1));
    const wrong = code === "000000" ? "111111" : "000000";
    const answers = [];
    for (const email of ["a1@example.test", "nobody@example.test", "staff@example.test"]) {
      const res = await post(app, "/auth/reset-password", { email, code: wrong, newPassword: NEW_PASSWORD });
      answers.push({ status: res.statusCode, body: res.json() });
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    for (let i = 0; i < 4; i++) await post(app, "/auth/reset-password", { email: "a1@example.test", code: wrong, newPassword: NEW_PASSWORD });
    expect((await post(app, "/auth/reset-password", { email: "a1@example.test", code, newPassword: NEW_PASSWORD })).statusCode).toBe(400);
  });

  it("a new code retires the previous one", async () => {
    await post(app, "/auth/forgot-password", { email: "a1@example.test" });
    const first = codeFrom(state.sent.at(-1));
    await post(app, "/auth/forgot-password", { email: "a1@example.test" });
    const second = codeFrom(state.sent.at(-1));
    if (first !== second) {
      expect((await post(app, "/auth/reset-password", { email: "a1@example.test", code: first, newPassword: NEW_PASSWORD })).statusCode).toBe(400);
    }
    expect((await post(app, "/auth/reset-password", { email: "a1@example.test", code: second, newPassword: NEW_PASSWORD })).statusCode).toBe(200);
  });

  it("the new password must meet the policy", async () => {
    await post(app, "/auth/forgot-password", { email: "a1@example.test" });
    const code = codeFrom(state.sent.at(-1));
    expect((await post(app, "/auth/reset-password", { email: "a1@example.test", code, newPassword: "short" })).statusCode).toBe(400);
  });
});

describe("delete account", () => {
  it("needs the customer token AND the password", async () => {
    expect((await post(app, "/auth/delete-account", { password: CUSTOMER_PASSWORD })).statusCode).toBe(401);
    const headers = await bearerFor("cust_a1");
    expect((await post(app, "/auth/delete-account", { password: "wrong-example-password" }, headers)).statusCode).toBe(400);
    expect(user("cust_a1")["deletedAt"]).toBeNull();
  });

  it("anonymises the customer, ends every session, removes codes and device tokens, and keeps the business records", async () => {
    fake.seed("vehicle", { id: "veh_1", org_id: ORG_A, customerId: "cust_a1", serial: "FC1" });
    fake.seed("deviceToken", { id: "d1", org_id: ORG_A, userId: "cust_a1", expoPushToken: "ExponentPushToken[example]" });
    fake.seed("otpCode", { id: "o1", org_id: ORG_A, userId: "cust_a1", purpose: "RESET", usedAt: null });
    const session = (await post(app, "/auth/login", { email: "a1@example.test", password: CUSTOMER_PASSWORD })).json().data;
    const headers = { authorization: `Bearer ${session.accessToken}` };

    const res = await post(app, "/auth/delete-account", { password: CUSTOMER_PASSWORD }, headers);
    expect(res.statusCode).toBe(200);

    expect(user("cust_a1")).toMatchObject({
      name: "Deleted customer", email: null, phone: null, companyName: null, country: null, password: null,
      loginEnabled: false, emailVerifiedAt: null,
    });
    expect(user("cust_a1")["deletedAt"]).toBeInstanceOf(Date);
    expect(rows("customerSession").every((s) => s["revokedAt"] != null)).toBe(true);
    expect(rows("deviceToken")).toHaveLength(0);
    expect(rows("otpCode").filter((o) => o["userId"] === "cust_a1")).toHaveLength(0);
    expect(rows("vehicle")).toHaveLength(1);
    expect(rows("vehicle")[0]!["customerId"]).toBe("cust_a1");
    expect(rows("activityLog").map((r) => r["action"])).toContain("CUSTOMER_DELETE_ACCOUNT");

    expect((await request(app, "GET", "/me", headers)).statusCode).toBe(401);
    expect((await post(app, "/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(403);
    expect((await post(app, "/auth/login", { email: "a1@example.test", password: CUSTOMER_PASSWORD })).statusCode).toBe(400);
    // The address is free again.
    expect((await register("a1@example.test")).statusCode).toBe(202);
    expect(state.sent.at(-1)!.subject).toMatch(/verification/i);
  });

  it("never touches another customer", async () => {
    await post(app, "/auth/delete-account", { password: CUSTOMER_PASSWORD }, await bearerFor("cust_a1"));
    expect(user("cust_a2")["deletedAt"]).toBeNull();
    expect(user("cust_b1")["deletedAt"]).toBeNull();
  });
});
