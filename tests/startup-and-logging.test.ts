// Production start-up rules, the client-address warning in socket mode, what a request log line may contain, and the image
// library being optional. Real log output is captured; nothing is mocked in the logger. Fake data only.

import { Readable, Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A } from "./helpers/fixtures.js";
import { newVehicleFake, vehicleRow } from "./helpers/vehicle-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), R2_PUBLIC_URL: "https://files.example.test" }) };
});

import { buildApp } from "../src/app.js";
import { FORWARDING_HEADERS } from "../src/lib/client-ip.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { setObjectStore, type ObjectStore } from "../src/lib/object-storage.js";

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:password@example.test:5432/dbname",
  MOBILE_JWT_SECRET: "mobile-secret-value-0123456789abcdefXX",
  ORG_ID: "org_x",
  FILE_LINK_SECRET: "link-secret-value-for-tests-0123456789abcdef",
  FILE_LINK_BASE_URL: "https://api.example.test",
};
const loadEnvFresh = async (extra: Record<string, string>) => {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
  return actual.loadEnv({ ...BASE_ENV, ...extra });
};

beforeEach(() => {
  state.fake = createFakePrisma();
});

// ---------------------------------------------------------------------------------------------

describe("production must choose where the client address comes from", () => {
  it("refuses to start in production without CLIENT_IP_SOURCE, naming the variable", async () => {
    await expect(loadEnvFresh({ NODE_ENV: "production" })).rejects.toThrow(/CLIENT_IP_SOURCE/);
    await expect(loadEnvFresh({ NODE_ENV: "production", TRUST_PROXY_HOPS: "1" })).rejects.toThrow(/CLIENT_IP_SOURCE/); // the old implicit hops is no longer enough
  });

  it.each([
    ["socket", {}],
    ["hops", { TRUST_PROXY_HOPS: "1" }],
    ["header", { CLIENT_IP_HEADER: "true-client-ip" }],
  ])("starts in production with CLIENT_IP_SOURCE=%s", async (source, extra) => {
    expect((await loadEnvFresh({ NODE_ENV: "production", CLIENT_IP_SOURCE: source, ...extra })).CLIENT_IP_SOURCE).toBe(source);
  });

  it("is still a silent default outside production (development and tests)", async () => {
    expect((await loadEnvFresh({ NODE_ENV: "development" })).CLIENT_IP_SOURCE).toBeUndefined();
    expect((await loadEnvFresh({ NODE_ENV: "test" })).CLIENT_IP_SOURCE).toBeUndefined();
  });

  it("an empty value counts as not set", async () => {
    await expect(loadEnvFresh({ NODE_ENV: "production", CLIENT_IP_SOURCE: "" })).rejects.toThrow(/CLIENT_IP_SOURCE/);
  });

  it("the error names the variable and never prints a secret", async () => {
    const message = await loadEnvFresh({ NODE_ENV: "production" }).then(() => "", (e: Error) => e.message);
    expect(message).toContain("CLIENT_IP_SOURCE");
    expect(message).not.toContain(BASE_ENV.MOBILE_JWT_SECRET);
  });
});

