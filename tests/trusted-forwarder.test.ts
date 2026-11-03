// The trusted forwarder (ADR 0008): a server-side caller proves itself with an HMAC and may pass the real visitor address.
// Every verification step has a test that fails if the step is removed. Fake secrets and documentation addresses only.

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));

import { buildApp } from "../src/app.js";
import { checkForwardedAddress, signForwardedAddress } from "../src/lib/trusted-forwarder.js";

// Built from parts so no secret-looking literal sits in the file.
const SECRET = ["forwarder", "current", "value", "0123456789abcdef", "XYZ"].join("-");
const PREVIOUS = ["forwarder", "previous", "value", "0123456789abcdef", "XYZ"].join("-");
const WRONG = ["forwarder", "wrong", "value", "0123456789abcdef", "XYZ"].join("-");
const SOCKET = "10.0.0.1"; // the caller's own address
const NOW = 1_800_000_000; // seconds
const A = "203.0.113.10";
const B = "203.0.113.11";

let app: FastifyInstance | undefined;
let clock = NOW * 1000;
let warnings: string[] = [];
const refused = () => warnings.filter((m) => m.startsWith("forwarded client address refused"));

beforeEach(() => {
  resetShadowLockouts();
  state.fake = createFakePrisma();
  clock = NOW * 1000;
  warnings = [];
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(secrets: string[]): Promise<FastifyInstance> {
  const built = await buildApp({ rateLimit: true, forwarderSecrets: secrets, forwarderNow: () => clock, onClientIpWarning: (m) => warnings.push(m) });
  built.get("/__ip", async (request) => ({ ip: request.ip }));
  app = built;
  return built;
}

// Same 32 bytes, different last character (its low 4 bits are unused): a decoder that ignores them would accept it.
const nonCanonicalLast = (sig: string): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(sig.slice(-1));
  return alphabet[(last & 0b110000) | ((last + 1) & 0b001111)]!;
};
const headersFor = (ip: string, secret = SECRET, timestamp = NOW, signIp = ip): Record<string, string> => ({
  "x-client-ip": ip,
  "x-forwarder-timestamp": String(timestamp),
  "x-forwarder-signature": signForwardedAddress(secret, signIp, timestamp),
});
const ipSeen = async (a: FastifyInstance, headers: Record<string, string> = {}, url = "/__ip") => {
  const res = await a.inject({ method: "GET", url, remoteAddress: SOCKET, headers });
  return url === "/__ip" ? (res.json() as { ip: string }).ip : res.statusCode;
};

describe("a valid signature", () => {
  it("makes the verified address request.ip", async () => {
    const a = await build([SECRET]);
    expect(await ipSeen(a, headersFor(A))).toBe(A);
    expect(await ipSeen(a)).toBe(SOCKET);
  });

  it("accepts an IPv6 address", async () => {
    const a = await build([SECRET]);
    expect(await ipSeen(a, headersFor("2001:db8::1"))).toBe("2001:db8::1");
  });

  it("is accepted on the staff, public and customer-zone paths alike (the secret proves the caller, not the route)", async () => {
    const a = await build([SECRET]);
    for (const url of ["/health", "/api/v1/auth/login", "/api/public/stock", "/api/customer/v1/auth/login"]) {
      const first = await a.inject({ method: "GET", url, remoteAddress: SOCKET, headers: headersFor(A) });
      const second = await a.inject({ method: "GET", url, remoteAddress: SOCKET, headers: headersFor(B) });
      // two visitors behind one caller get separate rate-limit counters: the second is not one request further down than the first
      expect(first.headers["x-ratelimit-remaining"], url).toBe(second.headers["x-ratelimit-remaining"]);
    }
  });

  it("gives two forwarded visitors separate rate-limit buckets (login: 10 a minute each)", async () => {
    const a = await build([SECRET]);
    let n = 0;
    const login = (ip: string) =>
      a.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: SOCKET, headers: headersFor(ip), payload: { email: `nobody${++n}@example.test`, password: "x" } });
    const forA: number[] = [];
    for (let i = 0; i < 12; i += 1) forA.push((await login(A)).statusCode);
    expect(forA.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(forA.slice(10)).toEqual([429, 429]);
    // visitor B is untouched by A's exhausted bucket, and the caller's own address (no headers) has its own bucket too
    expect((await login(B)).statusCode).toBe(400);
    const own = await a.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: SOCKET, payload: { email: "own@example.test", password: "x" } });
    expect(own.statusCode).toBe(400);
  }, 30_000);
});

