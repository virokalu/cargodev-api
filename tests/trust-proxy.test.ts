import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { buildApp } from "../src/app.js";

const PROXY = "10.0.0.1"; // the socket peer in these tests
let app: FastifyInstance | undefined;

beforeEach(() => {
  resetShadowLockouts();
  state.fake = createFakePrisma();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(trustProxyHops: number): Promise<FastifyInstance> {
  const built = await buildApp({ rateLimit: true, trustProxyHops });
  // Test-only probe route: what IP does the server believe the client has?
  built.get("/__ip", async (request) => ({ ip: request.ip }));
  app = built;
  return built;
}

const clientIp = async (a: FastifyInstance, xff?: string): Promise<string> => {
  const res = await a.inject({
    method: "GET",
    url: "/__ip",
    remoteAddress: PROXY,
    ...(xff ? { headers: { "x-forwarded-for": xff } } : {}),
  });
  return res.json().ip;
};

// A different email per call, so the per-email lockout never answers before the rate limiter does.
let emailCounter = 0;
const login = (a: FastifyInstance, xff?: string) =>
  a.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: PROXY,
    payload: { email: `nobody${++emailCounter}@example.test`, password: "x" },
    ...(xff ? { headers: { "x-forwarded-for": xff } } : {}),
  });

describe("TRUST_PROXY_HOPS = 0 (default): X-Forwarded-For is ignored", () => {
  it("the client IP is the socket address, whatever the header says", async () => {
    const a = await build(0);
    expect(await clientIp(a, "203.0.113.50")).toBe(PROXY);
    expect(await clientIp(a, "1.2.3.4, 5.6.7.8")).toBe(PROXY);
    expect(await clientIp(a)).toBe(PROXY);
  });

  it("a spoofed header does not change the rate-limit key, so rotating it cannot dodge the limit", async () => {
    const a = await build(0);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await login(a, `203.0.113.${i + 1}`)).statusCode);
    }
    // 10 allowed per minute, then 429, even though every request claimed a new IP.
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  }, 30_000);
});

describe("TRUST_PROXY_HOPS = 1: exactly one proxy is trusted", () => {
  it("uses the address the trusted proxy appended", async () => {
    const a = await build(1);
    expect(await clientIp(a, "203.0.113.7")).toBe("203.0.113.7");
  });

  it("ignores entries a client prepended to the header (only the proxy-appended one counts)", async () => {
    const a = await build(1);
    expect(await clientIp(a, "1.2.3.4, 203.0.113.7")).toBe("203.0.113.7");
    expect(await clientIp(a, "9.9.9.9, 8.8.8.8, 203.0.113.7")).toBe("203.0.113.7");
  });

  it("falls back to the socket address when there is no header", async () => {
    const a = await build(1);
    expect(await clientIp(a)).toBe(PROXY);
  });

  it("rate limits per real client: different clients get separate buckets, one client cannot dodge by prepending", async () => {
    const a = await build(1);

    // One real client (203.0.113.7) rotating a spoofed leading entry: still one bucket.
    const same: number[] = [];
    for (let i = 0; i < 12; i++) same.push((await login(a, `10.9.9.${i}, 203.0.113.7`)).statusCode);
    expect(same.slice(10)).toEqual([429, 429]);

    // A different real client is unaffected.
    expect((await login(a, "198.51.100.9")).statusCode).toBe(400);
  }, 30_000);
});

describe("TRUST_PROXY_HOPS = 2: two proxies are trusted, the client is the first untrusted address", () => {
  it("skips both trusted hops and ignores anything further left", async () => {
    const a = await build(2);
    // chain: socket (hop 0) -> 10.0.0.2 (hop 1) -> 198.51.100.4 is the client; 9.9.9.9 is client-supplied junk
    expect(await clientIp(a, "9.9.9.9, 198.51.100.4, 10.0.0.2")).toBe("198.51.100.4");
  });
});

describe("TRUST_PROXY_HOPS validation", () => {
  beforeEach(() => vi.resetModules());

  const load = async () => (await import("../src/config/env.js")).loadEnv;
  const base = {
    DATABASE_URL: "postgresql://user:password@localhost:5432/test_dummy",
    MOBILE_JWT_SECRET: "test-only-dummy-value-0123456789abcdef",
    ORG_ID: "org_test_a",
  };

  it("defaults to 0", async () => {
    expect((await load())({ ...base }).TRUST_PROXY_HOPS).toBe(0);
  });

  it("accepts a small non-negative integer given as a string", async () => {
    expect((await load())({ ...base, TRUST_PROXY_HOPS: "1" }).TRUST_PROXY_HOPS).toBe(1);
  });

  it.each(["-1", "1.5", "abc", "11", "true"])("rejects %s", async (value) => {
    const loadEnv = await load();
    expect(() => loadEnv({ ...base, TRUST_PROXY_HOPS: value })).toThrow(/TRUST_PROXY_HOPS/);
  });
});
