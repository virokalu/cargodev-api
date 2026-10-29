// EMAIL_ALLOWED_RECIPIENTS: with an allow-list only matching recipients get email (the rest are dropped with a masked line and the caller
// sees nothing unusual), and a staging deployment with real mail credentials refuses to start without one. Fake data only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ key: "example-key" as string | undefined, from: "Example <no-reply@example.test>" as string | undefined, allow: "" as string | undefined }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ RESEND_API_KEY: state.key, EMAIL_FROM: state.from, EMAIL_ALLOWED_RECIPIENTS: state.allow }) };
});

import { hasInvalidAllowListEntry, isRecipientAllowed, parseAllowList } from "../src/lib/email-allow-list.js";
import { sendEmail } from "../src/lib/email.js";

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:password@example.test:5432/dbname",
  MOBILE_JWT_SECRET: "mobile-secret-value-0123456789abcdefXX",
  ORG_ID: "org_x",
};

describe("parseAllowList", () => {
  it("trims, lower-cases and drops empty entries", () => {
    expect(parseAllowList(" A@Example.test , ,@Example.TEST,, b@example.test ")).toEqual(["a@example.test", "@example.test", "b@example.test"]);
    expect(parseAllowList("")).toEqual([]);
    expect(parseAllowList(undefined)).toEqual([]);
    expect(parseAllowList(" , ")).toEqual([]);
  });

  it("spots an entry that is neither an address nor a domain", () => {
    for (const bad of ["example.test", "a@", "@", "a b@example.test", "@example", "a@@example.test", "Name <a@example.test>", "*@example.test", "*", "a@example.test;b@example.test"]) {
      expect(hasInvalidAllowListEntry(parseAllowList(bad)), bad).toBe(true);
    }
    expect(hasInvalidAllowListEntry(parseAllowList("a@example.test,@example.test,b.c@mail.example.test"))).toBe(false);
    expect(hasInvalidAllowListEntry([])).toBe(false);
  });
});

describe("isRecipientAllowed", () => {
  it("an empty list restricts nothing", () => {
    expect(isRecipientAllowed("anyone@example.test", [])).toBe(true);
  });

  it("matches an exact address, ignoring case and surrounding spaces", () => {
    const list = parseAllowList("tester@example.test");
    expect(isRecipientAllowed("tester@example.test", list)).toBe(true);
    expect(isRecipientAllowed("  TESTER@Example.Test ", list)).toBe(true);
    expect(isRecipientAllowed("other@example.test", list)).toBe(false);
    expect(isRecipientAllowed("tester@example.test.evil.test", list)).toBe(false);
    expect(isRecipientAllowed("xtester@example.test", list)).toBe(false);
    expect(isRecipientAllowed("tester@sub.example.test", list)).toBe(false);
  });

  it("matches a whole domain, exactly: not a subdomain, not a longer domain, not a look-alike", () => {
    const list = parseAllowList("@example.test");
    expect(isRecipientAllowed("anyone@example.test", list)).toBe(true);
    expect(isRecipientAllowed("Anyone.Else@EXAMPLE.test", list)).toBe(true);
    for (const no of ["x@sub.example.test", "x@example.test.evil.test", "x@notexample.test", "x@evil-example.test", "x@example.testing", "example.test", "@example.test", "x@y@example.test"]) {
      expect(isRecipientAllowed(no, list), no).toBe(false);
    }
  });

  it("an address that is not a plain address never matches (it fails closed)", () => {
    const list = parseAllowList("@example.test,tester@example.test");
    for (const odd of ["Tester <tester@example.test>", "tester@example.test, other@evil.test", "", "   ", "tester", '"tester"@example.test']) {
      expect(isRecipientAllowed(odd, list), JSON.stringify(odd)).toBe(false);
    }
  });

  it("a list with several entries allows any of them", () => {
    const list = parseAllowList("a@example.test,@partner.test");
    expect(isRecipientAllowed("a@example.test", list)).toBe(true);
    expect(isRecipientAllowed("z@partner.test", list)).toBe(true);
    expect(isRecipientAllowed("z@example.test", list)).toBe(false);
  });
});