describe("anything wrong and the headers are ignored entirely (the caller's own address stands)", () => {
  it.each([
    ["a tampered address", () => headersFor(B, SECRET, NOW, A)],
    ["a tampered timestamp", () => ({ ...headersFor(A), "x-forwarder-timestamp": String(NOW + 1) })],
    ["a tampered signature", () => ({ ...headersFor(A), "x-forwarder-signature": signForwardedAddress(SECRET, A, NOW).replace(/^./, (c) => (c === "A" ? "B" : "A")) })],
    ["the wrong secret", () => headersFor(A, WRONG)],
    ["a signature made for another version tag", () => ({ ...headersFor(A), "x-forwarder-signature": signForwardedAddress(SECRET, `${A}|x`, NOW) })],
    ["a missing signature", () => ({ "x-client-ip": A, "x-forwarder-timestamp": String(NOW) })],
    ["a missing timestamp", () => ({ "x-client-ip": A, "x-forwarder-signature": signForwardedAddress(SECRET, A, NOW) })],
    ["only the address header", () => ({ "x-client-ip": A })],
  ])("%s", async (_name, make) => {
    const a = await build([SECRET]);
    expect(await ipSeen(a, make())).toBe(SOCKET);
  });

  it("a signature that is not 32 bytes of base64url is refused before any comparison", async () => {
    const a = await build([SECRET]);
    for (const signature of ["", "abc", `${signForwardedAddress(SECRET, A, NOW)}=`, signForwardedAddress(SECRET, A, NOW).slice(0, 42) + nonCanonicalLast(signForwardedAddress(SECRET, A, NOW)), `${signForwardedAddress(SECRET, A, NOW)}AA`, "!".repeat(43)]) {
      expect(await ipSeen(a, { ...headersFor(A), "x-forwarder-signature": signature })).toBe(SOCKET);
    }
  });
});

describe("the timestamp", () => {
  it("60 seconds old is fine, 61 is expired", async () => {
    const a = await build([SECRET]);
    expect(await ipSeen(a, headersFor(A, SECRET, NOW - 60))).toBe(A);
    expect(await ipSeen(a, headersFor(A, SECRET, NOW - 61))).toBe(SOCKET);
  });

  it("30 seconds ahead (clock skew) is fine, 31 is refused", async () => {
    const a = await build([SECRET]);
    expect(await ipSeen(a, headersFor(A, SECRET, NOW + 30))).toBe(A);
    expect(await ipSeen(a, headersFor(A, SECRET, NOW + 31))).toBe(SOCKET);
  });

  it("a validly signed old message cannot be replayed later", async () => {
    const a = await build([SECRET]);
    const headers = headersFor(A);
    expect(await ipSeen(a, headers)).toBe(A);
    clock += 120_000;
    expect(await ipSeen(a, headers)).toBe(SOCKET);
  });

  it.each(["", "abc", "-5", "1.5", "1e9", " 1800000000", "1800000000 ", "0x10", "9999999999999"])("a malformed timestamp %j is refused", async (value) => {
    const a = await build([SECRET]);
    expect(await ipSeen(a, { ...headersFor(A), "x-forwarder-timestamp": value })).toBe(SOCKET);
  });
});

describe("rotation: the previous secret", () => {
  it("is accepted while it is configured, and refused once it is gone", async () => {
    const rotating = await build([SECRET, PREVIOUS]);
    expect(await ipSeen(rotating, headersFor(A, PREVIOUS))).toBe(A);
    expect(await ipSeen(rotating, headersFor(A, SECRET))).toBe(A);
    await app?.close();
    const done = await build([SECRET]);
    expect(await ipSeen(done, headersFor(A, PREVIOUS))).toBe(SOCKET);
  });
});

describe("malformed addresses are refused, even with a valid signature over them", () => {
  it.each([
    "999.1.1.1",
    "1.2.3",
    "1.2.3.4, 5.6.7.8",
    "1.2.3.4,5.6.7.8",
    " 1.2.3.4",
    "1.2.3.4 ",
    "1.2.3.4:8080",
    "[2001:db8::1]",
    "fe80::1%eth0",
    "localhost",
    "1.2.3.4\n5.6.7.8",
    "::1;DROP",
    "0x7f.1",
    "",
    "1".repeat(60),
  ])("%j", async (bad) => {
    const a = await build([SECRET]);
    const signature = signForwardedAddress(SECRET, bad, NOW);
    const res = await a.inject({ method: "GET", url: "/__ip", remoteAddress: SOCKET, headers: { "x-client-ip": bad.replace(/\n/g, " "), "x-forwarder-timestamp": String(NOW), "x-forwarder-signature": signature } });
    expect((res.json() as { ip: string }).ip).toBe(SOCKET);
  });

  it("two copies of the address header (header injection) are not merged into a list that verifies", async () => {
    const a = await build([SECRET]);
    const res = await a.inject({
      method: "GET",
      url: "/__ip",
      remoteAddress: SOCKET,
      headers: { ...headersFor(A), "x-client-ip": [A, B] as unknown as string },
    });
    expect((res.json() as { ip: string }).ip).toBe(SOCKET);
  });

  it("a plain X-Forwarded-For or X-Real-IP never changes the address, with or without the feature", async () => {
    const a = await build([SECRET]);
    expect(await ipSeen(a, { "x-forwarded-for": A, "x-real-ip": B })).toBe(SOCKET);
  });
});

