import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi  } from "vitest";

// bcrypt is deliberately slow and the whole suite runs in parallel: allow this file more than the 5 s default (per file, not global).
vi.setConfig({ testTimeout: 30_000 });
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { isShadowLocked, recordShadowFailure, resetShadowLockouts } from "../src/lib/shadow-lockout.js";
import { verifyStaffCredentials } from "../src/services/staff-auth.service.js";

const GOOD = "example-Good-Passw0rd";
const WRONG = "example-wrong";

let fake: FakePrisma;

beforeEach(() => {
  resetShadowLockouts();
  vi.restoreAllMocks();
  fake = createFakePrisma();
  state.fake = fake;
  const base = { userType: "STAFF", loginEnabled: true, failedLoginAttempts: 0, lockoutUntil: null, role: "MANAGER" };
  fake.seed(
    "user",
    { ...base, id: "real", org_id: ORG_A, name: "Real", email: "real@example.test", password: bcrypt.hashSync(GOOD, 4) },
    { ...base, id: "off", org_id: ORG_A, name: "Off", email: "off@example.test", loginEnabled: false, password: bcrypt.hashSync(GOOD, 4) },
    { ...base, id: "cust", org_id: ORG_A, name: "Cust", email: "cust@example.test", userType: "CUSTOMER", password: bcrypt.hashSync(GOOD, 4) },
    { ...base, id: "other", org_id: ORG_B, name: "Other", email: "other@example.test", password: bcrypt.hashSync(GOOD, 4) }
  );
});

type Outcome = "null" | "FORBIDDEN" | "ok";

async function attempt(email: string, password = WRONG): Promise<Outcome> {
  try {
    return (await verifyStaffCredentials(email, password)) ? "ok" : "null";
  } catch (error) {
    if ((error as { code?: string }).code === "FORBIDDEN") return "FORBIDDEN";
    throw error;
  }
}

async function sequence(email: string, count = 8): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (let i = 0; i < count; i++) out.push(await attempt(email));
  return out;
}

describe("a caller cannot tell real emails from fake ones", () => {
  it("a real account and an unknown email produce the identical response sequence", async () => {
    const real = await sequence("real@example.test");
    const fakeEmail = await sequence("nobody@example.test");
    expect(fakeEmail).toEqual(real);
    expect(real).toEqual(["null", "null", "null", "null", "null", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
  });

  it.each(["off@example.test", "cust@example.test", "other@example.test"])(
    "an ineligible account (%s) behaves like an unknown email",
    async (email) => {
      expect(await sequence(email)).toEqual(await sequence("nobody@example.test"));
    }
  );

  it("the lock message is the same for real and fake accounts", async () => {
    const messageFor = async (email: string) => {
      for (let i = 0; i < 5; i++) await attempt(email);
      return verifyStaffCredentials(email, WRONG).catch((e: Error) => e.message);
    };
    expect(await messageFor("nobody@example.test")).toBe(await messageFor("real@example.test"));
  });

  it("a locked fake email stays locked even if the password guessed is 'right'", async () => {
    await sequence("nobody@example.test", 5);
    expect(await attempt("nobody@example.test", GOOD)).toBe("FORBIDDEN");
  });

  it("locking one fake email does not affect another email", async () => {
    await sequence("nobody@example.test", 6);
    expect(await attempt("real@example.test", GOOD)).toBe("ok");
    expect(await attempt("someone-else@example.test")).toBe("null");
  });

  it("email matching ignores case and whitespace, like real lookups", async () => {
    await sequence("nobody@example.test", 5);
    expect(await attempt("  NOBODY@Example.test ")).toBe("FORBIDDEN");
  });
});

describe("timing parity", () => {
  it("an unknown email still pays for one bcrypt compare", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    await attempt("nobody@example.test");
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it("a real account with a wrong password also does exactly one compare", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    await attempt("real@example.test");
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it("a locked response does no compare, for real and fake accounts alike", async () => {
    await sequence("real@example.test", 5);
    await sequence("nobody@example.test", 5);
    const compare = vi.spyOn(bcrypt, "compare");
    await attempt("real@example.test");
    await attempt("nobody@example.test");
    expect(compare).not.toHaveBeenCalled();
  });
});

describe("shadow lockout store", () => {
  it("locks on the 5th failure and expires after 15 minutes", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) recordShadowFailure("a@example.test", t0);
    expect(isShadowLocked("a@example.test", t0)).toBe(false);
    recordShadowFailure("a@example.test", t0);
    expect(isShadowLocked("a@example.test", t0 + 14 * 60_000)).toBe(true);
    expect(isShadowLocked("a@example.test", t0 + 15 * 60_000 + 1)).toBe(false);
  });

  it("one more failure after expiry relocks immediately, like the real counter", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) recordShadowFailure("a@example.test", t0);
    const later = t0 + 16 * 60_000;
    expect(isShadowLocked("a@example.test", later)).toBe(false);
    recordShadowFailure("a@example.test", later);
    expect(isShadowLocked("a@example.test", later)).toBe(true);
  });

  it("stays bounded under random-email spam", () => {
    for (let i = 0; i < 12_000; i++) recordShadowFailure(`spam${i}@example.test`, 1);
    // The newest entries survive; the oldest were evicted.
    expect(isShadowLocked("spam11999@example.test", 1)).toBe(false);
    for (let i = 0; i < 5; i++) recordShadowFailure("spam11999@example.test", 1);
    expect(isShadowLocked("spam11999@example.test", 1)).toBe(true);
  });
});
