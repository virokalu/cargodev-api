// One-time codes and email (slice 5 fixes): keyed storage, email only after the response, hourly request caps, and
// identical answers and timing for a registered, an unregistered and a staff address. Fake data only.

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { newCustomerFake, post } from "./helpers/customer-fixtures.js";
import { onVirtualClock } from "./helpers/virtual-clock.js";

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({
  fake: undefined as unknown,
  sent: [] as { to: string; subject: string; text: string; sentAfterResponse: boolean }[],
  responseSent: false,
  sendDelayMs: 0,
  sendFails: false,
}));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/lib/email.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/email.js")>();
  return {
    ...actual,
    sendEmail: async (message: { to: string; subject: string; text: string }) => {
      state.sent.push({ ...message, sentAfterResponse: state.responseSent });
      if (state.sendDelayMs) await new Promise((r) => setTimeout(r, state.sendDelayMs));
      if (state.sendFails) throw new Error("provider down");
      return { sent: true };
    },
  };
});

import { OTP_REQUEST_LIMITS } from "../src/config/otp-limits.js";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { drainEmailQueue, queueEmail } from "../src/lib/email-queue.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { setResponseFloorMs } from "../src/lib/min-duration.js";
import { hashOtp, otpMatches } from "../src/lib/otp.js";
import { registerPostResponse } from "../src/lib/post-response.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";

let app: FastifyInstance;
let fake: FakePrisma;