describe("socket mode warns, once a minute, when forwarding headers are seen", () => {
  const warnings: string[] = [];
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    warnings.length = 0;
    vi.useRealTimers();
  });
  const build = async (source: "socket" | "hops" | "header") => {
    app = await buildApp({
      rateLimit: false,
      clientIp: { source, ...(source === "header" ? { header: "true-client-ip" } : {}) },
      ...(source === "hops" ? { trustProxyHops: 1 } : {}),
      onClientIpWarning: (m) => void warnings.push(m),
    });
    return app;
  };
  const hit = (a: FastifyInstance, headers: Record<string, string> = {}) => a.inject({ method: "GET", url: "/health", remoteAddress: "10.0.0.1", headers });

  it("warns once for a burst, names only the header names, and never the value or the address", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = await build("socket");
    await hit(a, { "x-forwarded-for": "198.51.100.77", "true-client-ip": "198.51.100.78" });
    await hit(a, { "x-forwarded-for": "198.51.100.79" });
    await hit(a, { "x-real-ip": "198.51.100.80" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("x-forwarded-for, true-client-ip");
    expect(warnings[0]).toContain("CLIENT_IP_SOURCE");
    expect(warnings[0]).not.toMatch(/198\.51\.100|10\.0\.0\.1/);
  });

  it("warns again after a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = await build("socket");
    await hit(a, { "x-forwarded-for": "198.51.100.1" });
    vi.setSystemTime(new Date(Date.now() + 59_000));
    await hit(a, { "x-forwarded-for": "198.51.100.1" });
    expect(warnings).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 2_000));
    await hit(a, { "x-forwarded-for": "198.51.100.1" });
    expect(warnings).toHaveLength(2);
  });

  it("watches exactly the headers a proxy or edge is known to use", () => {
    expect([...FORWARDING_HEADERS].sort()).toEqual(["cf-connecting-ip", "forwarded", "true-client-ip", "x-client-ip", "x-forwarded-for", "x-real-ip"]);
  });

  it("watches exactly the headers a proxy or edge is known to use", () => {
    expect([...FORWARDING_HEADERS].sort()).toEqual(["cf-connecting-ip", "forwarded", "true-client-ip", "x-client-ip", "x-forwarded-for", "x-real-ip"]);
  });

  it.each(FORWARDING_HEADERS)("notices %s", async (header) => {
    const a = await build("socket");
    await hit(a, { [header]: "198.51.100.1" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(header);
  });

  it("says nothing when no forwarding header is present", async () => {
    const a = await build("socket");
    await hit(a);
    await hit(a, { "user-agent": "test", accept: "application/json" });
    expect(warnings).toHaveLength(0);
  });

  it("says nothing in hops and header modes (the operator chose them on purpose)", async () => {
    const hops = await build("hops");
    await hit(hops, { "x-forwarded-for": "198.51.100.1" });
    await hops.close();
    const header = await build("header");
    await hit(header, { "true-client-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2" });
    expect(warnings.filter((w) => w.includes("while CLIENT_IP_SOURCE is socket"))).toHaveLength(0);
  });

  it("the warning does not change the address in use: socket mode still uses the socket", async () => {
    const a = await build("socket");
    a.get("/__ip", async (request) => ({ ip: request.ip }));
    const res = await a.inject({ method: "GET", url: "/__ip", remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": "198.51.100.1" } });
    expect(res.json().ip).toBe("10.0.0.1");
  });
});

// ---------------------------------------------------------------------------------------------

describe("what a request log line may contain", () => {
  const lines: string[] = [];
  let app: FastifyInstance;
  const staff = async () => ({ authorization: `Bearer ${await signAccessToken({ sub: "staff_log", orgId: ORG_A, role: "ADMINISTRATOR", name: "Log Admin", email: null })}` });

  beforeEach(async () => {
    lines.length = 0;
    state.fake = newVehicleFake();
    (state.fake as FakePrisma).seed("user", { id: "staff_log", org_id: ORG_A, userType: "STAFF", name: "Log Admin", role: "ADMINISTRATOR", loginEnabled: true });
    app = await buildApp({
      rateLimit: false,
      logger: true,
      logStream: new Writable({ write(chunk, _e, done) { lines.push(chunk.toString()); done(); } }),
    });
  });
  afterEach(async () => {
    await app.close();
  });
  const parsed = () => lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

  it("logs the method, the route PATTERN, the status, the duration and the request id: no query string, no raw URL", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/customers/search?q=SECRET-CUSTOMER-NAME&token=SECRET-TOKEN-VALUE", headers: await staff() });
    expect(res.statusCode).toBe(200);
    const text = lines.join("");
    expect(text).not.toMatch(/SECRET-CUSTOMER-NAME|SECRET-TOKEN-VALUE|q=|token=/);

    const records = parsed();
    const incoming = records.find((r) => (r["req"] as { route?: string } | undefined)?.route !== undefined)!;
    expect(incoming["req"]).toEqual({ method: "GET", route: "/api/v1/customers/search" });
    expect(Object.keys(incoming["req"] as object).sort()).toEqual(["method", "route"]); // no url, host, remoteAddress, remotePort
    const done = records.find((r) => (r["res"] as { statusCode?: number } | undefined)?.statusCode !== undefined)!;
    expect(done["res"]).toEqual({ statusCode: 200 });
    expect(typeof done["responseTime"]).toBe("number");
    expect(typeof done["reqId"]).toBe("string");
  });

  it("logs a path parameter as its pattern, never its value (serials, ids, slugs)", async () => {
    await app.inject({ method: "GET", url: "/api/v1/vehicles/FC101-SECRET-SERIAL/files", headers: await staff() });
    const text = lines.join("");
    expect(text).toContain("/api/v1/vehicles/:serial/files");
    expect(text).not.toContain("FC101-SECRET-SERIAL");
  });

  it("an unmatched URL is logged as 'no matching route', never as itself", async () => {
    await app.inject({ method: "GET", url: "/definitely/not/a/route?secret=SECRET-QUERY-VALUE" });
    const text = lines.join("");
    expect(text).toContain("(no matching route)");
    expect(text).not.toMatch(/definitely|SECRET-QUERY-VALUE/);
  });

  it("never logs the client address, the host, a header or the Authorization value", async () => {
    const headers = { ...(await staff()), cookie: "session=SECRET-COOKIE-VALUE", "x-forwarded-for": "198.51.100.9" };
    await app.inject({ method: "GET", url: "/health", remoteAddress: "203.0.113.5", headers });
    const text = lines.join("");
    expect(text).not.toMatch(/203\.0\.113\.5|198\.51\.100\.9|SECRET-COOKIE-VALUE|Bearer|eyJ|remoteAddress|remotePort|"host"/);
  });

  it("the public API's search text and a failed sign-in's address stay out too", async () => {
    await app.inject({ method: "GET", url: "/api/public/stock?q=SECRET-SEARCH-TEXT" });
    await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "someone@example.test", password: "SECRET-example-value" } });
    expect(lines.join("")).not.toMatch(/SECRET-SEARCH-TEXT|SECRET-example-value|someone@example/);
  });

  it("an unexpected error is still logged (redacted), under the same request id, without the URL", async () => {
    app.get("/__boom", async () => {
      throw new Error("failed with $2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456 in it");
    });
    const res = await app.inject({ method: "GET", url: "/__boom?private=SECRET-QUERY-VALUE" });
    expect(res.statusCode).toBe(500);
    const text = lines.join("");
    expect(text).toContain("unexpected error");
    expect(text).not.toMatch(/\$2b\$10\$abc|SECRET-QUERY-VALUE/); // hashes stay redacted
    const ids = new Set(parsed().map((r) => r["reqId"]));
    expect(ids.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the image library is optional", () => {
  const KEY = `org/${ORG_A}/vehicles/v_cust/photos/22222222-2222-2222-2222-222222222222-front.jpg`;
  const BASE = "https://files.example.test";
  const objects = new Map<string, Buffer>();
  const puts: string[] = [];
  const gets: string[] = [];
  const store: ObjectStore = {
    presignPut: async () => "https://upload.example.test/x",
    getObject: async ({ key }) => {
      gets.push(key);
      const body = objects.get(key);
      return body ? { kind: "found", body: Readable.from([body]), contentLength: body.length, etag: '"e"' } : { kind: "missing" };
    },
    putObject: async ({ key, body }) => void (puts.push(key), objects.set(key, body)),
    deleteKey: async () => undefined,
  };
  const errors: string[] = [];

  beforeEach(async () => {
    objects.clear();
    puts.length = 0;
    gets.length = 0;
    errors.length = 0;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(" ")));
    vi.resetModules();
    (await import("../src/lib/object-storage.js")).setObjectStore(store); // the module instance the tests below will import
    // A native binary that cannot be loaded here, with a message that contains a path.
    vi.doMock("sharp", () => {
      throw new Error("Could not load the sharp module using the linux-x64 runtime: /home/secret-user/app/node_modules/@img/sharp-linux-x64/sharp.node");
    });
  });
  afterEach(() => {
    vi.doUnmock("sharp");
    vi.resetModules();
    setObjectStore(null);
    vi.restoreAllMocks();
  });

  it("the API still starts and answers when the library cannot be loaded", async () => {
    const fresh = await import("../src/app.js");
    const built = await fresh.buildApp({ rateLimit: false });
    expect((await built.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await built.close();
  });

  it("makeThumbnail reports 'unavailable' (not a crash), and logs ONE masked error however many photos follow", async () => {
    const { makeThumbnail, ThumbnailUnavailableError, resetSharpForTests } = await import("../src/lib/thumbnail.js");
    resetSharpForTests();
    for (let i = 0; i < 5; i += 1) await expect(makeThumbnail(Buffer.from("x"), "image/jpeg")).rejects.toBeInstanceOf(ThumbnailUnavailableError);
    expect(errors).toEqual(["image library (sharp) could not be loaded; thumbnails are disabled and photos are served in full"]);
    expect(errors.join("")).not.toMatch(/secret-user|node_modules|linux-x64|sharp\.node/);
  });

  it("adding a photo still succeeds: no thumbnail is made, nothing is written, and no per-photo error is logged", async () => {
    const { createPhotoThumbnail } = await import("../src/services/photo-thumbnail.service.js");
    const { resetSharpForTests } = await import("../src/lib/thumbnail.js");
    resetSharpForTests();
    objects.set(KEY, Buffer.from("not-really-an-image"));
    expect(await createPhotoThumbnail(ORG_A, `${BASE}/${KEY}`)).toBe(false);
    expect(await createPhotoThumbnail(ORG_A, `${BASE}/${KEY}`)).toBe(false);
    expect(puts).toEqual([]);
    expect(errors.filter((e) => e.includes("thumbnail not created"))).toEqual([]);
    expect(errors).toHaveLength(1); // the single masked report
  });

  it("a customer asking for the thumb gets the FULL image instead of an error", async () => {
    const fake = newVehicleFake();
    state.fake = fake;
    fake.seed("vehicle", vehicleRow({ id: "v_cust", org_id: ORG_A, serial: "FC900", modelId: "model_a1", customerId: "cust_a1", customerVisible: true }));
    fake.seed("vehiclePhoto", { id: "ph_t", vehicleId: "v_cust", url: `${BASE}/${KEY}`, visibleToCustomer: true, uploadedById: "staff_a1" });
    const full = Buffer.from("the-full-image-bytes");
    objects.set(KEY, full);
    const { createPhotoThumbnail } = await import("../src/services/photo-thumbnail.service.js");
    await createPhotoThumbnail(ORG_A, `${BASE}/${KEY}`); // cannot make one
    const { openCustomerFile } = await import("../src/services/customer-file-access.service.js");
    const opened = await openCustomerFile({ id: "cust_a1", orgId: ORG_A }, "photo", "ph_t", { size: "thumb" });
    expect(opened.status).toBe(200);
    expect(gets).toContain(KEY.replace("/photos/", "/photos-thumb/")); // it looked for the small one first...
    expect(gets.at(-1)).toBe(KEY); // ...and served the full one
    if (opened.status === 200) {
      const chunks: Buffer[] = [];
      for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).equals(full)).toBe(true);
    }
  });
});