describe("the feature is off without a secret", () => {
  it("valid-looking headers are ignored and the socket address is used", async () => {
    const a = await build([]);
    expect(await ipSeen(a, headersFor(A))).toBe(SOCKET);
    expect(refused()).toEqual([]); // no verification ran, so nothing was "refused"
  });

  it("the secrets can come from the environment (TRUSTED_FORWARDER_SECRET and the previous one)", async () => {
    vi.stubEnv("TRUSTED_FORWARDER_SECRET", SECRET);
    vi.stubEnv("TRUSTED_FORWARDER_SECRET_PREVIOUS", PREVIOUS);
    try {
      vi.resetModules(); // the environment is read once per module instance
      const { buildApp: buildFresh } = await import("../src/app.js");
      const built = await buildFresh({ rateLimit: true, forwarderNow: () => clock, onClientIpWarning: (m) => warnings.push(m) });
      built.get("/__ip", async (request) => ({ ip: request.ip }));
      app = built;
      expect(await ipSeen(built, headersFor(A, SECRET))).toBe(A);
      expect(await ipSeen(built, headersFor(B, PREVIOUS))).toBe(B);
      expect(await ipSeen(built, headersFor(A, WRONG))).toBe(SOCKET);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the warning", () => {
  it("is logged once a minute at most, names the reason and header names, and never a value", async () => {
    const a = await build([SECRET]);
    const bad = headersFor(B, SECRET, NOW, A);
    for (let i = 0; i < 5; i += 1) await ipSeen(a, bad);
    expect(refused()).toHaveLength(1);
    expect(warnings[0]).toContain("signature");
    expect(warnings[0]).toContain("x-client-ip");
    for (const secret of [A, B, bad["x-forwarder-signature"]!, SECRET, PREVIOUS]) expect(warnings[0]).not.toContain(secret);
    clock += 61_000;
    await ipSeen(a, { ...headersFor(A, SECRET, NOW + 61), "x-forwarder-signature": "x" });
    expect(refused()).toHaveLength(2);
    expect(refused()[1]).toContain("malformed");
  });

  it("is not logged for a valid request or a request without the headers", async () => {
    const a = await build([SECRET]);
    await ipSeen(a, headersFor(A));
    await ipSeen(a);
    expect(warnings).toEqual([]); // not even the socket-mode "forwarding header seen" warning: X-Client-IP is this feature's own header
  });
});

describe("checkForwardedAddress (the verification itself)", () => {
  const ok = { secrets: [SECRET], ip: A, timestamp: String(NOW), signature: signForwardedAddress(SECRET, A, NOW), nowSeconds: NOW };

  it("accepts the good case and returns the address", () => {
    expect(checkForwardedAddress(ok)).toEqual({ ok: true, ip: A });
  });

  it("names the reason for each refusal", () => {
    expect(checkForwardedAddress({ ...ok, ip: "nope" })).toEqual({ ok: false, reason: "malformed" });
    expect(checkForwardedAddress({ ...ok, timestamp: "x" })).toEqual({ ok: false, reason: "malformed" });
    expect(checkForwardedAddress({ ...ok, signature: undefined })).toEqual({ ok: false, reason: "malformed" });
    expect(checkForwardedAddress({ ...ok, nowSeconds: NOW + 61 })).toEqual({ ok: false, reason: "expired" });
    expect(checkForwardedAddress({ ...ok, nowSeconds: NOW - 31 })).toEqual({ ok: false, reason: "future" });
    expect(checkForwardedAddress({ ...ok, secrets: [WRONG] })).toEqual({ ok: false, reason: "signature" });
    expect(checkForwardedAddress({ ...ok, secrets: [] })).toEqual({ ok: false, reason: "signature" });
  });

  it("the signature covers the version tag, the address and the timestamp", () => {
    const sig = signForwardedAddress(SECRET, A, NOW);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signForwardedAddress(SECRET, A, NOW + 1)).not.toBe(sig);
    expect(signForwardedAddress(SECRET, B, NOW)).not.toBe(sig);
    expect(signForwardedAddress(WRONG, A, NOW)).not.toBe(sig);
  });
});
