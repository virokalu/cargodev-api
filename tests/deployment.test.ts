// Deployment behaviour: graceful shutdown, the pool size, the client address modes (socket / hops / header), the database
// latency script, and the container files. Fake data only.

import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { identifierLimiter } from "../src/lib/identifier-limiter.js";
import { resetShadowLockouts } from "../src/lib/shadow-lockout.js";

vi.setConfig({ testTimeout: 30_000 }); // this file builds real apps and opens real sockets

const state = vi.hoisted(() => ({ fake: undefined as unknown, poolOptions: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));

import { buildApp } from "../src/app.js";
import { effectiveClientIpSource } from "../src/config/env.js";
import { ipFromHeader } from "../src/lib/client-ip.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { createShutdown } from "../src/lib/shutdown.js";
import { formatReport, measureLatency, percentile } from "../scripts/db-latency.js";

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:password@example.test:5432/dbname",
  MOBILE_JWT_SECRET: "mobile-secret-value-0123456789abcdefXX",
  ORG_ID: "org_x",
};
const loadEnvFresh = async (extra: Record<string, string>) => {
  vi.resetModules();
  return (await import("../src/config/env.js")).loadEnv({ ...BASE_ENV, ...extra });
};

beforeEach(() => {
  state.fake = createFakePrisma();
  resetShadowLockouts();
  identifierLimiter.reset();
});

// ---------------------------------------------------------------------------------------------

describe("settings", () => {
  it("the defaults: pool 10, shutdown 30 s, running job 20 s, client address from the socket", async () => {
    const env = await loadEnvFresh({});
    expect([env.DATABASE_POOL_MAX, env.SHUTDOWN_TIMEOUT_MS, env.SCHEDULER_SHUTDOWN_TIMEOUT_MS, env.CLIENT_IP_SOURCE]).toEqual([10, 30_000, 20_000, undefined]);
    expect(effectiveClientIpSource(env)).toBe("socket");
  });

  it("an unset source means hops when TRUST_PROXY_HOPS is above 0 (the old behaviour), and an explicit source wins", async () => {
    expect(effectiveClientIpSource(await loadEnvFresh({ TRUST_PROXY_HOPS: "1" }))).toBe("hops");
    expect(effectiveClientIpSource(await loadEnvFresh({ TRUST_PROXY_HOPS: "1", CLIENT_IP_SOURCE: "socket" }))).toBe("socket");
  });

  it.each([
    ["a pool of 0", { DATABASE_POOL_MAX: "0" }, /DATABASE_POOL_MAX/],
    ["a pool of 101", { DATABASE_POOL_MAX: "101" }, /DATABASE_POOL_MAX/],
    ["an unknown source", { CLIENT_IP_SOURCE: "forwarded" }, /CLIENT_IP_SOURCE/],
    ["header mode with no header name", { CLIENT_IP_SOURCE: "header" }, /CLIENT_IP_HEADER/],
    ["a header name with spaces or symbols", { CLIENT_IP_SOURCE: "header", CLIENT_IP_HEADER: "x forwarded; for" }, /CLIENT_IP_HEADER/],
    ["a header that is not an address", { CLIENT_IP_SOURCE: "header", CLIENT_IP_HEADER: "Authorization" }, /CLIENT_IP_HEADER/],
    ["a cookie header", { CLIENT_IP_SOURCE: "header", CLIENT_IP_HEADER: "cookie" }, /CLIENT_IP_HEADER/],
    ["hops mode with no hops", { CLIENT_IP_SOURCE: "hops" }, /TRUST_PROXY_HOPS/],
    ["a running-job wait as long as the whole shutdown", { SHUTDOWN_TIMEOUT_MS: "20000", SCHEDULER_SHUTDOWN_TIMEOUT_MS: "20000" }, /SCHEDULER_SHUTDOWN_TIMEOUT_MS/],
  ])("refuses %s, naming the variable", async (_name, extra, pattern) => {
    await expect(loadEnvFresh(extra)).rejects.toThrow(pattern);
  });

  it("accepts a header name in any case and stores it lower case", async () => {
    expect((await loadEnvFresh({ CLIENT_IP_SOURCE: "header", CLIENT_IP_HEADER: "True-Client-IP" })).CLIENT_IP_HEADER).toBe("true-client-ip");
  });
});

