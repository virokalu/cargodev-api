// Staff authorization is read from the DATABASE (through a short cache), not from the token: a deactivated or demoted user
// loses access on the next request, and an open stream closes. Fake data only.

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown, ttl: 30 }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), STAFF_AUTH_CACHE_SECONDS: state.ttl }) };
});
const invalidations = vi.hoisted(() => ({ calls: [] as Array<[string, string]> }));
vi.mock("../src/services/staff-auth-state.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/staff-auth-state.service.js")>();
  return {
    ...actual,
    invalidateStaffAuth: (orgId: string, userId: string) => {
      invalidations.calls.push([orgId, userId]);
      actual.invalidateStaffAuth(orgId, userId);
    },
  };
});

import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { setTrustTokenClaimsForTests, tokenClaimsAreTrusted } from "../src/lib/staff-auth-seam.js";
import { clearStaffAuthCache, getFreshStaffAuth, invalidateStaffAuth } from "../src/services/staff-auth-state.service.js";
import { createStaff, setStaffActive, updateStaff } from "../src/services/user.service.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";

const staffRow = (id: string, org_id: string, name: string, role: Role, extra: Record<string, unknown> = {}) => ({
  id,
  org_id,
  userType: "STAFF",
  name,
  email: `${id}@example.test`,
  phone: null,
  role,
  loginEnabled: true,
  lastActiveAt: null,
  ...extra,
});

let fake: FakePrisma;
let app: FastifyInstance;
const userDb = () => fake.client as unknown as { user: { findFirst: (args: unknown) => Promise<unknown> } };

/** A validly signed token. The role in it is only what the token CLAIMS. */
const token = (id: string, claimedRole: Role, orgId = ORG_A, name = "Claimed Name") =>
  signAccessToken({ sub: id, orgId, role: claimedRole, name, email: null }).then((t) => ({ authorization: `Bearer ${t}` }));

const setRow = (id: string, patch: Record<string, unknown>) => {
  const row = fake.rows("user").find((r) => r["id"] === id);
  if (!row) throw new Error(`no row ${id}`);
  Object.assign(row, patch);
};
const reads = () => vi.mocked(userDb().user.findFirst).mock.calls.length;

beforeEach(async () => {
  setTrustTokenClaimsForTests(false); // these tests prove the database check
  state.ttl = 30;
  invalidations.calls.length = 0;
  clearStaffAuthCache();
  fake = createFakePrisma();
  state.fake = fake;
  fake.seed(
    "user",
    staffRow("staff_super", ORG_A, "Administrator", "ADMINISTRATOR"),
    staffRow("staff_admin", ORG_A, "Regular Admin", "ADMINISTRATOR"),
    staffRow("staff_mgr", ORG_A, "Test Manager", "MANAGER"),
    staffRow("staff_view", ORG_A, "Test Viewer", "VIEWER"),
    staffRow("staff_off", ORG_A, "Disabled Person", "MANAGER", { loginEnabled: false }),
    staffRow("staff_other_org", ORG_B, "Other Org Manager", "MANAGER"),
    { id: "cust_a1", org_id: ORG_A, userType: "CUSTOMER", name: "Buyer", email: "b@example.test", phone: null, role: null, loginEnabled: true }
  );
  fake.seed("refreshToken", { id: "rt_1", org_id: ORG_A, userId: "staff_mgr", revokedAt: null });
  vi.spyOn(userDb().user, "findFirst");
  app = await buildApp({ rateLimit: false });
});

afterEach(async () => {
  await app.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setTrustTokenClaimsForTests(true);
});

const get = async (id: string, claimed: Role, path = "/api/v1/staff", orgId = ORG_A) =>
  app.inject({ method: "GET", url: path, headers: await token(id, claimed, orgId) });
const post = async (id: string, claimed: Role, path: string, payload: unknown) =>
  app.inject({ method: "POST", url: path, headers: await token(id, claimed), payload: payload as object });

