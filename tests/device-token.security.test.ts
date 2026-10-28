import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

const sdk = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(token: unknown): boolean {
      return typeof token === "string" && /^Expo(nent)?PushToken\[.+\]$/.test(token);
    }
    chunkPushNotifications(messages: unknown[]): unknown[][] {
      return [messages];
    }
    sendPushNotificationsAsync = sdk.send;
  }
  return { Expo };
});

import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { redactSecrets, safeError } from "../src/lib/redact.js";
import { sendExpoPushNotifications } from "../src/lib/expo-push.js";
import { loginMobile, logoutMobile } from "../src/services/mobile-auth.service.js";

const GOOD = "example-Good-Passw0rd";
const TOKEN_1 = "ExponentPushToken[secretvalue111111111111]";
const TOKEN_2 = "ExponentPushToken[secretvalue222222222222]";
const meta = { ip: "203.0.113.7", userAgent: "test-agent" };

let fake: FakePrisma;
let app: FastifyInstance | undefined;

beforeEach(() => {
  resetShadowLockouts();
  sdk.send.mockReset();
  vi.restoreAllMocks();
  fake = createFakePrisma();
  state.fake = fake;
  const staff = (id: string, org_id: string, email: string) => ({
    id, org_id, name: id, email, role: "MANAGER", userType: "STAFF", loginEnabled: true,
    failedLoginAttempts: 0, lockoutUntil: null, password: bcrypt.hashSync(GOOD, 4),
  });
  fake.seed("user", staff("user_a1", ORG_A, "a1@example.test"), staff("user_a2", ORG_A, "a2@example.test"), staff("user_b1", ORG_B, "b1@example.test"));
  fake.seed(
    "deviceToken",
    { id: "dt1", org_id: ORG_A, userId: "user_a1", expoPushToken: TOKEN_1 },
    { id: "dt2", org_id: ORG_A, userId: "user_a2", expoPushToken: TOKEN_2 }
  );
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const tokens = () => fake.rows("deviceToken").map((r) => r["expoPushToken"]);
const loginA1 = () => loginMobile({ email: "a1@example.test", password: GOOD }, meta);

describe("logout removes this device's token", () => {
  it("removes the signing-out user's own device token and revokes the session", async () => {
    const session = await loginA1();
    await logoutMobile({ refreshToken: session.refreshToken, expoPushToken: TOKEN_1 });
    expect(tokens()).toEqual([TOKEN_2]);
    expect(fake.rows("refreshToken")[0]?.["revokedAt"]).toBeInstanceOf(Date);
  });

  it("never removes a token that belongs to someone else, even if the value is known", async () => {
    const session = await loginA1();
    await logoutMobile({ refreshToken: session.refreshToken, expoPushToken: TOKEN_2 }); // user_a2's phone
    expect(tokens()).toEqual([TOKEN_1, TOKEN_2]);
  });

  it("never removes a token in another org", async () => {
    fake.seed("deviceToken", { id: "dt_b", org_id: ORG_B, userId: "user_b1", expoPushToken: "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]" });
    const session = await loginA1();
    await logoutMobile({ refreshToken: session.refreshToken, expoPushToken: "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]" });
    expect(tokens()).toContain("ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]");
  });

  it("an unknown or garbage refresh token proves nothing, so nothing is removed and no error is raised", async () => {
    await expect(logoutMobile({ refreshToken: "unknown-refresh-value", expoPushToken: TOKEN_1 })).resolves.toBeUndefined();
    expect(tokens()).toEqual([TOKEN_1, TOKEN_2]);
  });

  it("without an expoPushToken, logout leaves device tokens alone", async () => {
    const session = await loginA1();
    await logoutMobile({ refreshToken: session.refreshToken });
    expect(tokens()).toEqual([TOKEN_1, TOKEN_2]);
  });

  it("is idempotent: logging out twice with the same device token is fine", async () => {
    const session = await loginA1();
    await logoutMobile({ refreshToken: session.refreshToken, expoPushToken: TOKEN_1 });
    await expect(logoutMobile({ refreshToken: session.refreshToken, expoPushToken: TOKEN_1 })).resolves.toBeUndefined();
  });

  it("works over HTTP without an access token (the refresh token is the proof)", async () => {
    app = await buildApp({ rateLimit: false });
    const session = await loginA1();
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout", payload: { refreshToken: session.refreshToken, expoPushToken: TOKEN_1 } });
    expect(res.json()).toEqual({ data: { loggedOut: true } });
    expect(tokens()).toEqual([TOKEN_2]);
  });
});

describe("token values never appear in error responses", () => {
  const bearer = async () => ({
    authorization: `Bearer ${await signAccessToken({ sub: "user_a1", orgId: ORG_A, role: "MANAGER", name: "n", email: null })}`,
  });

  it("an invalid token submitted for registration is not echoed back", async () => {
    app = await buildApp({ rateLimit: false });
    const submitted = "NotAnExpoToken-secretvalue-999";
    const res = await app.inject({ method: "POST", url: "/api/v1/device-tokens", headers: await bearer(), payload: { expoPushToken: submitted, platform: "ios" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(submitted);
  });

  it("a database failure whose message contains a token returns the generic 500", async () => {
    app = await buildApp({ rateLimit: false });
    (fake.client as unknown as { deviceToken: { upsert: unknown } }).deviceToken.upsert = async () => {
      throw new Error(`insert failed for ${TOKEN_1}`);
    };
    const res = await app.inject({ method: "POST", url: "/api/v1/device-tokens", headers: await bearer(), payload: { expoPushToken: TOKEN_1, platform: "ios" } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "INTERNAL", message: "Something went wrong." } });
    expect(res.body).not.toContain("secretvalue");
  });
});

describe("token values never appear in logs", () => {
  it("the request/error log never contains a device token, access token or authorization header", async () => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
    app = await buildApp({ logger: true, logStream: stream, rateLimit: false });

    const access = await signAccessToken({ sub: "user_a1", orgId: ORG_A, role: "MANAGER", name: "n", email: null });
    (fake.client as unknown as { deviceToken: { upsert: unknown } }).deviceToken.upsert = async () => {
      throw new Error(`insert failed for ${TOKEN_1} using Bearer ${access}`);
    };
    await app.inject({ method: "POST", url: "/api/v1/device-tokens", headers: { authorization: `Bearer ${access}` }, payload: { expoPushToken: TOKEN_1, platform: "ios" } });
    await app.inject({ method: "DELETE", url: "/api/v1/device-tokens", headers: { authorization: `Bearer ${access}` }, payload: { expoPushToken: TOKEN_1 } });

    const logs = chunks.join("");
    expect(logs).toContain("unexpected error"); // the failure WAS logged...
    expect(logs).not.toContain("secretvalue"); // ...without the token
    expect(logs).not.toContain(access);
  });

  it("a failing push never logs the device token it was sending to", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sdk.send.mockRejectedValue(new Error(`Expo rejected ${TOKEN_1}`));
    await sendExpoPushNotifications([{ expoPushToken: TOKEN_1 }], { title: "t", body: "b" });
    expect(log).toHaveBeenCalled();
    // JSON.stringify(Error) is "{}", so read message and stack explicitly.
    const logged = log.mock.calls
      .flat()
      .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg)))
      .join(" ");
    expect(logged).toContain("Expo rejected"); // it was logged...
    expect(logged).not.toContain("secretvalue"); // ...without the token
  });
});

