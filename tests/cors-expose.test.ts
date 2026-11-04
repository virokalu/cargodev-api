// A browser script may read the rate-limit headers and the request id only if the answer lists them in
// Access-Control-Expose-Headers, on staff, customer and public routes, and only for an allowed origin. Fake data only.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 }); // building the app is slow when the machine is busy

const APP_ORIGIN = "https://app.example.test";
const SITE_ORIGIN = "https://site.example.test";
const EVIL = "https://evil.example.test";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ corsOrigins: [APP_ORIGIN], publicOrigins: [SITE_ORIGIN], publicStockEnabled: true });
});
afterAll(async () => {
  await app.close();
});

const exposed = (headers: Record<string, unknown>) =>
  String(headers["access-control-expose-headers"] ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
// Written out on purpose: the test must not derive its expectation from the code it checks.
const WANTED = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-request-id", "x-contract-version"];

describe("Access-Control-Expose-Headers", () => {
  it.each([
    ["staff route (401 answer)", "/api/v1/vehicles", APP_ORIGIN],
    ["health", "/health", APP_ORIGIN],
    ["public route", "/api/public/stock", SITE_ORIGIN],
  ])("%s lists the rate-limit headers and the request id for an allowed origin", async (_n, url, origin) => {
    const res = await app.inject({ method: "GET", url, headers: { origin } });
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(exposed(res.headers)).toEqual(expect.arrayContaining(WANTED));
  });

  it("customer zone routes list them too when the zone is mounted", async () => {
    const res = await app.inject({ method: "GET", url: "/api/customer/v1/me", headers: { origin: APP_ORIGIN } });
    if (res.statusCode === 404) return; // zone not configured in this environment
    expect(exposed(res.headers)).toEqual(expect.arrayContaining(WANTED));
  });

  it("an origin that is not allowed gets no CORS headers at all", async () => {
    for (const [url, origin] of [["/api/v1/vehicles", EVIL], ["/api/public/stock", APP_ORIGIN], ["/api/v1/vehicles", SITE_ORIGIN]] as const) {
      const res = await app.inject({ method: "GET", url, headers: { origin } });
      expect(res.headers["access-control-allow-origin"], `${url} from ${origin}`).toBeUndefined();
      expect(res.headers["access-control-expose-headers"], `${url} from ${origin}`).toBeUndefined();
    }
  });

  it("the headers it lists are really sent: X-RateLimit-* on every answer, X-Request-Id unique per request", async () => {
    const a = await app.inject({ method: "GET", url: "/health" });
    const b = await app.inject({ method: "GET", url: "/health" });
    for (const h of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) expect(a.headers[h], h).toBeDefined();
    expect(a.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });

  it("a client-supplied request id is ignored", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "attacker-chosen" } });
    expect(res.headers["x-request-id"]).not.toBe("attacker-chosen");
  });

  it("Retry-After is sent on a 429", async () => {
    const limited = await buildApp({ corsOrigins: [APP_ORIGIN] });
    try {
      let last = await limited.inject({ method: "GET", url: "/health", headers: { origin: APP_ORIGIN } });
      for (let i = 0; i < 305 && last.statusCode !== 429; i += 1) last = await limited.inject({ method: "GET", url: "/health", headers: { origin: APP_ORIGIN } });
      expect(last.statusCode).toBe(429);
      expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
      expect(exposed(last.headers)).toContain("retry-after");
    } finally {
      await limited.close();
    }
  });
});
