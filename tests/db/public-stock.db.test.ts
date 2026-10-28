// The public stock API and the staff stock tools on real Postgres: filters with NULL and case, Decimal prices, sorting,
// the unique slug, the image cascade, and a status change that two staff members make at once. Fake data only.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});
vi.mock("../../src/lib/expo-push.js", () => ({ sendExpoPushNotifications: vi.fn().mockResolvedValue(undefined) }));

import { createEnquiry } from "../../src/services/enquiry.service.js";
import {
  addStockImage,
  createStock,
  deleteStock,
  getPublicStock,
  listPublicStock,
  markStockSold,
  publishStock,
  reorderStockImages,
  unpublishStock,
} from "../../src/services/stock.service.js";
import { orgSegment } from "../../src/lib/public-stock-storage.js";
import { randomUUID } from "node:crypto";

const prisma = getTestPrisma();
const ORG = "org_test_a"; // ORG_ID in tests/db/setup-env.ts: the public API's org
const OTHER = "org_test_b";
const actor = { id: "staff", orgId: ORG, role: "MANAGER" as const, name: "Staff", email: null };

const car = (slug: string, over: Record<string, unknown> = {}) =>
  prisma.stockVehicle.create({
    data: { org_id: ORG, slug, make: "Alpha", model: "One", year: 2020, priceFob: "5000.00", mileageKm: 40000, status: "PUBLISHED", publishedAt: new Date(), ...over },
  });

beforeEach(async () => {
  await resetDb(prisma);
  for (const id of [ORG, OTHER]) await prisma.organization.create({ data: { id, name: id } });
  await prisma.user.createMany({
    data: [
      { id: "staff", org_id: ORG, userType: "STAFF", name: "Staff", role: "MANAGER", loginEnabled: true },
      { id: "staff_b", org_id: OTHER, userType: "STAFF", name: "Staff B", role: "MANAGER", loginEnabled: true },
    ],
  });
});
afterAll(closeTestPrisma);

