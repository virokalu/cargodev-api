// Real log output: run the whole customer flow with the logger ON and prove no password, code, token or full
// email address reaches it, then prove email stays a no-op with no key.

import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { CUSTOMER_PASSWORD, NEW_PASSWORD, codeFrom, newCustomerFake, post, request } from "./helpers/customer-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown, sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
// The REAL queue and the real email module run; only the final send is observed. No key is configured.
vi.mock("../src/lib/email.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/email.js")>();
  return {
    ...actual,
    sendEmail: async (message: { to: string; subject: string; text: string }) => {
      state.sent.push(message);
      return actual.sendEmail(message);
    },
  };
});

import { buildApp } from "../src/app.js";
import { drainEmailQueue } from "../src/lib/email-queue.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";

let app: FastifyInstance;
let logged = "";
let consoleOutput = "";

beforeEach(async () => {
  state.fake = newCustomerFake();
  state.sent = [];
  logged = "";
  consoleOutput = "";
  resetShadowLockouts();
  identifierLimiter.reset();
  const stream = new Writable({
    write(chunk, _enc, done) {
      logged += chunk.toString();
      done();
    },
  });
  app = await buildApp({ rateLimit: false, logger: true, logStream: stream });
  for (const method of ["warn", "error", "log", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput += `${args.map(String).join(" ")}\n`;
    });
  }
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe("the customer flow leaves no secret in the logs", () => {
  it("passwords, codes, tokens and full addresses never appear in pino output or the console", async () => {
    const email = "log.person@example.test";
    await post(app, "/auth/register", { name: "Log Person", email });
    await drainEmailQueue();
    const code = codeFrom(state.sent.at(-1));
    await post(app, "/auth/verify-email", { email, code, password: CUSTOMER_PASSWORD });
    const login = (await post(app, "/auth/login", { email, password: CUSTOMER_PASSWORD })).json().data;
    await post(app, "/auth/login", { email, password: "a-wrong-example-password" });
    await request(app, "GET", "/me", { authorization: `Bearer ${login.accessToken}` });
    await post(app, "/auth/refresh", { refreshToken: login.refreshToken });
    await post(app, "/auth/forgot-password", { email });
    await drainEmailQueue();
    const resetCode = codeFrom(state.sent.at(-1));
    await post(app, "/auth/reset-password", { email, code: resetCode, newPassword: NEW_PASSWORD });
    const again = (await post(app, "/auth/login", { email, password: NEW_PASSWORD })).json().data;
    await post(app, "/auth/delete-account", { password: NEW_PASSWORD }, { authorization: `Bearer ${again.accessToken}` });
    await drainEmailQueue();

    const everything = `${logged}\n${consoleOutput}`;
    expect(logged.length).toBeGreaterThan(0); // the logger really ran
    for (const secret of [CUSTOMER_PASSWORD, NEW_PASSWORD, "a-wrong-example-password", code, resetCode, login.accessToken, login.refreshToken, again.accessToken, again.refreshToken]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain(email);
    expect(everything).not.toContain("log.person");
  });

  it("the bearer token is not in request logs", async () => {
    const login = (await post(app, "/auth/login", { email: "a1@example.test", password: CUSTOMER_PASSWORD })).json().data;
    await request(app, "GET", "/me", { authorization: `Bearer ${login.accessToken}` });
    expect(logged).not.toContain(login.accessToken);
  });
});

describe("email is a no-op without RESEND_API_KEY", () => {
  it("makes no network call, and the notice that is logged is masked", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await post(app, "/auth/register", { name: "Quiet Person", email: "quiet.person@example.test" });
      await post(app, "/auth/forgot-password", { email: "a1@example.test" });
      await drainEmailQueue();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.sent.length).toBeGreaterThan(0);
      expect(consoleOutput).toContain("email not sent");
      expect(consoleOutput).toContain("q***@example.test");
      expect(consoleOutput).not.toContain("quiet.person");
      expect(consoleOutput).not.toMatch(/\b\d{6}\b/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
