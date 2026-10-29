// Storage references (a stored file address, a storage host, an object key, a bucket name, the account id) are removed from
// everything the activity-log endpoints return, including rows written before the log stopped keeping them. What is stored is
// not changed. Values are real-looking but fake.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "cargodev-fake-files";
const STOCK_BUCKET = "cargodev-fake-stock";
const PUBLIC_BASE = "https://pub-0123456789abcdef0123456789abcdef.r2.dev";
const STOCK_BASE = "https://img.example.test";
const KEY = "org/org_test_a/vehicles/v_fc_pending/photos/0f8fad5b-d9cb-469f-a165-70867728950e-front.jpg";
const STOCK_KEY = "stock/0123456789abcdef/0f8fad5b-d9cb-469f-a165-70867728950e.webp";
const SIGNED = `https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}/${KEY}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAFAKE%2F20261029%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=abc123`;

const state = vi.hoisted(() => ({ fake: undefined as unknown, configured: true, extra: {} as Record<string, string> }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      ...(state.configured
        ? { R2_PUBLIC_URL: "https://pub-0123456789abcdef0123456789abcdef.r2.dev", PUBLIC_STOCK_IMAGE_BASE_URL: "https://img.example.test", R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_BUCKET_NAME: "cargodev-fake-files", R2_PUBLIC_STOCK_BUCKET_NAME: "cargodev-fake-stock" }
        : {}),
      ...state.extra,
    }),
  };
});

import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import { ADDRESS_REMOVED, KEY_REMOVED, NAME_REMOVED, redactStorageReferences } from "../src/lib/storage-redaction.js";
import { listActivityLog } from "../src/services/activity-log.service.js";

beforeEach(() => {
  state.configured = true;
  state.extra = {};
});

