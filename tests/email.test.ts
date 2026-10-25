import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ key: undefined as string | undefined, from: undefined as string | undefined }));
vi.mock("../src/config/env.js", () => ({
  loadEnv: () => ({ RESEND_API_KEY: state.key, EMAIL_FROM: state.from }),
}));

import { maskEmail, sendEmail } from "../src/lib/email.js";

const root = path.resolve(import.meta.dirname, "..");
const message = { to: "customer.person@example.test", subject: "Hello", text: "secret body text" };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  state.key = undefined;
  state.from = undefined;
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendEmail with no configuration", () => {
  it.each([
    ["no key and no sender", undefined, undefined],
    ["a key but no sender", "example-key", undefined],
    ["a sender but no key", undefined, "Example <no-reply@example.test>"],
    ["an empty key", "", "Example <no-reply@example.test>"],
  ])("makes NO network call: %s", async (_n, key, from) => {
    state.key = key;
    state.from = from;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await sendEmail(message)).toEqual({ sent: false, reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("c***@example.test");
    expect(logged).not.toContain("customer.person");
    expect(logged).not.toContain("secret body text");
  });
});

describe("sendEmail when configured", () => {
  beforeEach(() => {
    state.key = "example-key";
    state.from = "Example <no-reply@example.test>";
  });

  it("posts to the Resend API only, with the key in the Authorization header and no redirects", async () => {
    expect(await sendEmail(message)).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.authorization).toBe("Bearer example-key");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toMatchObject({ to: ["customer.person@example.test"], subject: "Hello" });
  });

  it("a rejected send is reported without the body, the key or the full address in the log", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 422 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sendEmail(message)).toEqual({ sent: false, reason: "failed" });
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).not.toContain("secret body text");
    expect(logged).not.toContain("example-key");
    expect(logged).not.toContain("customer.person");
  });

  it("a network failure never throws", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sendEmail(message)).toEqual({ sent: false, reason: "failed" });
  });
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmail("alice@example.test")).toBe("a***@example.test");
    expect(maskEmail("not-an-address")).toBe("***");
    expect(maskEmail("@example.test")).toBe("***");
  });
});

describe("no other code path can send mail", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (name === "node_modules" || name === ".git") return [];
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const sources = [...walk(path.join(root, "src")), ...walk(path.join(root, "scripts"))].filter((f) => /\.(ts|js|mjs)$/.test(f));

  it("only src/lib/email.ts mentions the Resend API or RESEND_API_KEY (and src/config/env.ts declares it)", () => {
    const allowed = new Set([path.join(root, "src", "lib", "email.ts"), path.join(root, "src", "config", "env.ts")]);
    const offenders = sources.filter((file) => /api.resend.com|RESEND_API_KEY/.test(readFileSync(file, "utf8")) && !allowed.has(file));
    expect(offenders).toEqual([]);
  });

  it("no mail SDK is installed or imported", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(names.filter((n) => /resend|nodemailer|sendgrid|mailgun|postmark|@aws-sdk\/client-ses/i.test(n))).toEqual([]);
  });

  it("the unit-test environment never has a key, so a test that forgot to mock cannot send", () => {
    expect(process.env["RESEND_API_KEY"]).toBeUndefined();
  });
});
