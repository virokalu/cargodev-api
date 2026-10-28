// Staff read path for stored files once the main bucket is private: short-lived signed links built from the SAME validated key
// derivation the customer gateway uses, redaction of signed-link secrets in logs and errors, and the read-only r2:audit script.
// The store here only signs and records; no real bucket is ever contacted. Fake data only.

import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";
import { bearerFor, newCustomerFake } from "./helpers/customer-fixtures.js";
import { newVehicleFake, vehicleRow } from "./helpers/vehicle-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const BASE = "https://files.example.test";
const state = vi.hoisted(() => ({ fake: undefined as unknown, base: "https://files.example.test" as string | undefined, ttl: 600 }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), R2_PUBLIC_URL: state.base, STAFF_SIGNED_URL_TTL_SECONDS: state.ttl }) };
});

import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { setObjectStore, signStaffFileUrl, type ObjectStore } from "../src/lib/object-storage.js";
import { redactSecrets, safeError } from "../src/lib/redact.js";
import { countObjectsByPrefix, countUrlRows, formatAudit, likePrefix, type QueryClient } from "../scripts/r2-audit.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const ROLES: Role[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR", "VIEWER"];

// ---- a store that only signs and records
const signed: { key: string; contentType: string; expiresInSeconds: number }[] = [];
const SECRET_PARTS = { signature: "abcdef0123456789SIGNATURE", credential: "AKIAEXAMPLEKEY%2F20261028%2Fauto%2Fs3%2Faws4_request", session: "EXAMPLE-SESSION-VALUE-123" };
const signedLinkFor = (key: string, ttl: number) =>
  `https://acct.r2.example.test/bucket/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${SECRET_PARTS.credential}&X-Amz-Expires=${ttl}&X-Amz-Security-Token=${SECRET_PARTS.session}&X-Amz-Signature=${SECRET_PARTS.signature}`;
let presignGetFails = false;
let deleteFails = false;
const uploadedKeys = new Set<string>();
const store: ObjectStore = {
  presignGet: async (args) => {
    signed.push(args);
    if (presignGetFails) throw new Error(`could not sign ${signedLinkFor(args.key, args.expiresInSeconds)}`);
    return signedLinkFor(args.key, args.expiresInSeconds);
  },
  presignPut: async () => "https://upload.example.test/x",
  // Registering a file checks that its object exists; only the keys listed here have been "uploaded".
  getObject: async ({ key }) =>
    uploadedKeys.has(key) ? { kind: "found", body: Readable.from([Buffer.from("x")]), contentLength: 10, etag: null } : { kind: "missing" },
  putObject: async () => undefined,
  deleteKey: async (key) => {
    if (deleteFails) throw new Error(`delete failed for ${signedLinkFor(key, 600)}`);
  },
};

let app: FastifyInstance;
let fake: FakePrisma;
const consoleLines: string[] = [];

const staffHeaders = async (role: Role, orgId = ORG_A) => ({
  authorization: `Bearer ${await signAccessToken({ sub: "staff_a1", orgId, role, name: `Test ${role}`, email: null })}`,
});
const get = async (url: string, role: Role | null = "VIEWER", orgId = ORG_A) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers: role ? await staffHeaders(role, orgId) : {} });

const KEY = (name: string, kind = "photos") => `org/${ORG_A}/vehicles/v_fc_pending/${kind}/${name}`;
const URL_OF = (key: string) => `${BASE}/${key}`;