describe("redactStorageReferences", () => {
  it("removes a stored file address on the configured public base, whole", () => {
    expect(redactStorageReferences(`${PUBLIC_BASE}/${KEY}`)).toBe(ADDRESS_REMOVED);
    expect(redactStorageReferences(`${PUBLIC_BASE}/${KEY}?x=1`)).toBe(ADDRESS_REMOVED);
    expect(redactStorageReferences(`${PUBLIC_BASE.toUpperCase().replace("HTTPS", "https")}/${KEY}`)).toBe(ADDRESS_REMOVED);
  });

  it("removes a signed link on the storage API host, including its bucket, key and signature", () => {
    const out = redactStorageReferences(SIGNED);
    expect(out).toBe(ADDRESS_REMOVED);
    expect(out).not.toMatch(/X-Amz|AKIA|abc123|cloudflarestorage/);
  });

  it("removes an address on any r2.dev or storage host, even one that is not configured", () => {
    for (const address of ["https://pub-ffffffffffffffffffffffffffffffff.r2.dev/a/b.jpg", "https://other.r2.cloudflarestorage.com/bucket/key.pdf", "http://x.r2.dev/y"]) {
      expect(redactStorageReferences(address), address).toBe(ADDRESS_REMOVED);
    }
  });

  it("removes addresses on the stock image host and a custom file domain, and leaves unrelated addresses alone", () => {
    expect(redactStorageReferences(`${STOCK_BASE}/${STOCK_KEY}`)).toBe(ADDRESS_REMOVED);
    expect(redactStorageReferences("https://img.example.test/anything.png")).toBe(ADDRESS_REMOVED);
    expect(redactStorageReferences("see https://docs.example.test/help for details")).toBe("see https://docs.example.test/help for details");
    expect(redactStorageReferences("https://img.example.test.evil.test/a")).toBe("https://img.example.test.evil.test/a");
  });

  it("removes an address inside a sentence and keeps the rest of the sentence", () => {
    expect(redactStorageReferences(`opened ${PUBLIC_BASE}/${KEY} yesterday`)).toBe(`opened ${ADDRESS_REMOVED} yesterday`);
    expect(redactStorageReferences(`a ${PUBLIC_BASE}/${KEY}, b ${SIGNED}.`)).toBe(`a ${ADDRESS_REMOVED}, b ${ADDRESS_REMOVED}.`);
  });

  it("removes a bare object key of the shapes this API makes", () => {
    expect(redactStorageReferences(KEY)).toBe(KEY_REMOVED);
    expect(redactStorageReferences(`org/org_test_a/uploads/staging/x.png`)).toBe(KEY_REMOVED);
    expect(redactStorageReferences(STOCK_KEY)).toBe(KEY_REMOVED);
    expect(redactStorageReferences(`key=${KEY}`)).toBe(`key=${KEY_REMOVED}`);
  });

  it("removes the account id and the bucket names wherever they appear as words, in any case", () => {
    expect(redactStorageReferences(`account ${ACCOUNT}`)).toBe(`account ${NAME_REMOVED}`);
    expect(redactStorageReferences(`account ${ACCOUNT.toUpperCase()}`)).toBe(`account ${NAME_REMOVED}`);
    expect(redactStorageReferences(`bucket ${BUCKET} and ${STOCK_BUCKET}`)).toBe(`bucket ${NAME_REMOVED} and ${NAME_REMOVED}`);
    expect(redactStorageReferences(`x${BUCKET}`)).toBe(`x${BUCKET}`); // part of a longer word: left alone
    expect(redactStorageReferences(`${BUCKET}2`)).toBe(`${BUCKET}2`);
  });

  it("goes through nested objects and arrays, keeps keys, numbers, booleans, nulls and dates, and does not change its input", () => {
    const when = new Date("2026-10-29T00:00:00.000Z");
    const input = {
      id: "ph_1",
      count: 3,
      active: true,
      gone: null,
      when,
      auctionSheetUrl: `${PUBLIC_BASE}/${KEY}`,
      photos: [{ url: `${PUBLIC_BASE}/${KEY}`, note: `signed ${SIGNED}` }, "plain text", 7],
      deep: { a: { b: { c: [`${STOCK_BASE}/${STOCK_KEY}`] } } },
    };
    const snapshot = JSON.stringify(input);
    const out = redactStorageReferences(input);
    expect(out).toEqual({
      id: "ph_1",
      count: 3,
      active: true,
      gone: null,
      when,
      auctionSheetUrl: ADDRESS_REMOVED,
      photos: [{ url: ADDRESS_REMOVED, note: `signed ${ADDRESS_REMOVED}` }, "plain text", 7],
      deep: { a: { b: { c: [ADDRESS_REMOVED] } } },
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("with nothing configured it still removes storage hosts and keys, and does not damage ordinary text", () => {
    state.configured = false;
    expect(redactStorageReferences(SIGNED)).toBe(ADDRESS_REMOVED);
    expect(redactStorageReferences(KEY)).toBe(KEY_REMOVED);
    expect(redactStorageReferences("Customer renamed to Alice")).toBe("Customer renamed to Alice");
    expect(redactStorageReferences(`account ${ACCOUNT}`)).toBe(`account ${ACCOUNT}`); // no configured id to look for
  });

  it("a short configured name never mangles ordinary words (names under 4 characters are ignored)", () => {
    state.extra = { R2_BUCKET_NAME: "cat" };
    expect(redactStorageReferences("the cat sat on the mat")).toBe("the cat sat on the mat");
    state.extra = { R2_BUCKET_NAME: "cats" }; // four characters is the shortest that is looked for
    expect(redactStorageReferences("the cats sat")).toBe(`the ${NAME_REMOVED} sat`);
  });

  it("a configured host is removed on ANY port or path, not only under the exact configured base", () => {
    expect(redactStorageReferences("https://img.example.test:8443/other/place.png")).toBe(ADDRESS_REMOVED);
    expect(redactStorageReferences("http://img.example.test/x")).toBe(ADDRESS_REMOVED);
    expect(redactStorageReferences("https://pub-0123456789abcdef0123456789abcdef.r2.dev:444/z")).toBe(ADDRESS_REMOVED);
  });
});

describe("the activity log endpoints", () => {
  let fake: FakePrisma;
  const OLD_ROW = {
    id: "log_old",
    org_id: ORG_A,
    actorId: "user_a",
    action: "ADD_VEHICLE_PHOTO",
    entity: "VehiclePhoto",
    entityId: "ph_1",
    before: { url: SIGNED },
    after: { url: `${PUBLIC_BASE}/${KEY}`, auctionSheetUrl: `${PUBLIC_BASE}/${KEY}`, note: `account ${ACCOUNT} bucket ${BUCKET}` },
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };

  beforeEach(() => {
    fake = createFakePrisma({ relations: { activityLog: { actor: { model: "user", fk: "actorId" } } } });
    state.fake = fake;
    fake.seed("user", { id: "user_a", name: "Actor A", org_id: ORG_A, userType: "STAFF", role: "ADMINISTRATOR", loginEnabled: true });
    fake.seed("activityLog", OLD_ROW, { ...OLD_ROW, id: "log_other_org", org_id: ORG_B, actorId: "user_a" });
  });

  it("listActivityLog returns old rows with every storage reference removed, and the stored row is untouched", async () => {
    const result = await listActivityLog(ORG_A, { page: 1, pageSize: 20 });
    const text = JSON.stringify(result);
    for (const forbidden of [ACCOUNT, BUCKET, "r2.dev", "cloudflarestorage", "X-Amz", "org/org_test_a", KEY, "front.jpg"]) expect(text, forbidden).not.toContain(forbidden);
    expect(result.rows[0]).toMatchObject({ id: "log_old", action: "ADD_VEHICLE_PHOTO", entityId: "ph_1", before: { url: ADDRESS_REMOVED }, after: { url: ADDRESS_REMOVED } });
    expect(result.rows[0]?.createdAt).toEqual(OLD_ROW.createdAt);
    // history is not rewritten
    expect(fake.rows("activityLog")[0]).toMatchObject({ before: { url: SIGNED }, after: { url: `${PUBLIC_BASE}/${KEY}` } });
  });

  it("GET /api/v1/activity-log (administrators only) is redacted too, and nothing from another org appears", async () => {
    const app = await buildApp({ rateLimit: false });
    try {
      const headers = { authorization: `Bearer ${await signAccessToken({ sub: "user_a", orgId: ORG_A, role: "ADMINISTRATOR", name: "Actor A", email: null })}` };
      const res = await app.inject({ method: "GET", url: "/api/v1/activity-log", headers });
      expect(res.statusCode).toBe(200);
      for (const forbidden of [ACCOUNT, BUCKET, "r2.dev", "cloudflarestorage", "X-Amz", KEY, "log_other_org"]) expect(res.body, forbidden).not.toContain(forbidden);
      expect(res.json().data.rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