beforeEach(async () => {
  fake = newCustomerFake();
  state.fake = fake;
  state.sent = [];
  state.responseSent = false;
  state.sendDelayMs = 0;
  state.sendFails = false;
  resetShadowLockouts();
  identifierLimiter.reset();
  setResponseFloorMs(0);
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await drainEmailQueue();
  await app.close();
  setResponseFloorMs(0);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe("OTP_PEPPER", () => {
  const base = {
    DATABASE_URL: "postgresql://user:password@example.test:5432/dbname",
    MOBILE_JWT_SECRET: "mobile-secret-value-0123456789abcdefXX",
    ORG_ID: "org_x",
  };
  const withCustomer = { ...base, CUSTOMER_JWT_SECRET: "customer-secret-value-0123456789abcdefX" };
  const pepper = "pepper-secret-value-0123456789abcdefXXXX";

  // loadEnv caches; re-import it per case.
  const load = async () => {
    vi.resetModules();
    return (await import("../src/config/env.js")).loadEnv;
  };

  it("is required when the customer API is configured, and the error names the variable, never a value", async () => {
    const fresh = await load();
    let message = "";
    try {
      fresh(withCustomer);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("OTP_PEPPER");
    expect(message).not.toContain(withCustomer.CUSTOMER_JWT_SECRET);
  });

  it("is not required when the customer API is not configured", async () => {
    expect((await load())(base).OTP_PEPPER).toBeUndefined();
  });

  it("must be at least 32 BYTES", async () => {
    for (const short of ["", "x".repeat(31)]) {
      const fresh = await load();
      expect(() => fresh({ ...withCustomer, OTP_PEPPER: short })).toThrow(/OTP_PEPPER/);
    }
    expect((await load())({ ...withCustomer, OTP_PEPPER: "x".repeat(32) }).OTP_PEPPER).toHaveLength(32);
    // 16 two-byte characters = 32 bytes: counted in bytes, not characters
    expect((await load())({ ...withCustomer, OTP_PEPPER: "é".repeat(16) }).OTP_PEPPER).toBeDefined();
  });

  it("must differ from both JWT secrets", async () => {
    for (const same of [withCustomer.MOBILE_JWT_SECRET, withCustomer.CUSTOMER_JWT_SECRET]) {
      const fresh = await load();
      expect(() => fresh({ ...withCustomer, OTP_PEPPER: same })).toThrow(/OTP_PEPPER/);
    }
    expect((await load())({ ...withCustomer, OTP_PEPPER: pepper }).OTP_PEPPER).toBe(pepper);
  });

  it("the stored code hash is an HMAC keyed by the pepper: not a plain hash, not keyed by a JWT secret", () => {
    const env = loadEnv();
    const code = "123456";
    const stored = hashOtp("org_a", "user_a", "RESET", code);
    const material = `otp:org_a:user_a:RESET:${code}`;
    expect(stored).toBe(createHmac("sha256", env.OTP_PEPPER!).update(material).digest("hex"));
    expect(stored).not.toBe(createHash("sha256").update(material).digest("hex"));
    expect(stored).not.toBe(createHmac("sha256", env.CUSTOMER_JWT_SECRET!).update(material).digest("hex"));
    expect(stored).not.toBe(createHmac("sha256", env.MOBILE_JWT_SECRET).update(material).digest("hex"));
  });

  it("binds the code to org, user and purpose, and compares in constant time", () => {
    const stored = hashOtp("org_a", "user_a", "RESET", "123456");
    expect(otpMatches(stored, "org_a", "user_a", "RESET", "123456")).toBe(true);
    for (const [org, user, purpose, code] of [["org_b", "user_a", "RESET", "123456"], ["org_a", "user_b", "RESET", "123456"], ["org_a", "user_a", "VERIFY_EMAIL", "123456"], ["org_a", "user_a", "RESET", "123457"]]) {
      expect(otpMatches(stored, org!, user!, purpose!, code!)).toBe(false);
    }
    expect(otpMatches("abcd", "org_a", "user_a", "RESET", "123456")).toBe(false); // wrong length never throws
    expect(readFileSync("src/lib/otp.ts", "utf8")).toContain("timingSafeEqual(");
  });

  it("a code stored in the database cannot be recovered from the row by trying all 1,000,000 codes WITHOUT the pepper", async () => {
    const stored = hashOtp("org_a", "user_a", "RESET", "424242");
    let found: string | null = null;
    for (let n = 0; n < 1_000_000 && found === null; n += 1) {
      const guess = String(n).padStart(6, "0");
      if (createHash("sha256").update(`otp:org_a:user_a:RESET:${guess}`).digest("hex") === stored) found = guess;
    }
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("email goes out only AFTER the response, and never changes it", () => {
  async function tinyApp(handler: () => void): Promise<FastifyInstance> {
    const tiny = Fastify();
    registerPostResponse(tiny);
    const order: string[] = [];
    (tiny as unknown as { order: string[] }).order = order;
    tiny.addHook("onSend", async (_request, _reply, payload) => {
      order.push("response");
      state.responseSent = true;
      return payload;
    });
    tiny.get("/x", async () => {
      order.push("handler");
      handler();
      return { data: { accepted: true } };
    });
    await tiny.ready();
    return tiny;
  }

  it("a request that queues an email and one that does not return the same answer; the email is sent after the response", async () => {
    const tiny = await tinyApp(() => queueEmail({ to: "a@example.test", subject: "s", text: "t" }));
    const res = await tiny.inject({ method: "GET", url: "/x" });
    expect(res.json()).toEqual({ data: { accepted: true } });
    await drainEmailQueue();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.sentAfterResponse).toBe(true);
    await tiny.close();
  });

  it("nothing is sent while the handler is still running", async () => {
    let sentDuringHandler = -1;
    const tiny = await tinyApp(() => {
      queueEmail({ to: "a@example.test", subject: "s", text: "t" });
      sentDuringHandler = state.sent.length;
    });
    await tiny.inject({ method: "GET", url: "/x" });
    expect(sentDuringHandler).toBe(0);
    await tiny.close();
  });

  it("a slow send does not slow the answer, and a failing send does not change it", async () => {
    state.sendDelayMs = 400;
    const tiny = await tinyApp(() => queueEmail({ to: "a@example.test", subject: "s", text: "t" }));
    // On a virtual clock: if the handler waited for the 400 ms send, 400 virtual ms would pass before the answer.
    const { result: res, ms } = await onVirtualClock(() => tiny.inject({ method: "GET", url: "/x" }));
    expect(ms).toBe(0);
    expect(res.statusCode).toBe(200);
    state.sendFails = true;
    const failing = await tiny.inject({ method: "GET", url: "/x" });
    expect(failing.statusCode).toBe(200);
    expect(failing.json()).toEqual({ data: { accepted: true } });
    await drainEmailQueue(); // a rejected send is swallowed, never an unhandled rejection
    await tiny.close();
  });

  it("outside a request the email still goes out, on the next tick", async () => {
    queueEmail({ to: "a@example.test", subject: "s", text: "t" });
    expect(state.sent).toHaveLength(0);
    await drainEmailQueue();
    await new Promise((r) => setImmediate(r));
    await drainEmailQueue();
    expect(state.sent).toHaveLength(1);
  });

  it("the real app sends the verification email after its answer, and a failing provider changes nothing", async () => {
    state.sendFails = true;
    const res = await post(app, "/auth/register", { name: "New Person", email: "new1@example.test" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ data: { accepted: true } });
    await drainEmailQueue();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.to).toBe("new1@example.test");
  });

  it("a failed send logs only a masked address (the real sendEmail)", async () => {
    vi.resetModules();
    const real = await vi.importActual<typeof import("../src/lib/email.js")>("../src/lib/email.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await real.sendEmail({ to: "someone@example.test", subject: "s", text: "secret body 123456" });
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("s***@example.test");
    expect(logged).not.toContain("someone@");
    expect(logged).not.toContain("123456");
  });
});

// ---------------------------------------------------------------------------------------------

describe("hourly caps on requesting codes", () => {
  const mail = () => state.sent.filter((m) => /code/i.test(m.subject));
  const body = { name: "Cap Person", email: "cap1@example.test" };

  it("the limits are in the config module", () => {
    expect(OTP_REQUEST_LIMITS.perAddress).toEqual({ max: 5, windowMs: 3_600_000 });
    expect(OTP_REQUEST_LIMITS.perIp).toEqual({ max: 20, windowMs: 3_600_000 });
  });

  it("per address: the sixth request in an hour is answered the same but issues no code and sends no email", async () => {
    const answers: unknown[] = [];
    for (let i = 0; i < 3; i += 1) answers.push((await post(app, "/auth/register", body, {}, "10.0.0.1")).json());
    for (let i = 0; i < 3; i += 1) answers.push((await post(app, "/auth/resend-verification", { email: body.email }, {}, "10.0.0.1")).json());
    await drainEmailQueue();
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify({ data: { accepted: true } })]));
    expect(mail()).toHaveLength(5); // the sixth was dropped silently
    expect(fake.rows("otpCode")).toHaveLength(5);
  });

  it("the cap counts requests for addresses that do not exist, and for staff, so it reveals nothing", async () => {
    for (const email of ["nobody@example.test", "staff@example.test"]) {
      identifierLimiter.reset();
      for (let i = 0; i < 6; i += 1) {
        const res = await post(app, "/auth/forgot-password", { email }, {}, "10.0.0.2");
        expect(res.statusCode).toBe(i < 3 ? 202 : 429); // forgot-password has its own identifier limit of 3
        if (res.statusCode === 429) break;
      }
    }
    expect(mail()).toHaveLength(0);
  });

  it("per IP: the 21st address from one IP in an hour gets the same answer and no account or email; another IP is unaffected", async () => {
    const answers: string[] = [];
    for (let i = 1; i <= 21; i += 1) {
      const res = await post(app, "/auth/register", { name: "Ip Person", email: `ip${i}@example.test` }, {}, "10.0.0.3");
      answers.push(`${res.statusCode} ${res.body}`);
    }
    await drainEmailQueue();
    expect(new Set(answers).size).toBe(1);
    expect(mail()).toHaveLength(20);
    expect(fake.rows("user").some((u) => u["email"] === "ip21@example.test")).toBe(false);
    expect(fake.rows("user").some((u) => u["email"] === "ip20@example.test")).toBe(true);

    await post(app, "/auth/register", { name: "Other Ip", email: "ip22@example.test" }, {}, "10.0.0.4");
    await drainEmailQueue();
    expect(fake.rows("user").some((u) => u["email"] === "ip22@example.test")).toBe(true);
  });

  it("going over the cap logs a masked address and never the code, the full address or the IP", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 4; i += 1) await post(app, "/auth/register", { name: "Cap Person", email: "capmask@example.test" }, {}, "10.0.0.5");
    // register's own identifier limit is 3/hour (429); use resend, which shares the address cap
    for (let i = 0; i < 4; i += 1) await post(app, "/auth/resend-verification", { email: "capmask@example.test" }, {}, "10.0.0.5");
    await drainEmailQueue();
    const text = warn.mock.calls.flat().join(" ");
    expect(text).toContain("over the hourly cap (address): to=c***@example.test");
    expect(text).not.toContain("capmask@");
    expect(text).not.toContain("10.0.0.5");
    expect(text).not.toMatch(/\b\d{6}\b/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("a registered, an unregistered and a staff address look the same (answer, status and timing)", () => {
  const FLOOR = 90;

  const addresses = {
    registered: (i: number) => (i % 2 === 0 ? "a1@example.test" : "a2@example.test"),
    unregistered: (i: number) => `nobody${i}@example.test`,
    staff: () => "staff@example.test",
  };

  async function sample(path: string, kind: keyof typeof addresses, i: number) {
    identifierLimiter.reset();
    const email = addresses[kind](i);
    // Virtual time: the floor timer is the only thing a response waits on, so this does not depend on how busy the machine is.
    const { result: res, ms } = await onVirtualClock(() => post(app, path, path === "/auth/register" ? { name: "Timing Person", email } : { email }, {}, `10.1.${i}.1`));
    return { ms, status: res.statusCode, body: res.body };
  }

  it.each(["/auth/register", "/auth/resend-verification", "/auth/forgot-password"])("%s", async (path) => {
    setResponseFloorMs(FLOOR);
    const medians: Record<string, number> = {};
    const answers = new Set<string>();
    for (const kind of Object.keys(addresses) as (keyof typeof addresses)[]) {
      const times: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const s = await sample(path, kind, i);
        times.push(s.ms);
        answers.add(`${s.status} ${s.body}`);
      }
      // Every response waits for exactly the floor: no shorter (the branch cost would show) and no longer (extra waiting would show).
      expect(times, `${kind}: every response takes exactly the floor`).toEqual([FLOOR, FLOOR, FLOOR, FLOOR, FLOOR]);
      medians[kind] = times[2]!;
    }
    expect(answers.size, "one status and body for every kind of address").toBe(1);
    expect(new Set(Object.values(medians)).size, JSON.stringify(medians)).toBe(1);
  });

  it("email delivery is not part of the measured time", async () => {
    setResponseFloorMs(FLOOR);
    state.sendDelayMs = 500;
    const slow = await sample("/auth/register", "unregistered", 1); // sends an email
    const none = await sample("/auth/register", "registered", 1); // sends the "already registered" email
    // The 500 ms send happens after the response: neither answer waits for it.
    expect(slow.ms).toBe(FLOOR);
    expect(none.ms).toBe(FLOOR);
  });
});