describe("getFreshStaffAuth", () => {
  it("returns the database role, name and email of an active staff user", async () => {
    expect(await getFreshStaffAuth("staff_mgr", ORG_A)).toEqual({ id: "staff_mgr", orgId: ORG_A, role: "MANAGER", name: "Test Manager", email: "staff_mgr@example.test" });
  });

  it.each([
    ["a disabled account", "staff_off", ORG_A],
    ["an unknown id", "staff_nobody", ORG_A],
    ["a user of another org", "staff_other_org", ORG_A],
    ["a customer row", "cust_a1", ORG_A],
  ])("returns null for %s", async (_label, id, org) => {
    expect(await getFreshStaffAuth(id, org)).toBeNull();
  });

  it("a customer row is never staff, even if corrupt data gave it a role", async () => {
    fake.seed("user", { id: "cust_roled", org_id: ORG_A, userType: "CUSTOMER", name: "Odd", email: "odd@example.test", phone: null, role: "ADMINISTRATOR", loginEnabled: true });
    expect(await getFreshStaffAuth("cust_roled", ORG_A)).toBeNull();
  });

  it("a staff row with no role is not allowed (there is nothing to authorize with)", async () => {
    fake.seed("user", staffRow("staff_norole", ORG_A, "No Role", "VIEWER", { role: null }));
    expect(await getFreshStaffAuth("staff_norole", ORG_A)).toBeNull();
  });

  it("is keyed by org AND user: the same id in two orgs never shares an answer", async () => {
    fake.seed("user", staffRow("staff_dup", ORG_A, "Dup A", "MANAGER"), staffRow("staff_dup", ORG_B, "Dup B", "VIEWER"));
    expect((await getFreshStaffAuth("staff_dup", ORG_A))?.role).toBe("MANAGER");
    expect((await getFreshStaffAuth("staff_dup", ORG_B))?.role).toBe("VIEWER");
  });
});

describe("the test seam", () => {
  it("is inert outside NODE_ENV=test: the token's claims are never trusted and it cannot be switched on", () => {
    setTrustTokenClaimsForTests(true);
    expect(tokenClaimsAreTrusted()).toBe(true);
    const before = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(tokenClaimsAreTrusted()).toBe(false);
      expect(() => setTrustTokenClaimsForTests(true)).toThrow();
    } finally {
      process.env["NODE_ENV"] = before;
      setTrustTokenClaimsForTests(false);
    }
  });
});

describe("the cache", () => {
  it("serves repeats from memory and reads the database again after STAFF_AUTH_CACHE_SECONDS", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await getFreshStaffAuth("staff_mgr", ORG_A);
    await getFreshStaffAuth("staff_mgr", ORG_A);
    expect(reads()).toBe(1);
    vi.setSystemTime(Date.now() + 29_000);
    await getFreshStaffAuth("staff_mgr", ORG_A);
    expect(reads()).toBe(1);
    vi.setSystemTime(Date.now() + 2_000);
    await getFreshStaffAuth("staff_mgr", ORG_A);
    expect(reads()).toBe(2);
  });

  it("STAFF_AUTH_CACHE_SECONDS=0 turns it off: every call reads the database", async () => {
    state.ttl = 0;
    await getFreshStaffAuth("staff_mgr", ORG_A);
    await getFreshStaffAuth("staff_mgr", ORG_A);
    expect(reads()).toBe(2);
  });

  it("bypassCache always reads the database, and refreshes what is remembered", async () => {
    await getFreshStaffAuth("staff_mgr", ORG_A);
    setRow("staff_mgr", { loginEnabled: false });
    expect(await getFreshStaffAuth("staff_mgr", ORG_A)).not.toBeNull(); // still the remembered answer
    expect(await getFreshStaffAuth("staff_mgr", ORG_A, { bypassCache: true })).toBeNull();
    expect(await getFreshStaffAuth("staff_mgr", ORG_A)).toBeNull(); // and now remembered as null
  });

  it("remembers 'not allowed' too, so probing made-up ids costs one read each per cache time", async () => {
    for (let i = 0; i < 5; i += 1) expect(await getFreshStaffAuth("staff_nobody", ORG_A)).toBeNull();
    expect(reads()).toBe(1);
  });

  it("invalidateStaffAuth drops the entry at once", async () => {
    await getFreshStaffAuth("staff_mgr", ORG_A);
    setRow("staff_mgr", { role: "VIEWER" });
    invalidateStaffAuth(ORG_A, "staff_mgr");
    expect((await getFreshStaffAuth("staff_mgr", ORG_A))?.role).toBe("VIEWER");
  });

  it("invalidating one user leaves other users remembered", async () => {
    await getFreshStaffAuth("staff_mgr", ORG_A);
    await getFreshStaffAuth("staff_view", ORG_A);
    invalidateStaffAuth(ORG_A, "staff_mgr");
    await getFreshStaffAuth("staff_view", ORG_A);
    expect(reads()).toBe(2);
  });

  it("an invalidation during a read stops that (old) answer from being remembered", async () => {
    const real = userDb().user.findFirst.bind(userDb().user);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(userDb().user.findFirst).mockImplementationOnce(async (args: unknown) => {
      const before = await real(args); // reads the OLD row
      await gate;
      return before;
    });
    const inFlight = getFreshStaffAuth("staff_mgr", ORG_A);
    await Promise.resolve();
    setRow("staff_mgr", { loginEnabled: false });
    invalidateStaffAuth(ORG_A, "staff_mgr"); // the change commits and invalidates while the old read is in flight
    release();
    expect(await inFlight).not.toBeNull(); // that caller saw the old answer...
    expect(await getFreshStaffAuth("staff_mgr", ORG_A)).toBeNull(); // ...but it was not stored
  });
});