// ---------------------------------------------------------------------------------------------

describe("graceful shutdown", () => {
  function setup(over: Partial<{ close: () => Promise<void>; disconnect: () => Promise<void>; timeoutMs: number }> = {}) {
    const events: string[] = [];
    const exit = vi.fn((code: number) => void events.push(`exit ${code}`));
    const shutdown = createShutdown({
      close: over.close ?? (async () => void events.push("close")),
      disconnect: over.disconnect ?? (async () => void events.push("disconnect")),
      exit,
      log: { info: (_o, msg) => void events.push(`info: ${msg}`), error: (_o, msg) => void events.push(`error: ${msg}`) },
      timeoutMs: over.timeoutMs ?? 30_000,
    });
    return { events, exit, shutdown };
  }

  it("closes the server, then the database pool, then exits 0", async () => {
    const { events, shutdown } = setup();
    await shutdown("SIGTERM");
    expect(events).toEqual(["info: shutting down", "close", "disconnect", "exit 0"]);
  });

  it("a second signal does nothing", async () => {
    const { events, shutdown } = setup();
    await shutdown("SIGTERM");
    await shutdown("SIGINT");
    expect(events.filter((e) => e === "close")).toHaveLength(1);
    expect(events.filter((e) => e.startsWith("exit"))).toEqual(["exit 0"]);
  });

  it("if closing the server fails, the pool is still closed and the exit code is 1", async () => {
    const { events, shutdown } = setup({ close: async () => { throw new Error("boom"); } });
    await shutdown("SIGTERM");
    expect(events).toEqual(["info: shutting down", "error: error while closing the server", "disconnect", "exit 1"]);
  });

  it("if closing the pool fails, the exit code is 1", async () => {
    const { events, shutdown } = setup({ disconnect: async () => { throw new Error("boom"); } });
    await shutdown("SIGTERM");
    expect(events.at(-1)).toBe("exit 1");
  });

  it("a hang is cut off at the deadline: exit 1 even though close never finishes", async () => {
    vi.useFakeTimers();
    try {
      const { events, exit, shutdown } = setup({ close: () => new Promise<void>(() => undefined), timeoutMs: 30_000 });
      void shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(29_999);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(exit).toHaveBeenCalledWith(1);
      expect(events).toContain("error: shutdown did not finish in time; exiting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a finished shutdown cancels the deadline (no second exit)", async () => {
    vi.useFakeTimers();
    try {
      const { exit, shutdown } = setup();
      await shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing the real app sends `event: shutdown` to every open stream, then stops listening", async () => {
    const app = await buildApp({ rateLimit: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const token = await signAccessToken({ sub: "staff_x", orgId: "org_test_a", role: "VIEWER", name: "x", email: null });
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${address.port}/api/v1/notifications/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    let text = "";
    const reader = res.body!.getReader();
    const reading = (async () => {
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
      } catch {
        /* closed */
      }
    })();
    expect(res.status).toBe(200);
    while (!text.includes(": connected")) await new Promise((r) => setTimeout(r, 10));
    await app.close();
    await reading;
    expect(text).toContain("event: shutdown");
    controller.abort();
    expect(app.server.listening).toBe(false); // no longer accepting
  });

  it("the server file wires SIGTERM and the pool shutdown in", () => {
    const server = readFileSync("src/server.ts", "utf8");
    expect(server).toContain('process.once("SIGTERM"');
    expect(server).toContain("disconnectPrisma");
    expect(server).toContain("env.SHUTDOWN_TIMEOUT_MS");
  });
});

describe("the database pool", () => {
  it("is sized by DATABASE_POOL_MAX", async () => {
    vi.resetModules();
    vi.doUnmock("../src/lib/prisma.js");
    const captured: unknown[] = [];
    vi.doMock("@prisma/adapter-pg", () => ({ PrismaPg: class { constructor(options: unknown) { captured.push(options); } } }));
    vi.doMock("@prisma/client", () => ({ PrismaClient: class { $disconnect = vi.fn(async () => undefined); } }));
    const previous = { ...process.env };
    process.env["DATABASE_POOL_MAX"] = "7";
    try {
      const { getPrisma, disconnectPrisma } = await import("../src/lib/prisma.js");
      getPrisma();
      expect(captured[0]).toMatchObject({ max: 7 });
      await disconnectPrisma();
      await disconnectPrisma(); // twice is fine
    } finally {
      process.env = previous;
      vi.doUnmock("@prisma/adapter-pg");
      vi.doUnmock("@prisma/client");
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("client address modes", () => {
  const SOCKET_PEER = "10.0.0.1";
  const FAKE = "203.0.113.77";
  const warnings: string[] = [];
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    warnings.length = 0;
  });

  async function build(options: Parameters<typeof buildApp>[0] = {}) {
    const built = await buildApp({ rateLimit: false, onClientIpWarning: (m) => void warnings.push(m), ...options });
    built.get("/__ip", async (request) => ({ ip: request.ip }));
    app = built;
    return built;
  }
  const ipOf = async (a: FastifyInstance, headers: Record<string, string> = {}) =>
    (await a.inject({ method: "GET", url: "/__ip", remoteAddress: SOCKET_PEER, headers })).json().ip as string;

  describe("socket (the default)", () => {
    it("ignores X-Forwarded-For, True-Client-IP and every other forwarding header", async () => {
      const a = await build({ clientIp: { source: "socket" }, trustProxyHops: 1 }); // even with hops configured elsewhere, socket mode reads no header
      expect(await ipOf(a)).toBe(SOCKET_PEER);
      expect(await ipOf(a, { "x-forwarded-for": FAKE })).toBe(SOCKET_PEER);
      expect(await ipOf(a, { "true-client-ip": FAKE, "cf-connecting-ip": FAKE, forwarded: `for=${FAKE}`, "x-real-ip": FAKE })).toBe(SOCKET_PEER);
    });

    it("spoofed headers do not give a client a fresh rate-limit bucket", async () => {
      const a = await build({ rateLimit: true, clientIp: { source: "socket" } });
      const login = (spoof: string) => a.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: SOCKET_PEER, headers: { "x-forwarded-for": spoof, "true-client-ip": spoof }, payload: {} });
      const codes: number[] = [];
      for (let i = 0; i < 14; i += 1) codes.push((await login(`198.51.100.${i + 1}`)).statusCode);
      expect(codes).toContain(429);
    });
  });

  describe("hops", () => {
    it("trusts exactly the configured number of proxies and ignores the rest of the chain", async () => {
      const a = await build({ clientIp: { source: "hops" }, trustProxyHops: 1 });
      expect(await ipOf(a, { "x-forwarded-for": FAKE })).toBe(FAKE);
      // a client-supplied first entry is ignored: with one trusted proxy the LAST entry (what that proxy saw) wins
      expect(await ipOf(a, { "x-forwarded-for": `198.51.100.9, ${FAKE}` })).toBe(FAKE);
      expect(await ipOf(a)).toBe(SOCKET_PEER);
    });

    it("does not read True-Client-IP", async () => {
      const a = await build({ clientIp: { source: "hops" }, trustProxyHops: 1 });
      expect(await ipOf(a, { "true-client-ip": FAKE })).toBe(SOCKET_PEER);
    });
  });

  describe("header", () => {
    it("uses the one named header and ignores X-Forwarded-For", async () => {
      const a = await build({ clientIp: { source: "header", header: "true-client-ip" } });
      expect(await ipOf(a, { "true-client-ip": FAKE })).toBe(FAKE);
      expect(await ipOf(a, { "true-client-ip": FAKE, "x-forwarded-for": "198.51.100.5" })).toBe(FAKE);
      expect(await ipOf(a, { "x-forwarded-for": "198.51.100.5" })).toBe(SOCKET_PEER);
    });

    it("accepts IPv6, and the first entry of a comma list", async () => {
      const a = await build({ clientIp: { source: "header", header: "true-client-ip" } });
      expect(await ipOf(a, { "true-client-ip": "2001:db8::7" })).toBe("2001:db8::7");
      expect(await ipOf(a, { "true-client-ip": `${FAKE}, 198.51.100.5` })).toBe(FAKE);
    });

    it.each(["not-an-ip", "999.1.1.1", "", " ", "203.0.113.7:8080", "<script>", "fe80::1%eth0", "1.2.3.4.5"])("an invalid value (%j) falls back to the socket address", async (value) => {
      const a = await build({ clientIp: { source: "header", header: "true-client-ip" } });
      expect(await ipOf(a, { "true-client-ip": value })).toBe(SOCKET_PEER);
    });

    it("a missing or invalid header logs one masked warning a minute: the header NAME, never the value, never the address", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const a = await build({ clientIp: { source: "header", header: "true-client-ip" } });
        await ipOf(a, { "true-client-ip": "secret-looking-value-123" }); // the first warning is for a bad VALUE
        await ipOf(a);
        await ipOf(a);
        expect(warnings).toHaveLength(1); // not one per request
        expect(warnings[0]).toContain('"true-client-ip"');
        expect(warnings[0]).not.toMatch(/secret-looking|10\.0\.0\.1/);
        vi.setSystemTime(new Date(Date.now() + 61_000));
        await ipOf(a);
        expect(warnings).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rate-limit keys follow the header: different header addresses are different clients, the same address is one", async () => {
      const a = await build({ rateLimit: true, clientIp: { source: "header", header: "true-client-ip" } });
      const login = (ip: string) => a.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: SOCKET_PEER, headers: { "true-client-ip": ip }, payload: {} });
      const same: number[] = [];
      for (let i = 0; i < 14; i += 1) same.push((await login("198.51.100.1")).statusCode);
      expect(same).toContain(429);
      expect((await login("198.51.100.2")).statusCode).not.toBe(429); // a different client is not limited
    });

    it("a valid header cannot be used to log a different address than the one the limiter used", async () => {
      const a = await build({ clientIp: { source: "header", header: "cf-connecting-ip" } });
      expect(await ipOf(a, { "cf-connecting-ip": FAKE, "true-client-ip": "198.51.100.5" })).toBe(FAKE);
    });
  });

  it("ipFromHeader only returns real IP addresses", () => {
    expect(ipFromHeader(FAKE)).toBe(FAKE);
    expect(ipFromHeader([FAKE, "198.51.100.5"])).toBe(FAKE);
    expect(ipFromHeader(undefined)).toBeNull();
    expect(ipFromHeader("x".repeat(100))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("database latency script", () => {
  function fakeClient(durations: number[]) {
    const statements: string[] = [];
    let clock = 0;
    let index = 0;
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql === "SELECT 1") clock += durations[index++ % durations.length]!;
      },
    };
    return { client, statements, now: () => clock };
  }

  it("makes the session read-only first, then sends exactly 50 sequential SELECT 1", async () => {
    const { client, statements, now } = fakeClient([5]);
    const report = await measureLatency(client, 50, now);
    expect(statements[0]).toBe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    expect(statements.slice(1)).toEqual(Array(50).fill("SELECT 1"));
    expect(report).toMatchObject({ samples: 50, minMs: 5, p50Ms: 5, p95Ms: 5, maxMs: 5 });
  });

  it("computes min, p50, p95 and max (nearest rank)", async () => {
    const { client, now } = fakeClient(Array.from({ length: 50 }, (_, i) => i + 1)); // 1..50 ms
    const report = await measureLatency(client, 50, now);
    expect(report).toMatchObject({ minMs: 1, p50Ms: 25, p95Ms: 48, maxMs: 50 });
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([], 95)).toBe(0);
  });

  it("prints only numbers: no URL, host, user or password", async () => {
    const { client, now } = fakeClient([12.34]);
    const text = formatReport(await measureLatency(client, 50, now));
    expect(text).toBe(["samples 50", "min 12.3 ms", "p50 12.3 ms", "p95 12.3 ms", "max 12.3 ms"].join("\n"));
    expect(text).not.toMatch(/postgres|@|:\/\/|password/i);
  });

  it("the script reads only DATABASE_URL, only runs SELECT 1, and never prints an error object or the URL", () => {
    const source = readFileSync("scripts/db-latency.ts", "utf8").split(String.fromCharCode(10)).filter((line) => !line.trimStart().startsWith("//")).join(String.fromCharCode(10)); // code only, not the comments
    expect(source).not.toContain("MIGRATION_DATABASE_URL");
    expect(source).not.toContain("DIRECT_URL");
    // every console call prints either a fixed message or the formatted numbers, never a variable such as the URL or an error
    expect(source).not.toMatch(/console\.(?:log|error)\((?!"|formatReport\()/);
    expect([...source.matchAll(/query\("([^"]+)"\)/g)].map((m) => m[1]).sort()).toEqual(["SELECT 1", "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("container files", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const dockerignore = readFileSync(".dockerignore", "utf8");
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const lines = (text: string) => text.split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  it("is multi-stage, with a pinned Node tag (never a floating one)", () => {
    expect(lines(dockerfile).filter((l) => /^FROM /.test(l))).toHaveLength(3);
    expect(dockerfile).toMatch(/ARG NODE_IMAGE=node:\d+\.\d+\.\d+-bookworm-slim/);
    expect(lines(dockerfile).join(String.fromCharCode(10))).not.toMatch(/node:(latest|lts|\d+)(-|\s|$)/); // code only, not the comments
  });

  it("runs as the unprivileged user, in exec form, with a cheap static health check", () => {
    expect(lines(dockerfile)).toContain("USER node");
    expect(lines(dockerfile)).toContain('CMD ["node", "dist/server.js"]');
    expect(dockerfile).toContain("/health");
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(lines(dockerfile).filter((l) => l.startsWith('CMD ["node", "dist/'))).toHaveLength(1);
  });

  it("installs without running package scripts, and only production dependencies in the final stage", () => {
    const installs = lines(dockerfile).filter((l) => l.includes("npm ci"));
    expect(installs.length).toBeGreaterThan(0);
    for (const l of installs) expect(l).toContain("--ignore-scripts");
    expect(lines(dockerfile).some((l) => l.includes("npm ci --omit=dev"))).toBe(true);
  });

  it("copies no .env file and none of the excluded folders, and never the whole directory", () => {
    for (const l of lines(dockerfile).filter((x) => /^(COPY|ADD) /.test(x))) {
      expect(l).not.toMatch(/\.env|tests|docs|\.git|known-issues|private/);
      expect(l).not.toMatch(/^(COPY|ADD) \. /);
    }
  });

  it(".dockerignore keeps every .env variant, tests, docs, dumps and private notes out", () => {
    const entries = lines(dockerignore);
    for (const must of [".env", ".env.*", "**/.env", "**/.env.*", "tests", "docs", "*.sql", "*.dump", "private", "known-issues*", "node_modules", ".git"]) {
      expect(entries, must).toContain(must);
    }
  });

  it("CI builds the image, fails on any .env file, checks the user, and audits production dependencies", () => {
    expect(ci).toContain("docker build");
    expect(ci).toMatch(/find \/ -xdev .*-name ".env"/);
    expect(ci).toContain("npm audit --omit=dev --audit-level=high");
    expect(ci).toMatch(/--entrypoint id .* -u/);
  });

  it("the build compiles only src to dist, and the start script runs the compiled file", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const build = JSON.parse(lines(readFileSync("tsconfig.build.json", "utf8")).filter((l) => !l.startsWith("//")).join("")) as { include: string[]; compilerOptions: { outDir: string; rootDir: string } };
    expect(build.include).toEqual(["src"]);
    expect([build.compilerOptions.rootDir, build.compilerOptions.outDir]).toEqual(["src", "dist"]);
    expect(pkg.scripts["build"]).toBe("tsc -p tsconfig.build.json");
    expect(pkg.scripts["start:prod"]).toBe("node dist/server.js");
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\/dist$/m);
  });
});