describe("sendEmail with an allow-list", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    state.key = "example-key";
    state.from = "Example <no-reply@example.test>";
    state.allow = "";
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const message = (to: string) => ({ to, subject: "Hello", text: "secret body text" });

  it("with no list everyone gets email (unchanged behaviour)", async () => {
    expect(await sendEmail(message("anyone@example.test"))).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a recipient on the list is sent to; one that is not is DROPPED before any network call, with a masked line", async () => {
    state.allow = "tester@example.test,@partner.test";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await sendEmail(message("tester@example.test"))).toEqual({ sent: true });
    expect(await sendEmail(message("boss@partner.test"))).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(await sendEmail(message("customer.person@real-customer.test"))).toEqual({ sent: false, reason: "not_allowed" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // nothing went out for the stranger
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("email dropped");
    expect(logged).toContain("c***@real-customer.test");
    expect(logged).not.toContain("customer.person");
    expect(logged).not.toContain("secret body text");
    expect(logged).not.toContain("tester@example.test"); // the list itself is not printed
  });

  it("is checked even when email is not configured (the answer is 'not allowed', and still no network call)", async () => {
    state.key = undefined;
    state.allow = "tester@example.test";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await sendEmail(message("stranger@example.test"))).toEqual({ sent: false, reason: "not_allowed" });
    expect(await sendEmail(message("tester@example.test"))).toEqual({ sent: false, reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws for a dropped message, whatever the address looks like", async () => {
    state.allow = "tester@example.test";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const to of ["", "not an address", "a@b@c", "Name <x@y.test>", "x@y.test, tester@example.test"]) {
      await expect(sendEmail(message(to))).resolves.toEqual({ sent: false, reason: "not_allowed" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the settings", () => {
  async function load(extra: Record<string, string>) {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    return actual.loadEnv({ ...BASE_ENV, ...extra });
  }
  const message = async (extra: Record<string, string>) => load(extra).then(() => "", (e: Error) => e.message);

  it("is optional and empty by default", async () => {
    expect((await load({})).EMAIL_ALLOWED_RECIPIENTS).toBe("");
  });

  it("accepts addresses and domains", async () => {
    expect((await load({ EMAIL_ALLOWED_RECIPIENTS: "a@example.test, @partner.test" })).EMAIL_ALLOWED_RECIPIENTS).toBe("a@example.test, @partner.test");
  });

  it("rejects an entry that is neither, naming the setting and never printing the value", async () => {
    const text = await message({ EMAIL_ALLOWED_RECIPIENTS: "a@example.test,not-an-address" });
    expect(text).toContain("EMAIL_ALLOWED_RECIPIENTS");
    expect(text).toContain("list of addresses");
    expect(text).not.toContain("not-an-address");
  });

  it("APP_ENV=staging with a mail key and NO list stops the start, with a clear message", async () => {
    const text = await message({ APP_ENV: "staging", RESEND_API_KEY: "example-key" });
    expect(text).toContain("EMAIL_ALLOWED_RECIPIENTS");
    expect(text).toContain("staging must not email real customers");
    expect(await message({ APP_ENV: "staging", RESEND_API_KEY: "example-key", EMAIL_ALLOWED_RECIPIENTS: " , " })).toContain("staging must not email real customers"); // a blank list is no list
  });

  it("staging with a list, staging without a key, production and development with a key and no list all start", async () => {
    await expect(load({ APP_ENV: "staging", RESEND_API_KEY: "example-key", EMAIL_ALLOWED_RECIPIENTS: "@example.test" })).resolves.toBeTruthy();
    await expect(load({ APP_ENV: "staging" })).resolves.toBeTruthy();
    await expect(load({ APP_ENV: "development", RESEND_API_KEY: "example-key" })).resolves.toBeTruthy();
    await expect(load({ APP_ENV: "production", RESEND_API_KEY: "example-key", FILE_LINK_SECRET: "link-secret-value-for-tests-0123456789abcdef", FILE_LINK_BASE_URL: "https://api.example.test", CLIENT_IP_SOURCE: "socket" })).resolves.toBeTruthy();
  });
});

describe("start-up information", () => {
  it("the summary says whether email is off, open or on an allow-list, and production warns about a list", async () => {
    vi.resetModules();
    const { startupSummary, startupWarnings } = await import("../src/lib/startup-info.js");
    // loadEnv caches per module instance: each environment is loaded in a fresh one.
    const fresh = async (extra: Record<string, string>) => {
      vi.resetModules();
      return (await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js")).loadEnv({ ...BASE_ENV, ...extra });
    };
    const link = { FILE_LINK_SECRET: "link-secret-value-for-tests-0123456789abcdef", FILE_LINK_BASE_URL: "https://api.example.test" };
    const off = await fresh({ ...link });
    const open = await fresh({ ...link, RESEND_API_KEY: "example-key", EMAIL_FROM: "Example <no-reply@example.test>" });
    const listed = await fresh({ ...link, RESEND_API_KEY: "example-key", EMAIL_FROM: "Example <no-reply@example.test>", EMAIL_ALLOWED_RECIPIENTS: "@example.test" });
    expect(startupSummary(off, {})).toContain("email=off");
    expect(startupSummary(open, {})).toContain("email=open");
    expect(startupSummary(listed, {})).toContain("email=allow-list");
    expect(startupSummary(listed, {})).not.toMatch(/example-key|@example\.test/);
    const production = await fresh({ ...link, APP_ENV: "production", CLIENT_IP_SOURCE: "socket", RESEND_API_KEY: "example-key", EMAIL_FROM: "Example <no-reply@example.test>", EMAIL_ALLOWED_RECIPIENTS: "@example.test" });
    expect(startupWarnings(production)).toEqual(["EMAIL_ALLOWED_RECIPIENTS is set in production: only matching addresses will receive email (remove it to email everyone)"]);
  });
});
