import { SignJWT } from "jose";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import {
  CUSTOMER_PASSWORD,
  IDOR_WORLD,
  bearerFor,
  customerToken,
  newCustomerFake,
  post,
  request,
} from "./helpers/customer-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/email-queue.js", () => ({ queueEmail: () => undefined, drainEmailQueue: async () => undefined }));

import { buildApp } from "../src/app.js";
import { CUSTOMER_RATE_LIMITS } from "../src/config/customer-rate-limits.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { setResponseFloorMs } from "../src/lib/min-duration.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";

const CUSTOMER_SECRET = process.env["CUSTOMER_JWT_SECRET"]!;
const STAFF_SECRET = process.env["MOBILE_JWT_SECRET"]!;
const enc = (s: string) => new TextEncoder().encode(s);

let app: FastifyInstance;
let fake: FakePrisma;

beforeEach(async () => {
  fake = newCustomerFake();
  state.fake = fake;
  resetShadowLockouts();
  identifierLimiter.reset();
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  setResponseFloorMs(0);
});

/** A token signed by hand, to prove each claim is checked on its own. */
const forge = (opts: { secret: string; aud?: string | undefined; iss?: string | undefined; sub?: string; exp?: string | number; extra?: Record<string, unknown> }) => {
  let jwt = new SignJWT({ orgId: ORG_A, ...opts.extra }).setProtectedHeader({ alg: "HS256" }).setSubject(opts.sub ?? "cust_a1").setIssuedAt();
  if (opts.aud !== undefined) jwt = jwt.setAudience(opts.aud);
  if (opts.iss !== undefined) jwt = jwt.setIssuer(opts.iss);
  return jwt.setExpirationTime(opts.exp ?? "10m").sign(enc(opts.secret));
};

const me = (token: string) => request(app, "GET", "/me", { authorization: `Bearer ${token}` });

describe("token zones: audience and issuer are both checked, in both directions", () => {
  it("a good customer token works", async () => {
    expect((await me(await customerToken("cust_a1"))).statusCode).toBe(200);
  });

  it("a STAFF token on a customer route is 401", async () => {
    const staff = await signAccessToken({ sub: "staff_a1", orgId: ORG_A, role: "ADMINISTRATOR", name: "S", email: null });
    expect((await me(staff)).statusCode).toBe(401);
  });

  it("a CUSTOMER token on a staff route is 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/vehicles", headers: await bearerFor("cust_a1") });
    expect(res.statusCode).toBe(401);
    const admin = await app.inject({ method: "GET", url: "/api/v1/staff", headers: await bearerFor("cust_a1") });
    expect(admin.statusCode).toBe(401);
  });

  it.each([
    ["customer secret, audience staff", { secret: CUSTOMER_SECRET, aud: "staff", iss: "cargodev-api" }],
    ["customer secret, no audience", { secret: CUSTOMER_SECRET, aud: undefined, iss: "cargodev-api" }],
    ["customer secret, wrong audience", { secret: CUSTOMER_SECRET, aud: "admin", iss: "cargodev-api" }],
    ["customer secret, no issuer", { secret: CUSTOMER_SECRET, aud: "customer", iss: undefined }],
    ["customer secret, wrong issuer", { secret: CUSTOMER_SECRET, aud: "customer", iss: "someone-else" }],
    ["staff secret, audience customer", { secret: STAFF_SECRET, aud: "customer", iss: "cargodev-api" }],
    ["another secret entirely", { secret: "a-different-example-value-0123456789abcdef", aud: "customer", iss: "cargodev-api" }],
    ["expired", { secret: CUSTOMER_SECRET, aud: "customer", iss: "cargodev-api", exp: Math.floor(Date.now() / 1000) - 60 }],
  ])("a customer route refuses a token with %s", async (_name, opts) => {
    expect((await me(await forge(opts))).statusCode).toBe(401);
  });

  it.each([
    ["staff secret, audience customer", { secret: STAFF_SECRET, aud: "customer", iss: "cargodev-api" }],
    ["staff secret, no audience", { secret: STAFF_SECRET, aud: undefined, iss: "cargodev-api" }],
    ["staff secret, no issuer", { secret: STAFF_SECRET, aud: "staff", iss: undefined }],
    ["staff secret, wrong issuer", { secret: STAFF_SECRET, aud: "staff", iss: "someone-else" }],
    ["customer secret, audience staff", { secret: CUSTOMER_SECRET, aud: "staff", iss: "cargodev-api" }],
  ])("a staff route refuses a token with %s", async (_name, opts) => {
    const token = await forge({ ...opts, extra: { role: "ADMINISTRATOR", name: "X", email: null } });
    const res = await app.inject({ method: "GET", url: "/api/v1/vehicles", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it("a valid staff token still works on staff routes (the audience change did not break staff)", async () => {
    const staff = await signAccessToken({ sub: "staff_a1", orgId: ORG_A, role: "ADMINISTRATOR", name: "S", email: null });
    expect((await app.inject({ method: "GET", url: "/api/v1/organization", headers: { authorization: `Bearer ${staff}` } })).statusCode).not.toBe(401);
  });

  it("a token for an account that is deleted, disabled, unverified, a staff user, or in another org is 401", async () => {
    for (const mutate of [{ deletedAt: new Date() }, { loginEnabled: false }, { emailVerifiedAt: null }, { userType: "STAFF" }]) {
      const row = fake.rows("user").find((r) => r["id"] === "cust_a1")!;
      const saved = { ...row };
      Object.assign(row, mutate);
      expect((await me(await customerToken("cust_a1"))).statusCode).toBe(401);
      Object.assign(row, saved);
    }
    // Right id, wrong org in the token.
    expect((await me(await customerToken("cust_a1", ORG_B))).statusCode).toBe(401);
    expect((await me(await customerToken("nobody"))).statusCode).toBe(401);
  });

  it("no token and a malformed header are 401 in the error envelope", async () => {
    const none = await request(app, "GET", "/me");
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } });
    expect((await request(app, "GET", "/me", { authorization: "Basic abc" })).statusCode).toBe(401);
  });
});