describe("every staff route uses the database, not the token", () => {
  it("a valid token for an ACTIVE user works", async () => {
    expect((await get("staff_mgr", "MANAGER")).statusCode).toBe(200);
  });

  it("a deactivated user with an unexpired token is rejected (401)", async () => {
    const res = await get("staff_off", "MANAGER");
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("a token for a user that does not exist is rejected (401)", async () => {
    expect((await get("staff_nobody", "ADMINISTRATOR")).statusCode).toBe(401);
  });

  it("a token whose org does not match the user's org is rejected (401): another org's user is not this org's staff", async () => {
    expect((await get("staff_other_org", "MANAGER", "/api/v1/staff", ORG_A)).statusCode).toBe(401);
  });

  it("a customer's id in a staff token is rejected (401)", async () => {
    expect((await get("cust_a1", "ADMINISTRATOR")).statusCode).toBe(401);
  });

  it("the DATABASE role decides: a token claiming ADMINISTRATOR for a VIEWER cannot use an admin route", async () => {
    const res = await post("staff_view", "ADMINISTRATOR", "/api/v1/staff/staff_mgr/active", { active: false });
    expect(res.statusCode).toBe(403);
    expect(fake.rows("user").find((r) => r["id"] === "staff_mgr")?.["loginEnabled"]).toBe(true);
  });

  it("the DATABASE role decides the other way too: a token claiming VIEWER for an ADMINISTRATOR is allowed what an admin may do", async () => {
    const res = await post("staff_admin", "VIEWER", "/api/v1/staff/staff_view/active", { active: false });
    expect(res.statusCode).toBe(200);
  });

  it("the name used for the super-admin rule comes from the database, not from the token", async () => {
    // A regular admin whose TOKEN says the reserved name must not be treated as the super-admin.
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/staff/staff_super",
      headers: await token("staff_admin", "ADMINISTRATOR", ORG_A, "Administrator"),
      payload: { name: "Administrator", email: "x@example.test", phone: null, role: "VIEWER", active: true },
    });
    expect([403, 404]).toContain(res.statusCode);
    expect(fake.rows("user").find((r) => r["id"] === "staff_super")?.["role"]).toBe("ADMINISTRATOR");
  });
});

describe("changes made through the API apply on the very next request (cache time 300 s)", () => {
  beforeEach(() => {
    state.ttl = 300;
  });

  it("a demoted administrator loses mutation rights immediately", async () => {
    expect((await post("staff_admin", "ADMINISTRATOR", "/api/v1/staff/staff_view/active", { active: true })).statusCode).toBe(200); // primes the cache
    const demote = await app.inject({
      method: "PATCH",
      url: "/api/v1/staff/staff_admin",
      headers: await token("staff_super", "ADMINISTRATOR", ORG_A, "Administrator"),
      payload: { name: "Regular Admin", email: "staff_admin@example.test", phone: null, role: "MANAGER", active: true },
    });
    expect(demote.statusCode).toBe(200);
    // The same token, which still CLAIMS ADMINISTRATOR, now fails the admin-only route.
    expect((await post("staff_admin", "ADMINISTRATOR", "/api/v1/staff/staff_view/active", { active: true })).statusCode).toBe(403);
  });

  it("a deactivated user is rejected immediately, and a reactivated one is let back in immediately", async () => {
    expect((await get("staff_mgr", "MANAGER")).statusCode).toBe(200); // primes the cache
    expect((await post("staff_super", "ADMINISTRATOR", "/api/v1/staff/staff_mgr/active", { active: false })).statusCode).toBe(200);
    expect((await get("staff_mgr", "MANAGER")).statusCode).toBe(401);
    expect((await post("staff_super", "ADMINISTRATOR", "/api/v1/staff/staff_mgr/active", { active: true })).statusCode).toBe(200);
    expect((await get("staff_mgr", "MANAGER")).statusCode).toBe(200);
  });

  it("a user deactivated by an edit (active: false) is rejected immediately", async () => {
    expect((await get("staff_mgr", "MANAGER")).statusCode).toBe(200);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/staff/staff_mgr",
      headers: await token("staff_super", "ADMINISTRATOR", ORG_A, "Administrator"),
      payload: { name: "Test Manager", email: "staff_mgr@example.test", phone: null, role: "MANAGER", active: false },
    });
    expect(res.statusCode).toBe(200);
    expect((await get("staff_mgr", "MANAGER")).statusCode).toBe(401);
  });

  it("without the invalidation the cache would still say yes (proves the cache is in the path)", async () => {
    expect((await get("staff_mgr", "MANAGER")).statusCode).toBe(200);
    setRow("staff_mgr", { loginEnabled: false }); // a change made behind the API's back, in this test only
    expect((await get("staff_mgr", "MANAGER")).statusCode).toBe(200);
    invalidateStaffAuth(ORG_A, "staff_mgr");
    expect((await get("staff_mgr", "MANAGER")).statusCode).toBe(401);
  });
});