describe("public reads as SQL", () => {
  it("only PUBLISHED rows of the default org, with the stored Decimal returned as a price in LKR", async () => {
    await car("pub");
    await car("draft", { status: "DRAFT", publishedAt: null });
    await car("sold", { status: "SOLD" });
    await prisma.stockVehicle.create({ data: { org_id: OTHER, slug: "other", make: "Beta", model: "Two", status: "PUBLISHED", publishedAt: new Date() } });
    const list = await listPublicStock({});
    expect(list.rows.map((r) => r.slug)).toEqual(["pub"]);
    expect(list.rows[0]!.price).toEqual({ amount: 5000, currency: "LKR" });
    await expect(getPublicStock("draft")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getPublicStock("other")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a row with no price or mileage never matches a price or mileage range (NULL is not 0)", async () => {
    await car("cheap", { priceFob: "3000", mileageKm: 90000 });
    await car("noprice", { priceFob: null, mileageKm: null });
    expect((await listPublicStock({ priceMax: "4000" })).rows.map((r) => r.slug)).toEqual(["cheap"]);
    expect((await listPublicStock({ priceMin: "0" })).rows.map((r) => r.slug)).toEqual(["cheap"]);
    expect((await listPublicStock({ mileageMax: "100000" })).rows.map((r) => r.slug)).toEqual(["cheap"]);
  });

  it("text filters ignore case and treat wildcards as data", async () => {
    await car("a", { make: "Alpha", model: "Zeta 100%" });
    await car("b", { make: "Beta", model: "Eta" });
    expect((await listPublicStock({ make: "ALPHA" })).rows.map((r) => r.slug)).toEqual(["a"]);
    expect((await listPublicStock({ q: "zeta" })).rows.map((r) => r.slug)).toEqual(["a"]);
    // Prisma passes `contains` into a LIKE pattern unescaped, so the service escapes %, _ and backslash itself.
    await car("hidden", { make: "Secret", model: "Draft 100%", status: "DRAFT", publishedAt: null });
    await car("under", { make: "Gamma", model: "A_B Sport" });
    await car("slash", { make: "Gamma", model: "Back\\slash" });
    const found = async (q: string) => (await listPublicStock({ q })).rows.map((r) => r.slug).sort();
    expect(await found("%")).toEqual(["a"]); // only the published row with a literal percent sign ("Zeta 100%")
    expect(await found("100%")).toEqual(["a"]);
    expect(await found("_")).toEqual(["under"]);
    expect(await found("a_b")).toEqual(["under"]);
    expect(await found("A%B")).toEqual([]);
    expect(await found("\\")).toEqual(["slash"]);
    expect(await found("%%")).toEqual([]);
    expect(await found("draft")).toEqual([]); // the draft is still invisible
    expect((await listPublicStock({ q: "' OR 1=1 --" })).total).toBe(0);
  });

  it("sorts by price with unpriced rows last in both directions of use, and pages without repeats", async () => {
    for (let i = 0; i < 7; i += 1) await car(`c${i}`, { priceFob: i === 3 ? null : String(1000 + i), publishedAt: new Date(2026, 0, i + 1) });
    const ids = async (q: Record<string, string>) => (await listPublicStock(q)).rows.map((r) => r.slug);
    const asc = await ids({ sort: "priceAsc", pageSize: "24" });
    expect(asc.at(-1)).toBe("c3"); // Postgres puts NULL last for ascending order
    const page1 = await ids({ sort: "newest", pageSize: "4", page: "1" });
    const page2 = await ids({ sort: "newest", pageSize: "4", page: "2" });
    expect([...page1, ...page2]).toEqual(["c6", "c5", "c4", "c3", "c2", "c1", "c0"]);
  });
});

describe("staff stock on real SQL", () => {
  it("the slug is unique per org (the database refuses a duplicate), but the same slug can exist in two orgs", async () => {
    await car("same");
    await expect(car("same")).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.stockVehicle.create({ data: { org_id: OTHER, slug: "same", make: "X", model: "Y" } })).resolves.toBeTruthy();
  });

  it("images are deleted with their listing (cascade), listings of other orgs untouched", async () => {
    const mine = await createStock(actor, { make: "A", model: "B" });
    const key = `stock/${orgSegment(ORG)}/${randomUUID()}.jpg`;
    await addStockImage(actor, mine.id, { key });
    const other = await prisma.stockVehicle.create({ data: { org_id: OTHER, slug: "o", make: "O", model: "O" } });
    await prisma.stockImage.create({ data: { org_id: OTHER, stockVehicleId: other.id, key: "stock/bbbbbbbbbbbbbbbb/x.jpg" } });
    await deleteStock(actor, mine.id);
    expect(await prisma.stockImage.count()).toBe(1);
    expect(await prisma.stockVehicle.count()).toBe(1);
  });

  it("two staff publishing the same draft at once: one succeeds, the other gets a conflict, one log row", async () => {
    const draft = await createStock(actor, { make: "A", model: "B" });
    await addStockImage(actor, draft.id, { key: `stock/${orgSegment(ORG)}/${randomUUID()}.jpg` });
    const results = await Promise.allSettled([publishStock(actor, draft.id, {}), publishStock(actor, draft.id, {}), publishStock(actor, draft.id, {}), publishStock(actor, draft.id, {})]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason?.code === "CONFLICT")).toBe(true);
    expect(await prisma.activityLog.count({ where: { action: "PUBLISH_STOCK" } })).toBe(1);
  });

  it("sell and unpublish race: the listing always ends in one valid state with exactly the log rows of the changes that applied", async () => {
    const draft = await createStock(actor, { make: "A", model: "B" });
    await addStockImage(actor, draft.id, { key: `stock/${orgSegment(ORG)}/${randomUUID()}.jpg` });
    await publishStock(actor, draft.id, {});
    const results = await Promise.allSettled([markStockSold(actor, draft.id, {}), unpublishStock(actor, draft.id, {})]);
    const applied = results.filter((r) => r.status === "fulfilled").length;
    expect(applied).toBeGreaterThanOrEqual(1);
    const final = await prisma.stockVehicle.findUniqueOrThrow({ where: { id: draft.id } });
    expect(["SOLD", "DRAFT"]).toContain(final.status);
    expect((await prisma.activityLog.count({ where: { action: { in: ["MARK_STOCK_SOLD", "UNPUBLISH_STOCK"] } } }))).toBe(applied);
  });

  it("reordering sets a dense, repeat-free order", async () => {
    const stock = await createStock(actor, { make: "A", model: "B" });
    for (let i = 0; i < 4; i += 1) await addStockImage(actor, stock.id, { key: `stock/${orgSegment(ORG)}/${randomUUID()}.jpg` });
    const ids = (await prisma.stockImage.findMany({ where: { stockVehicleId: stock.id }, orderBy: { sortOrder: "asc" } })).map((i) => i.id);
    const shuffled = [ids[2]!, ids[0]!, ids[3]!, ids[1]!];
    const result = await reorderStockImages(actor, stock.id, { imageIds: shuffled });
    expect(result.images.map((i) => i.id)).toEqual(shuffled);
    expect(result.images.map((i) => i.sortOrder)).toEqual([0, 1, 2, 3]);
  });
});

describe("enquiries on real SQL", () => {
  it("are stored for the default org with the listing dropped if it is not published, and staff are alerted without the text", async () => {
    await car("live");
    await createEnquiry({ name: "Visitor", email: "V@Example.test", message: "Is it available?", stockSlug: "live" }, {});
    await createEnquiry({ name: "Visitor Two", email: "v2@example.test", message: "Another one", stockSlug: "no-such" }, {});
    const rows = await prisma.enquiry.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.org_id, r.email, r.stockSlug])).toEqual([[ORG, "v@example.test", "live"], [ORG, "v2@example.test", null]]);
    const alerts = await prisma.notification.findMany({ where: { event: "ENQUIRY_RECEIVED" } });
    expect(alerts.map((a) => a.userId)).toEqual(["staff", "staff"]);
    expect(JSON.stringify(alerts)).not.toMatch(/available|Another one/);
  });

  it("20 parallel enquiries all land", async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => createEnquiry({ name: `V${i}`, email: `v${i}@example.test`, message: "Hello there" }, {})));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await prisma.enquiry.count()).toBe(20);
  });
});