describe("the customer API is only mounted when it is configured", () => {
  it("with no CUSTOMER_JWT_SECRET the routes do not exist", async () => {
    vi.resetModules();
    const saved = process.env["CUSTOMER_JWT_SECRET"];
    delete process.env["CUSTOMER_JWT_SECRET"];
    try {
      vi.doMock("../src/lib/prisma.js", () => ({ getPrisma: () => fake.client }));
      const { buildApp: build } = await import("../src/app.js");
      const bare = await build({ rateLimit: false });
      const res = await bare.inject({ method: "POST", url: "/api/customer/v1/auth/login", payload: { email: "a@example.test", password: "x" } });
      expect(res.statusCode).toBe(404);
      await bare.close();
    } finally {
      process.env["CUSTOMER_JWT_SECRET"] = saved;
      vi.resetModules();
    }
  });
});

describe("environment validation", () => {
  const base = {
    DATABASE_URL: "postgresql://user:password@localhost:5432/dbname",
    MOBILE_JWT_SECRET: "test-only-dummy-value-0123456789abcdef",
    ORG_ID: "org_test_a",
  };
  beforeEach(() => vi.resetModules());
  const load = async () => (await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js")).loadEnv;

  it("startup fails when CUSTOMER_JWT_SECRET equals MOBILE_JWT_SECRET, naming the variable and never its value", async () => {
    const loadEnv = await load();
    let message = "";
    try {
      loadEnv({ ...base, CUSTOMER_JWT_SECRET: base.MOBILE_JWT_SECRET });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("CUSTOMER_JWT_SECRET");
    expect(message).not.toContain(base.MOBILE_JWT_SECRET);
  });

  it("must be at least 32 characters; unset is allowed (the zone is simply off)", async () => {
    const loadEnv = await load();
    expect(() => loadEnv({ ...base, CUSTOMER_JWT_SECRET: "too-short" })).toThrow(/CUSTOMER_JWT_SECRET/);
    expect(loadEnv({ ...base }).CUSTOMER_JWT_SECRET).toBeUndefined();
  });

  it("accepts a different long secret; CUSTOMER_SELF_SIGNUP defaults to true and must be true or false", async () => {
    const loadEnv = await load();
    const env = loadEnv({ ...base, CUSTOMER_JWT_SECRET: "another-customer-value-0123456789abcdef" });
    expect(env.CUSTOMER_SELF_SIGNUP).toBe(true);
    vi.resetModules();
    const again = await load();
    expect(again({ ...base, CUSTOMER_SELF_SIGNUP: "false" }).CUSTOMER_SELF_SIGNUP).toBe(false);
    vi.resetModules();
    const third = await load();
    expect(() => third({ ...base, CUSTOMER_SELF_SIGNUP: "maybe" })).toThrow(/CUSTOMER_SELF_SIGNUP/);
  });
});

describe("GET/PATCH /me: whitelisted fields and ownership", () => {
  const ME_KEYS = ["companyName", "country", "destinationPort", "email", "id", "language", "memberSince", "name", "phone", "theme"];

  it("returns exactly the whitelisted keys, and none of the internal ones", async () => {
    const res = await request(app, "GET", "/me", await bearerFor("cust_a1"));
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().data).sort()).toEqual(ME_KEYS);
    for (const forbidden of ["password", "org_id", "orgId", "role", "userType", "loginEnabled", "failedLoginAttempts", "lockoutUntil", "assignedAgentId", "deletedAt", "emailVerifiedAt", "lastActiveAt"]) {
      expect(res.body).not.toContain(`"${forbidden}"`);
    }
    expect(res.json().data.language).toBe("en");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("IDOR: each customer sees only their own profile, in the same org and across orgs", async () => {
    for (const actor of [IDOR_WORLD.own, IDOR_WORLD.sameOrgOther, IDOR_WORLD.otherOrg]) {
      const res = await request(app, "GET", "/me", await bearerFor(actor.id, actor.orgId));
      expect(res.json().data.id).toBe(actor.id);
    }
  });

  it("the client cannot choose whose profile to change: id and org fields are rejected", async () => {
    const headers = await bearerFor("cust_a1");
    for (const body of [{ id: "cust_a2", name: "X" }, { orgId: ORG_B, name: "X" }, { email: "x@example.test" }, { password: "x" }, { loginEnabled: false }, { assignedAgentId: "staff_a1" }]) {
      expect((await request(app, "PATCH", "/me", headers, body)).statusCode).toBe(400);
    }
    expect(fake.rows("user").find((r) => r["id"] === "cust_a2")!["name"]).toBe("Customer cust_a2");
  });

  it("updates only the sent fields, only for the caller, and logs field names (not values)", async () => {
    const res = await request(app, "PATCH", "/me", await bearerFor("cust_a1"), { name: "New Name", theme: "dark", phone: "  +1 555 0100 ", country: "" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ name: "New Name", theme: "dark", phone: "+1 555 0100", country: null });
    const log = fake.rows("activityLog").at(-1)!;
    expect(log).toMatchObject({ action: "CUSTOMER_UPDATE_PROFILE", actorId: "cust_a1", org_id: ORG_A });
    expect(JSON.stringify(log)).not.toContain("New Name");
    expect(fake.rows("user").find((r) => r["id"] === "cust_a2")!["name"]).toBe("Customer cust_a2");
  });

  it("validates values", async () => {
    const headers = await bearerFor("cust_a1");
    for (const body of [{}, { name: "" }, { theme: "neon" }, { language: "english" }, { companyName: "x".repeat(200) }]) {
      expect((await request(app, "PATCH", "/me", headers, body)).statusCode).toBe(400);
    }
  });
});

describe("rate limits", () => {
  it("every limit lives in one config module and has the intended values", () => {
    expect(CUSTOMER_RATE_LIMITS.login.ip).toEqual({ max: 10, windowMs: 60_000 });
    expect(CUSTOMER_RATE_LIMITS.register.ip).toEqual({ max: 5, windowMs: 60_000 });
    expect(CUSTOMER_RATE_LIMITS.register.identifier).toEqual({ max: 3, windowMs: 3_600_000 });
    expect(CUSTOMER_RATE_LIMITS.forgotPassword.identifier).toEqual({ max: 3, windowMs: 3_600_000 });
    expect(CUSTOMER_RATE_LIMITS.resendVerification.identifier).toEqual({ max: 3, windowMs: 600_000 });
    expect(CUSTOMER_RATE_LIMITS.verifyEmail.identifier).toEqual({ max: 10, windowMs: 600_000 });
    for (const [name, limit] of Object.entries(CUSTOMER_RATE_LIMITS)) {
      expect(limit.ip.max, name).toBeGreaterThan(0);
      expect(limit.ip.max, name).toBeLessThanOrEqual(60);
    }
  });

  it("per IP: the route limit applies, then 429 in the envelope", async () => {
    const limited = await buildApp({ rateLimit: true });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < CUSTOMER_RATE_LIMITS.login.ip.max + 2; i++) {
        statuses.push((await post(limited, "/auth/login", { email: `ip${i}@example.test`, password: "x" }, {}, "203.0.113.5")).statusCode);
      }
      expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
      const res = await post(limited, "/auth/login", { email: "ip99@example.test", password: "x" }, {}, "203.0.113.5");
      expect(res.json().error.code).toBe("RATE_LIMITED");
      // A different client is unaffected.
      expect((await post(limited, "/auth/login", { email: "other@example.test", password: "x" }, {}, "203.0.113.6")).statusCode).toBe(400);
    } finally {
      await limited.close();
    }
  });

  it("per email: rotating IPs does not help, and the limit applies to known and unknown addresses alike", async () => {
    for (const email of ["a1@example.test", "nobody@example.test"]) {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await post(app, "/auth/forgot-password", { email }, {}, `198.51.100.${i + 1}`)).statusCode);
      }
      expect(statuses, email).toEqual([202, 202, 202, 429, 429]);
    }
  });

  it("per email on register and resend-verification", async () => {
    const reg: number[] = [];
    for (let i = 0; i < 4; i++) reg.push((await post(app, "/auth/register", { name: "N", email: "limit@example.test" })).statusCode);
    expect(reg).toEqual([202, 202, 202, 429]);
    const resend: number[] = [];
    for (let i = 0; i < 4; i++) resend.push((await post(app, "/auth/resend-verification", { email: "limit2@example.test" })).statusCode);
    expect(resend).toEqual([202, 202, 202, 429]);
  });

  it("the per-email limit on verify-email stops code guessing across many IPs", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await post(app, "/auth/verify-email", { email: "pending@example.test", code: "000000", password: CUSTOMER_PASSWORD }, {}, `192.0.2.${i + 1}`)).statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("a limit answer carries Retry-After", async () => {
    for (let i = 0; i < 3; i++) await post(app, "/auth/forgot-password", { email: "r@example.test" });
    const res = await post(app, "/auth/forgot-password", { email: "r@example.test" });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("timing: unknown and real addresses cost the same", () => {
  it("login does one bcrypt compare for a real account, for an unknown address and for an ineligible one", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    for (const email of ["a1@example.test", "nobody@example.test", "unverified@example.test", "staff@example.test", "disabled@example.test"]) {
      compare.mockClear();
      await post(app, "/auth/login", { email, password: "wrong-example-password" });
      expect(compare, email).toHaveBeenCalledTimes(1);
    }
  });

  it("verify-email and reset-password do the same bcrypt hash whether or not the address exists", async () => {
    const hash = vi.spyOn(bcrypt, "hash");
    for (const email of ["nobody@example.test", "a1@example.test", "staff@example.test"]) {
      hash.mockClear();
      await post(app, "/auth/verify-email", { email, code: "000000", password: CUSTOMER_PASSWORD });
      expect(hash, `verify ${email}`).toHaveBeenCalledTimes(1);
      hash.mockClear();
      await post(app, "/auth/reset-password", { email, code: "000000", newPassword: CUSTOMER_PASSWORD });
      expect(hash, `reset ${email}`).toHaveBeenCalledTimes(1);
    }
  });

  it("register, resend and forgot all take at least the response floor, whatever the branch", async () => {
    setResponseFloorMs(120);
    for (const [path, body] of [
      ["/auth/register", { name: "N", email: "floor1@example.test" }],
      ["/auth/register", { name: "N", email: "a1@example.test" }],
      ["/auth/register", { name: "N", email: "staff@example.test" }],
      ["/auth/forgot-password", { email: "a1@example.test" }],
      ["/auth/forgot-password", { email: "nobody@example.test" }],
      ["/auth/resend-verification", { email: "nobody@example.test" }],
    ] as const) {
      const started = Date.now();
      await post(app, path, body);
      expect(Date.now() - started, `${path} ${JSON.stringify(body)}`).toBeGreaterThanOrEqual(115);
    }
  });
});