describe("rate limit on register / unregister", () => {
  const headers = async () => ({
    authorization: `Bearer ${await signAccessToken({ sub: "user_a1", orgId: ORG_A, role: "MANAGER", name: "n", email: null })}`,
  });

  it("allows 20 registrations a minute, then answers 429 RATE_LIMITED", async () => {
    app = await buildApp({ rateLimit: true });
    const h = await headers();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const token = `ExponentPushToken[rate${String(i).padStart(18, "0")}]`;
      statuses.push((await app.inject({ method: "POST", url: "/api/v1/device-tokens", headers: h, payload: { expoPushToken: token, platform: "ios" } })).statusCode);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it("limits unregistering too, without limiting unrelated routes", async () => {
    app = await buildApp({ rateLimit: true });
    const h = await headers();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await app.inject({ method: "DELETE", url: "/api/v1/device-tokens", headers: h, payload: { expoPushToken: TOKEN_1 } })).statusCode;
    }
    expect(last).toBe(429);
    expect((await app.inject({ method: "GET", url: "/api/v1/notifications/unread-count", headers: h })).statusCode).toBe(200);
  });
});

describe("redactSecrets", () => {
  it("removes Expo push tokens, JWTs and bearer values", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signaturepart123";
    const text = `a ${TOKEN_1} b ExpoPushToken[abc123] c ${jwt} d Bearer abcdefgh12345678`;
    const out = redactSecrets(text);
    for (const secret of ["secretvalue", "abc123", jwt, "abcdefgh12345678"]) expect(out).not.toContain(secret);
    expect(out.match(/\[redacted\]/g)).toHaveLength(4);
  });
  it("leaves ordinary text alone", () => {
    expect(redactSecrets("Unique constraint failed on the fields: (`org_id`,`name`)")).toBe(
      "Unique constraint failed on the fields: (`org_id`,`name`)"
    );
  });
  it("safeError redacts message and stack, and copes with non-Errors", () => {
    const e = new Error(`failed for ${TOKEN_1}`);
    const safe = safeError(e);
    expect(safe.message).not.toContain("secretvalue");
    expect(safe.stack ?? "").not.toContain("secretvalue");
    expect(safeError(`raw ${TOKEN_1}`).message).not.toContain("secretvalue");
  });
});