beforeEach(async () => {
  fake = newVehicleFake();
  for (const r of newCustomerFake().rows("user")) {
    const existing = fake.rows("user").find((u) => u["id"] === r["id"]);
    if (existing) Object.assign(existing, r);
    else fake.seed("user", r);
  }
  state.fake = fake;
  state.base = BASE;
  state.ttl = 600;
  signed.length = 0;
  presignGetFails = false;
  deleteFails = false;
  consoleLines.length = 0;
  setObjectStore(store);
  for (const method of ["warn", "error", "log", "info"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleLines.push(args.map(String).join(" ")));
  fake.seed("user", { id: "uploader", org_id: ORG_A, userType: "STAFF", name: "Uploader", role: "OPERATOR", loginEnabled: true });
  fake.seed("vehiclePhoto", { id: "ph1", vehicleId: "v_fc_pending", url: URL_OF(KEY("a.jpg")), createdAt: new Date(2026, 0, 2), uploadedById: "uploader" });
  fake.seed("vehicleDocument", { id: "dc1", vehicleId: "v_fc_pending", url: URL_OF(KEY("d.pdf", "documents")), name: "d.pdf", documentType: "OTHER", createdAt: new Date(2026, 0, 3), uploadedById: "uploader" });
  Object.assign(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!, { auctionSheetUrl: URL_OF(KEY("s.jpg", "auction-sheet")) });
  fake.seed("vehicle", vehicleRow({ id: "v_b_only", org_id: ORG_B, serial: "FC777", chassisNo: "CHASSIS-B-777", modelId: "model_b1" }));
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await app.close();
  setObjectStore(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe("STAFF_SIGNED_URL_TTL_SECONDS", () => {
  const base = { DATABASE_URL: "postgresql://user:password@example.test:5432/dbname", MOBILE_JWT_SECRET: "mobile-secret-value-0123456789abcdefXX", ORG_ID: "org_x" };
  const load = async (extra: Record<string, string>) => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    return actual.loadEnv({ ...base, ...extra });
  };
  it("defaults to 600, and accepts 60 to 900", async () => {
    expect((await load({})).STAFF_SIGNED_URL_TTL_SECONDS).toBe(600);
    expect((await load({ STAFF_SIGNED_URL_TTL_SECONDS: "60" })).STAFF_SIGNED_URL_TTL_SECONDS).toBe(60);
    expect((await load({ STAFF_SIGNED_URL_TTL_SECONDS: "900" })).STAFF_SIGNED_URL_TTL_SECONDS).toBe(900);
  });
  it.each(["59", "901", "0", "-5", "ten", "600.5"])("refuses %s, naming the variable", async (value) => {
    await expect(load({ STAFF_SIGNED_URL_TTL_SECONDS: value })).rejects.toThrow(/STAFF_SIGNED_URL_TTL_SECONDS/);
  });
});

describe("signStaffFileUrl: the key comes from the same validated function the customer gateway uses", () => {
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

  it("signs a stored address inside the caller's org folder: a GET for exactly that key, with the TTL and a pinned type", async () => {
    const result = await signStaffFileUrl(ORG_A, URL_OF(KEY("a.jpg")), NOW);
    expect(result).not.toBeNull();
    expect(result!.url).toContain("X-Amz-Expires=600");
    expect(result!.expiresAt).toBe(new Date(NOW + 600_000).toISOString());
    expect(signed).toEqual([{ key: KEY("a.jpg"), contentType: "image/jpeg", expiresInSeconds: 600 }]);
  });

  it("the TTL follows the setting", async () => {
    state.ttl = 120;
    const result = await signStaffFileUrl(ORG_A, URL_OF(KEY("a.jpg")), NOW);
    expect(result!.url).toContain("X-Amz-Expires=120");
    expect(signed[0]!.expiresInSeconds).toBe(120);
    expect(result!.expiresAt).toBe(new Date(NOW + 120_000).toISOString());
  });

  it.each([
    ["another org's folder", URL_OF(`org/${ORG_B}/vehicles/v_b_fc/photos/a.jpg`)],
    ["a prefix of this org's id", URL_OF(`org/${ORG_A}x/vehicles/v/photos/a.jpg`)],
    ["a different host", `https://evil.test/${KEY("a.jpg")}`],
    // same length as the real host and scheme, so only an actual host comparison can tell them apart
    ["a different host of the SAME length", `https://other.example.test/${KEY("a.jpg")}`],
    ["a different scheme of the SAME length", `httpx://files.example.test/${KEY("a.jpg")}`],
    ["a different host with the same length and a look-alike label", `https://files.exampl3.test/${KEY("a.jpg")}`],
    ["the public host as a subdomain", `https://files.example.test.evil.test/${KEY("a.jpg")}`],
    ["credentials in the address", `https://files.example.test@evil.test/${KEY("a.jpg")}`],
    ["the plain http scheme", `http://files.example.test/${KEY("a.jpg")}`],
    ["a path traversal", URL_OF(`org/${ORG_A}/vehicles/../../${ORG_B}/vehicles/x/photos/a.jpg`)],
    ["a query string", `${URL_OF(KEY("a.jpg"))}?X-Amz-Signature=x`],
    ["a fragment", `${URL_OF(KEY("a.jpg"))}#x`],
    ["an encoded slash", URL_OF(`org/${ORG_A}/vehicles/v%2f..%2fx/photos/a.jpg`)],
    ["an svg", URL_OF(KEY("a.svg"))],
    ["an html file", URL_OF(KEY("a.html"))],
    ["no extension", URL_OF(KEY("a"))],
    ["an empty key", `${BASE}/`],
    ["a signed link of the storage host itself", signedLinkFor(KEY("a.jpg"), 600)],
    ["nothing", ""],
  ])("refuses %s (null, and nothing is signed)", async (_name, address) => {
    expect(await signStaffFileUrl(ORG_A, address)).toBeNull();
    expect(signed).toHaveLength(0);
  });

  it("refuses everything when no public base is configured (fails closed), and when no store is installed", async () => {
    state.base = undefined;
    expect(await signStaffFileUrl(ORG_A, URL_OF(KEY("a.jpg")))).toBeNull();
    state.base = BASE;
    setObjectStore(null);
    expect(await signStaffFileUrl(ORG_A, URL_OF(KEY("a.jpg")))).toBeNull();
    expect(signed).toHaveLength(0);
  });

  it("a signing failure is null, not a thrown error carrying the library's message", async () => {
    presignGetFails = true;
    expect(await signStaffFileUrl(ORG_A, URL_OF(KEY("a.jpg")))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("GET /vehicles/:serial/files", () => {
  it("is 401 without a token and with a customer token", async () => {
    expect((await get("/vehicles/FC101/files", null)).statusCode).toBe(401);
    const asCustomer = await app.inject({ method: "GET", url: "/api/v1/vehicles/FC101/files", headers: await bearerFor("cust_a1") });
    expect(asCustomer.statusCode).toBe(401);
  });

  it.each(ROLES)("is open to every staff role (%s), like the route's role list", async (role) => {
    expect((await get("/vehicles/FC101/files", role)).statusCode).toBe(200);
  });

  it("is 404 for another org's vehicle and for an unknown one, and signs nothing", async () => {
    expect((await get("/vehicles/FC777/files", "ADMINISTRATOR")).statusCode).toBe(404); // exists only in org B
    expect((await get("/vehicles/FC777/files", "ADMINISTRATOR", ORG_B)).statusCode).toBe(200); // visible to its own org
    signed.length = 0;
    expect((await get("/vehicles/NOPE/files", "ADMINISTRATOR")).statusCode).toBe(404);
    expect(signed).toHaveLength(0);
  });

  it("returns signed links in `url` with `expiresAt`, never the stored address, and exactly these keys", async () => {
    const res = await get("/vehicles/FC101/files", "MANAGER");
    const data = res.json().data;
    expect(Object.keys(data).sort()).toEqual(["auctionSheetExpiresAt", "auctionSheetUrl", "documents", "photos"]);
    expect(Object.keys(data.photos[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "uploaderName", "url"]);
    expect(Object.keys(data.documents[0]).sort()).toEqual(["createdAt", "documentType", "expiresAt", "id", "name", "uploaderName", "url"]);
    expect(data.photos[0].url).toBe(signedLinkFor(KEY("a.jpg"), 600));
    expect(data.documents[0].url).toBe(signedLinkFor(KEY("d.pdf", "documents"), 600));
    expect(data.auctionSheetUrl).toBe(signedLinkFor(KEY("s.jpg", "auction-sheet"), 600));
    for (const iso of [data.photos[0].expiresAt, data.documents[0].expiresAt, data.auctionSheetExpiresAt]) {
      const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
      expect(seconds).toBeGreaterThan(590);
      expect(seconds).toBeLessThanOrEqual(600);
    }
    expect(res.body).not.toContain(BASE); // the stored (public) address is nowhere in the answer
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("the expiry parameter follows the setting", async () => {
    state.ttl = 300;
    const data = (await get("/vehicles/FC101/files", "MANAGER")).json().data;
    expect(data.photos[0].url).toContain("X-Amz-Expires=300");
    expect(signed.every((s) => s.expiresInSeconds === 300)).toBe(true);
  });

  it("a row whose address cannot be mapped is `url: null, unavailable: true`, and only a masked COUNT is logged", async () => {
    fake.seed("vehiclePhoto", { id: "ph_bad", vehicleId: "v_fc_pending", url: `https://evil.test/${KEY("x.jpg")}`, createdAt: new Date(2026, 0, 1), uploadedById: "uploader" });
    fake.seed("vehicleDocument", { id: "dc_other_org", vehicleId: "v_fc_pending", url: URL_OF(`org/${ORG_B}/vehicles/v_b_fc/documents/x.pdf`), name: "x.pdf", documentType: "OTHER", createdAt: new Date(2026, 0, 1), uploadedById: "uploader" });
    const data = (await get("/vehicles/FC101/files", "MANAGER")).json().data;
    const bad = data.photos.find((p: { id: string }) => p.id === "ph_bad");
    expect(bad).toMatchObject({ url: null, expiresAt: null, unavailable: true });
    expect(Object.keys(bad).sort()).toEqual(["createdAt", "expiresAt", "id", "unavailable", "uploaderName", "url"]);
    expect(data.documents.find((d: { id: string }) => d.id === "dc_other_org")).toMatchObject({ url: null, unavailable: true });
    // the good rows are unaffected, and the foreign key was never signed
    expect(data.photos.find((p: { id: string }) => p.id === "ph1").url).toContain("X-Amz-Signature");
    expect(signed.map((s) => s.key)).not.toContain(`org/${ORG_B}/vehicles/v_b_fc/documents/x.pdf`);
    const warning = consoleLines.filter((l) => l.includes("could not be signed"));
    expect(warning).toEqual(["staff file links: 2 stored file address(es) could not be signed"]);
    expect(consoleLines.join("\n")).not.toMatch(/evil\.test|v_b_fc|ph_bad|dc_other_org|files\.example\.test/);
  });

  it("an unmappable auction sheet is flagged, and a vehicle with no auction sheet has no flag", async () => {
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!, { auctionSheetUrl: "http://10.0.0.5/admin" });
    expect((await get("/vehicles/FC101/files", "MANAGER")).json().data).toMatchObject({ auctionSheetUrl: null, auctionSheetExpiresAt: null, auctionSheetUnavailable: true });
    Object.assign(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!, { auctionSheetUrl: null });
    const none = (await get("/vehicles/FC101/files", "MANAGER")).json().data;
    expect(none).toMatchObject({ auctionSheetUrl: null, auctionSheetExpiresAt: null });
    expect(none).not.toHaveProperty("auctionSheetUnavailable");
  });

  it("when signing fails every row is unavailable, the answer is still 200, and no signed link or secret is logged", async () => {
    presignGetFails = true;
    const res = await get("/vehicles/FC101/files", "MANAGER");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.photos[0]).toMatchObject({ url: null, unavailable: true });
    const everything = `${res.body}\n${consoleLines.join("\n")}`;
    for (const secret of Object.values(SECRET_PARTS)) expect(everything).not.toContain(secret);
  });
});

describe("responses that return a file after a change carry a signed link too", () => {
  it("adding a photo, a document, and setting the auction sheet return signed links and never the stored address", async () => {
    const headers = await staffHeaders("MANAGER");
    const photoKey = KEY("new.jpg");
    for (const key of [photoKey, KEY("new.pdf", "documents"), KEY("new-sheet.jpg", "auction-sheet")]) uploadedKeys.add(key);
    const photo = await app.inject({ method: "POST", url: "/api/v1/vehicles/v_fc_pending/photos", headers, payload: { key: photoKey } });
    expect(photo.statusCode).toBe(201);
    expect(photo.json().data).toMatchObject({ url: signedLinkFor(photoKey, 600), expiresAt: expect.any(String) });
    expect(photo.body).not.toContain(BASE);

    const documentKey = KEY("new.pdf", "documents");
    const doc = await app.inject({ method: "POST", url: "/api/v1/vehicles/v_fc_pending/documents", headers, payload: { key: documentKey, name: "new.pdf", documentType: "OTHER" } });
    expect(doc.statusCode).toBe(201);
    expect(doc.json().data.url).toBe(signedLinkFor(documentKey, 600));

    const sheetKey = KEY("new-sheet.jpg", "auction-sheet");
    const sheet = await app.inject({ method: "PUT", url: "/api/v1/vehicles/v_fc_pending/auction-sheet", headers, payload: { key: sheetKey } });
    expect(sheet.json().data).toEqual({ auctionSheetUrl: signedLinkFor(sheetKey, 600), auctionSheetExpiresAt: expect.any(String) });
    expect(fake.rows("vehicle").find((v) => v["id"] === "v_fc_pending")!["auctionSheetUrl"]).toBe(URL_OF(sheetKey)); // stored form is unchanged
  });
});

describe("GET /vehicles/:serial/pdf-images", () => {
  it("fetches the SIGNED link (never the public address), and skips an address outside the org", async () => {
    fake.seed("vehiclePhoto", { id: "ph_foreign", vehicleId: "v_fc_pending", url: URL_OF(`org/${ORG_B}/vehicles/v_b_fc/photos/z.jpg`), createdAt: new Date(2026, 0, 1), uploadedById: "uploader" });
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        return new Response(Buffer.from("abc"), { status: 200, headers: { "content-type": "image/png" } });
      })
    );
    try {
      const res = await get("/vehicles/FC101/pdf-images", "VIEWER");
      expect(res.statusCode).toBe(200);
      expect(res.json().data.photoDataUrls).toHaveLength(1);
      expect(requested.length).toBe(2); // the photo and the auction sheet
      expect(requested.every((u) => u.startsWith("https://acct.r2.example.test/bucket/org/") && u.includes("X-Amz-Signature="))).toBe(true);
      expect(requested.some((u) => u.includes(BASE) || u.includes(ORG_B))).toBe(false);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).not.toContain("X-Amz-");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is 401 without a token, and 404 for another org's vehicle", async () => {
    expect((await get("/vehicles/FC101/pdf-images", null)).statusCode).toBe(401);
    expect((await get("/vehicles/FC777/pdf-images", "ADMINISTRATOR")).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------

describe("signed-link secrets never reach a log or an error", () => {
  const link = signedLinkFor(KEY("a.jpg"), 600);
  const hasNoSecret = (text: string) => {
    for (const secret of Object.values(SECRET_PARTS)) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/X-Amz-(Signature|Credential|Security-Token)=[^[]/i);
  };

  it("the redactor strips the signature, the credential and the session token wherever they appear", () => {
    const text = redactSecrets(`GET ${link} failed; again x-amz-signature=${SECRET_PARTS.signature}&X-AMZ-CREDENTIAL=${SECRET_PARTS.credential} end`);
    hasNoSecret(text);
    expect(text).toContain("[redacted]");
    expect(text).toContain("failed; again");
    expect(redactSecrets("a normal sentence")).toBe("a normal sentence");
    // the other parameters are not secrets and may stay
    expect(redactSecrets("X-Amz-Expires=600&X-Amz-Signature=abc")).toBe("X-Amz-Expires=600&[redacted]");
  });

  it("safeError redacts the message AND the stack", () => {
    const error = new Error(`boom ${link}`);
    const safe = safeError(error);
    hasNoSecret(`${safe.message}\n${safe.stack ?? ""}`);
  });

  it("REAL log output: an unexpected error that carries a signed link is logged without the secrets", async () => {
    const lines: string[] = [];
    const noisy = await buildApp({ rateLimit: false, logger: true, logStream: new Writable({ write(chunk, _e, done) { lines.push(chunk.toString()); done(); } }) });
    noisy.get("/__boom", async () => {
      throw new Error(`the storage library said: ${link}`);
    });
    try {
      const res = await noisy.inject({ method: "GET", url: "/__boom" });
      expect(res.statusCode).toBe(500);
      hasNoSecret(res.body);
      const logged = lines.join("");
      expect(logged).toContain("unexpected error"); // the error WAS logged...
      hasNoSecret(logged); // ...without the secrets
    } finally {
      await noisy.close();
    }
  });

  it("REAL console output: a failed delete whose error carries a signed link is logged without the secrets", async () => {
    deleteFails = true;
    const res = await app.inject({ method: "DELETE", url: "/api/v1/vehicles/v_fc_pending/photos/ph1", headers: await staffHeaders("MANAGER") });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    const logged = consoleLines.join("\n");
    expect(logged).toContain("object delete failed");
    hasNoSecret(logged);
  });
});

// ---------------------------------------------------------------------------------------------

describe("npm run r2:audit (read-only)", () => {
  function fakeLister(pages: string[][]) {
    return async (token?: string) => {
      const index = token ? Number(token) : 0;
      const keys = pages[index] ?? [];
      return { keys, ...(index + 1 < pages.length ? { next: String(index + 1) } : {}) };
    };
  }

  it("counts objects per top-level folder across pages, and returns counts only", async () => {
    const result = await countObjectsByPrefix(fakeLister([[`org/${ORG_A}/vehicles/x/photos/a.jpg`, `org/${ORG_A}/vehicles/x/photos/b.jpg`, "stray.txt"], [`uploads/one.jpg`, `org/${ORG_B}/vehicles/y/documents/c.pdf`]]));
    expect(Object.fromEntries(result.byPrefix)).toEqual({ org: 3, "(root)": 1, uploads: 1 });
    expect(result.total).toBe(5);
    expect(JSON.stringify([...result.byPrefix])).not.toMatch(/a\.jpg|photos|vehicles|\.pdf/);
  });

  it("an empty bucket is zero", async () => {
    expect((await countObjectsByPrefix(fakeLister([[]]))).total).toBe(0);
  });

  it("counts database rows on the configured public address versus elsewhere, with the address escaped in the pattern", async () => {
    const asked: { sql: string; params?: unknown[] }[] = [];
    const client: QueryClient = {
      query: async (sql, params) => {
        asked.push({ sql, ...(params ? { params } : {}) });
        return { rows: [{ total: 10, matching: 7 }] };
      },
    };
    const counts = await countUrlRows(client, "https://files.example.test/");
    expect(counts).toEqual([
      { column: "VehiclePhoto.url", total: 10, onPublicHost: 7, elsewhere: 3 },
      { column: "VehicleDocument.url", total: 10, onPublicHost: 7, elsewhere: 3 },
      { column: "Vehicle.auctionSheetUrl", total: 10, onPublicHost: 7, elsewhere: 3 },
    ]);
    expect(asked.every((q) => /^SELECT /.test(q.sql) && !/INSERT|UPDATE|DELETE|DROP|ALTER/i.test(q.sql))).toBe(true);
    expect(asked[0]!.params).toEqual(["https://files.example.test/%"]);
    expect(likePrefix("https://a_b.example.test")).toBe("https://a\\_b.example.test/%");
  });

  it("the report holds numbers and fixed labels only", async () => {
    const report = formatAudit({
      objects: await countObjectsByPrefix(fakeLister([[`org/${ORG_A}/vehicles/x/photos/secret-name.jpg`]])),
      urls: [{ column: "VehiclePhoto.url", total: 4, onPublicHost: 3, elsewhere: 1 }],
    });
    expect(report).toContain("org: 1");
    expect(report).toContain("VehiclePhoto.url: 4 rows, 3 on the configured public address, 1 elsewhere");
    expect(report).not.toMatch(/secret-name|https?:|@|vehicles|photos\//);
  });

  it("the script only lists and counts: no write call, no credential or address printed, no error object printed", () => {
    const source = readFileSync("scripts/r2-audit.ts", "utf8");
    const code = source.split(String.fromCharCode(10)).filter((line) => !line.trimStart().startsWith("//")).join(String.fromCharCode(10));
    for (const forbidden of ["PutObject", "DeleteObject", "CopyObject", "putObject", "deleteKey", "INSERT", "UPDATE ", "DELETE FROM", "MIGRATION_DATABASE_URL", "DIRECT_URL"]) expect(code, forbidden).not.toContain(forbidden);
    expect(code).toContain("ListObjectsV2Command");
    expect(code).toContain("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    // every console call prints a fixed message or the formatted report, never a variable such as a credential or an error
    expect(code).not.toMatch(/console\.(?:log|error)\((?!"|formatAudit\()/);
  });
});