describe("the services invalidate after every staff change, for exactly that user", () => {
  const superAdmin = { id: "staff_super", role: "ADMINISTRATOR" as const, orgId: ORG_A, name: "Administrator", email: null };

  it("createStaff", async () => {
    const created = await createStaff(superAdmin, { name: "New Person", email: "new.person@example.test", phone: null, role: "OPERATOR", password: "example-Passw0rd-1" });
    expect(invalidations.calls).toEqual([[ORG_A, created.id]]);
  });

  it("a made-up id remembered as 'not allowed' is let in as soon as that account is created", async () => {
    // The not-allowed answer for an id is cached; creating the account must clear it.
    const probe = await getFreshStaffAuth("staff_future", ORG_A);
    expect(probe).toBeNull();
    fake.seed("user", staffRow("staff_future", ORG_A, "Future Staff", "MANAGER"));
    expect(await getFreshStaffAuth("staff_future", ORG_A)).toBeNull(); // still cached
    invalidateStaffAuth(ORG_A, "staff_future"); // what createStaff does for the new id
    expect((await getFreshStaffAuth("staff_future", ORG_A))?.role).toBe("MANAGER");
  });

  it("updateStaff (role change)", async () => {
    await updateStaff(superAdmin, "staff_mgr", { name: "Test Manager", email: "staff_mgr@example.test", phone: null, role: "VIEWER", active: true });
    expect(invalidations.calls).toEqual([[ORG_A, "staff_mgr"]]);
  });

  it("setStaffActive (deactivate and reactivate)", async () => {
    await setStaffActive(superAdmin, "staff_mgr", false);
    await setStaffActive(superAdmin, "staff_mgr", true);
    expect(invalidations.calls).toEqual([[ORG_A, "staff_mgr"], [ORG_A, "staff_mgr"]]);
  });

  it("a change that is rejected (not allowed, not found) invalidates nothing", async () => {
    await expect(setStaffActive(superAdmin, "staff_other_org", false)).rejects.toThrow();
    await expect(updateStaff({ ...superAdmin, role: "MANAGER", name: "Not Super" }, "staff_admin", { name: "x", email: "x@example.test", phone: null, role: "VIEWER", active: true })).rejects.toThrow();
    expect(invalidations.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("open staff streams re-check against the database", () => {
  let base: string;
  const aborts: Array<() => void> = [];
  afterEach(() => {
    for (const abort of aborts.splice(0)) abort();
  });

  const start = async (recheckMs: number) => {
    await app.close();
    app = await buildApp({ rateLimit: false, sseRecheckMs: recheckMs });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };
  const open = async (id: string) => {
    const controller = new AbortController();
    aborts.push(() => controller.abort());
    const res = await fetch(`${base}/api/v1/notifications/stream`, { headers: await token(id, "MANAGER"), signal: controller.signal });
    const body = { text: "", ended: false };
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          body.text += decoder.decode(chunk.value, { stream: true });
        }
      } catch {
        /* aborted */
      } finally {
        body.ended = true;
      }
    })();
    return { status: res.status, body };
  };
  const until = async (check: () => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a stream whose user is disabled while connected is closed at the next re-check, even with a long cache time", async () => {
    state.ttl = 300;
    await start(60);
    const stream = await open("staff_mgr");
    expect(stream.status).toBe(200);
    await settle(150);
    expect(stream.body.ended).toBe(false); // an active user keeps the stream
    setRow("staff_mgr", { loginEnabled: false }); // behind the cache's back: the re-check does not use the cache
    await until(() => stream.body.ended);
    expect(stream.body.text).toContain("event: closed");
    expect(stream.body.text).toContain("unauthorized");
  });

  it("a user who is still active is never cut off", async () => {
    await start(40);
    const stream = await open("staff_view");
    await settle(300);
    expect(stream.body.ended).toBe(false);
  });

  it("a database error during a re-check keeps the stream open", async () => {
    await start(40);
    const stream = await open("staff_view");
    vi.mocked(userDb().user.findFirst).mockRejectedValue(new Error("database unreachable"));
    await settle(200);
    expect(stream.body.ended).toBe(false);
  });

  it("the default re-check interval is 60 seconds at most", async () => {
    const { STREAM_RECHECK_MS } = await import("../src/lib/sse-route.js");
    expect(STREAM_RECHECK_MS).toBeLessThanOrEqual(60_000);
  });
});
