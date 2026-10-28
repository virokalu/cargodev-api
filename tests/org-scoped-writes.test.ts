// Defence in depth for writes: every write carries org_id in its OWN where clause (not only in the read before it).
//  1. A static scan of src/: every update/updateMany/delete/deleteMany/upsert names org_id (or the vehicle's org_id), except the
//     two credential lookups that are keyed by a secret.
//  2. The in-memory database used by ALL unit tests refuses an unscoped write, so a removed org_id fails the tests that run it.
//  3. With the org-scoped read deliberately made WRONG (it hands back another org's row), the write still changes nothing and the
//     answer is a 404. Fake data only.

import { readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { actor, ORG_A, ORG_B } from "./helpers/fixtures.js";
import { newVehicleFake, vehicleRow } from "./helpers/vehicle-fixtures.js";
import { isScoped, orgModelsFromSchema, scanDirectory, scanSource, sourceFiles, type ScannedCall } from "./helpers/org-scan.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));

import { deleteFaq, updateFaq } from "../src/services/faq.service.js";
import { deleteVehicleDocument, deleteVehiclePhoto } from "../src/services/file.service.js";
import { renameBrand } from "../src/services/lookup.service.js";
import { renameCustomer } from "../src/services/customer.service.js";
import { setStaffActive } from "../src/services/user.service.js";
import { registerDeviceToken, unregisterDeviceToken } from "../src/services/device-token.service.js";

// The fake's client is typed loosely on purpose; tests reach into its tables by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (fake: FakePrisma): any => fake.client;

// ---------------------------------------------------------------------------------------------
describe("static scan: every query on an org table names org_id in its own where clause", () => {
  const orgModels = orgModelsFromSchema();
  const calls = scanDirectory("src");
  const label = (c: ScannedCall) => `${c.file} ${c.model}.${c.method} @${c.line}`;

  // Reads that are scoped another way, each with the reason. Everything else must name org_id at the top level of its where.
  // (None today: keep it that way, and say why when adding one.)
  // Keyed by "<file> <model>". Photos and documents have no org column; every read of them below is keyed by a vehicle id that the
  // same function has already verified for this org (getOwnedVehicle, or a vehicle list that is itself filtered by org_id).
  const VEHICLE_CHECKED = "keyed by a vehicle id verified for this org in the same function";
  const READ_EXCEPTIONS: Record<string, string> = {
    "src/services/customer-data.service.ts vehiclePhoto": VEHICLE_CHECKED,
    "src/services/customer-data.service.ts vehicleDocument": VEHICLE_CHECKED,
    "src/services/customer-file-access.service.ts vehiclePhoto": "authorised by the customer's own vehicle check in the same function (tests/storage-signing.test.ts: IDOR cases)",
    "src/services/customer-file-access.service.ts vehicleDocument": "authorised by the customer's own vehicle check in the same function (tests/storage-signing.test.ts: IDOR cases)",
    "src/services/file.service.ts vehiclePhoto": VEHICLE_CHECKED,
    "src/services/file.service.ts vehicleDocument": VEHICLE_CHECKED,
    "src/services/vehicle-release.service.ts vehiclePhoto": VEHICLE_CHECKED,
    "src/services/vehicle-release.service.ts vehicleDocument": VEHICLE_CHECKED,
    "src/services/stock.service.ts stockImage": "an image KEY is unique across every org on purpose: 'this image is already in use' must see other orgs' rows",
  };
  const excepted = (c: ScannedCall) => `${c.file} ${c.model}` in READ_EXCEPTIONS;

  it("finds the calls, in every folder of src/ (a new file is picked up automatically)", () => {
    expect(calls.length).toBeGreaterThan(150);
    expect(calls.filter((c) => c.isWrite).length).toBeGreaterThan(60);
    const folders = new Set(calls.map((c) => c.file.split("/").slice(0, 2).join("/")));
    expect(folders).toContain("src/services");
    // The scan walks src/ recursively with no file list: every .ts file is read, so a file added tomorrow is covered.
    expect(sourceFiles("src").length).toBe(readdirSync("src", { recursive: true }).filter((f) => String(f).endsWith(".ts")).length);
  });

  it("every update, updateMany, delete, deleteMany and upsert on an org table names org_id at the top level of its where", () => {
    const unscoped = calls.filter((c) => c.isWrite && !isScoped(c, orgModels)).map(label);
    expect(unscoped, `Writes whose own where clause lacks org_id:\n${unscoped.join("\n")}`).toEqual([]);
  });

  it("every findMany, findFirst, count, groupBy and aggregate on an org table does too", () => {
    const unscoped = calls.filter((c) => !c.isWrite && !isScoped(c, orgModels) && !excepted(c)).map(label);
    expect(unscoped, `Reads whose own where clause lacks org_id:\n${unscoped.join("\n")}`).toEqual([]);
  });

  it("the lookup renames get org_id from the extended unique where (id and org_id together)", () => {
    const renames = calls.filter((c) => c.file.endsWith("lookup.service.ts") && c.method === "update");
    expect(renames.length).toBe(11);
    for (const r of renames) expect(r.where, label(r)).toMatch(/\{\s*id,\s*org_id:\s*actor\.orgId/);
  });

  describe("the scanner itself (synthetic code)", () => {
    const scan = (code: string, model = "faq") => scanSource(code, "src/services/new-file.ts").map((c) => isScoped({ ...c, model }, new Set(["faq", "user"])));
    it.each([
      ["updateMany without org_id", "await tx.faq.updateMany({ where: { id }, data: {} });", [false]],
      ["deleteMany without org_id", "await tx.faq.deleteMany({ where: { id: { in: ids } } });", [false]],
      ["update by id only", "await tx.faq.update({ where: { id }, data: {} });", [false]],
      ["delete by id only", "await tx.faq.delete({ where: { id } });", [false]],
      ["a write with no where at all", "await tx.faq.updateMany({ data: {} });", [false]],
      ["org_id only as the tail of a value", "await tx.faq.updateMany({ where: { id, ownerId: user.org_id }, data: {} });", [false]],
      ["org_id only inside a relation filter", "await tx.faq.findMany({ where: { id, author: { some: { org_id } } } });", [false]],
      ["org_id only in the data", "await tx.faq.updateMany({ where: { id }, data: { org_id } });", [false]],
      ["a spread of a variable", "await tx.faq.updateMany({ where: { ...scope, id }, data: {} });", [false]],
      ["a where that is a bare variable", "await tx.faq.deleteMany({ where });", [false]],
      ["a read without org_id", "await getPrisma().faq.findMany({ where: { published: true } });", [false]],
      ["a count without org_id", "await prisma.faq.count({ where: { published: true } });", [false]],
      ["org_id as a key", "await tx.faq.updateMany({ where: { id, org_id: actor.orgId }, data: {} });", [true]],
      ["org_id as shorthand", "await tx.faq.deleteMany({ where: { id, org_id } });", [true]],
      ["a read with org_id", "await getPrisma().faq.findFirst({ where: { org_id: orgId } });", [true]],
      ["a ternary of objects that both name org_id", "await tx.faq.updateMany({ where: ids ? { org_id: o, id: { in: ids } } : { org_id: o }, data: {} });", [true]],
      ["a credential lookup", "await tx.faq.updateMany({ where: { tokenHash, revokedAt: null }, data: {} });", [true]],
      ["a nested where is not the call's own", "await tx.faq.findMany({ where: { org_id: o, items: { some: { where: { id } } } } });", [true]],
      ["two calls in one file are judged separately", "await tx.faq.deleteMany({ where: { org_id: o } });\nawait tx.faq.deleteMany({ where: { id } });", [true, false]],
    ])("%s", (_name, code, expected) => {
      expect(scan(code as string)).toEqual(expected);
    });

    it("a table without an org column and not photos or documents is not judged", () => {
      expect(scanSource("await tx.statusHistory.create({ data: {} }); await tx.statusHistory.findMany({ where: { vehicleId } });", "x.ts").map((c) => isScoped(c, new Set(["faq"])))).toEqual([true]);
    });

    it("photos and documents must be scoped through the vehicle", () => {
      const ok = scanSource("await tx.vehiclePhoto.deleteMany({ where: { id, vehicleId, vehicle: { org_id: o } } });", "x.ts")[0]!;
      const bad = scanSource("await tx.vehiclePhoto.deleteMany({ where: { id, vehicleId } });", "x.ts")[0]!;
      expect(isScoped(ok, new Set())).toBe(true);
      expect(isScoped(bad, new Set())).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe("the test database refuses an unscoped write", () => {
  let fake: FakePrisma;
  beforeEach(() => {
    fake = createFakePrisma();
    fake.seed("faq", { id: "faq_1", org_id: ORG_A, question: "q", answer: "a", sortOrder: 0, published: true });
  });
  const faq = () => db(fake).faq as Record<string, (args: unknown) => Promise<unknown>>;

  it.each([
    ["update", { where: { id: "faq_1" }, data: { question: "x" } }],
    ["updateMany", { where: { id: "faq_1" }, data: { question: "x" } }],
    ["delete", { where: { id: "faq_1" } }],
    ["deleteMany", { where: { id: "faq_1" } }],
  ])("%s without org_id throws", async (method, args) => {
    await expect(faq()[method]!(args)).rejects.toThrow(/no org_id in its own where clause/);
    expect(fake.rows("faq")).toHaveLength(1);
  });

  it("the same writes with org_id are accepted", async () => {
    await expect(faq()["updateMany"]!({ where: { id: "faq_1", org_id: ORG_A }, data: { question: "x" } })).resolves.toEqual({ count: 1 });
    await expect(faq()["deleteMany"]!({ where: { id: "faq_1", org_id: ORG_A } })).resolves.toEqual({ count: 1 });
  });

  it("a write on another org's id matches nothing and changes nothing", async () => {
    await expect(faq()["updateMany"]!({ where: { id: "faq_1", org_id: ORG_B }, data: { question: "hacked" } })).resolves.toEqual({ count: 0 });
    expect(fake.rows("faq")[0]?.["question"]).toBe("q");
  });

  it("photos and documents (no org column) must be scoped through the vehicle", async () => {
    const v = newVehicleFake();
    const photo = db(v).vehiclePhoto as Record<string, (args: unknown) => Promise<unknown>>;
    await expect(photo["deleteMany"]!({ where: { id: "p1", vehicleId: "veh" } })).rejects.toThrow(/no org_id/);
    await expect(photo["deleteMany"]!({ where: { id: "p1", vehicleId: "veh", vehicle: { org_id: ORG_A } } })).resolves.toEqual({ count: 0 });
  });

  it("the credential lookups are the only exception", async () => {
    const tokens = db(fake).refreshToken as Record<string, (args: unknown) => Promise<unknown>>;
    await expect(tokens["updateMany"]!({ where: { tokenHash: "h", revokedAt: null }, data: { revokedAt: new Date() } })).resolves.toEqual({ count: 0 });
    await expect(tokens["updateMany"]!({ where: { id: "rt_1" }, data: { revokedAt: new Date() } })).rejects.toThrow(/no org_id/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("with the org-scoped read made WRONG, the write still changes nothing (404)", () => {
  const actorA = actor();

  describe("faq", () => {
    let fake: FakePrisma;
    beforeEach(() => {
      fake = createFakePrisma();
      state.fake = fake;
      fake.seed("faq", { id: "faq_b", org_id: ORG_B, question: "keep me", answer: "a", sortOrder: 0, published: true });
      // The read lies: it returns the other org's row as if it were this org's.
      vi.spyOn(db(fake).faq, "findFirst").mockResolvedValue({ id: "faq_b", question: "keep me", answer: "a", sortOrder: 0, published: true } as never);
    });

    it("updateFaq", async () => {
      await expect(updateFaq(actorA, "faq_b", { question: "hacked" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fake.rows("faq")[0]?.["question"]).toBe("keep me");
      expect(fake.rows("activityLog")).toHaveLength(0);
    });

    it("deleteFaq", async () => {
      await expect(deleteFaq(actorA, "faq_b")).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fake.rows("faq")).toHaveLength(1);
      expect(fake.rows("activityLog")).toHaveLength(0);
    });
  });

  describe("lookup rename", () => {
    it("renameBrand: another org's brand is not renamed, and no activity row is written", async () => {
      const fake = createFakePrisma();
      state.fake = fake;
      fake.seed("brand", { id: "brand_b", org_id: ORG_B, name: "Keep" });
      const real = db(fake).brand.findUnique.bind(db(fake).brand);
      vi.spyOn(db(fake).brand, "findUnique").mockImplementation(async (args: unknown) => {
        const row = (await real(args)) as { org_id: string } | null;
        return row ? ({ ...row, org_id: ORG_A } as never) : null; // the read says it is this org's
      });
      await expect(renameBrand(actorA, "brand_b", "Hacked")).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fake.rows("brand")[0]?.["name"]).toBe("Keep");
      expect(fake.rows("activityLog")).toHaveLength(0);
    });
  });

  describe("customer and staff accounts", () => {
    it("renameCustomer", async () => {
      const fake = createFakePrisma();
      state.fake = fake;
      fake.seed("user", { id: "cust_b", org_id: ORG_B, userType: "CUSTOMER", name: "Keep", email: "b@example.test", role: null });
      vi.spyOn(db(fake).user, "findUnique").mockResolvedValue({ id: "cust_b", org_id: ORG_A, userType: "CUSTOMER", name: "Keep" } as never);
      await expect(renameCustomer(actorA, "cust_b", "Hacked")).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fake.rows("user")[0]?.["name"]).toBe("Keep");
      expect(fake.rows("activityLog")).toHaveLength(0);
    });

    it("setStaffActive (the staff row of another org is not deactivated)", async () => {
      const fake = createFakePrisma();
      state.fake = fake;
      fake.seed("user", { id: "staff_b", org_id: ORG_B, userType: "STAFF", name: "Keep", email: "sb@example.test", role: "MANAGER", loginEnabled: true });
      vi.spyOn(db(fake).user, "findUnique").mockResolvedValue({ id: "staff_b", org_id: ORG_A, userType: "STAFF", name: "Keep", role: "MANAGER", loginEnabled: true } as never);
      await expect(setStaffActive(actor({ role: "ADMINISTRATOR", name: "Administrator" }), "staff_b", false)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fake.rows("user")[0]?.["loginEnabled"]).toBe(true);
      expect(fake.rows("activityLog")).toHaveLength(0);
    });
  });

  describe("vehicle files", () => {
    let fake: FakePrisma;
    beforeEach(() => {
      fake = newVehicleFake();
      state.fake = fake;
      // This org's vehicle, and a photo and document that belong to ANOTHER org's vehicle.
      fake.seed("vehicle", vehicleRow({ id: "veh_a", org_id: ORG_A, serial: "FC1" }), vehicleRow({ id: "veh_b", org_id: ORG_B, serial: "FC2" }));
      fake.seed("vehiclePhoto", { id: "ph_b", vehicleId: "veh_b", url: "https://x.example.test/p.jpg", visibleToCustomer: false, uploadedById: "u" });
      fake.seed("vehicleDocument", { id: "doc_b", vehicleId: "veh_b", url: "https://x.example.test/d.pdf", name: "d", documentType: "OTHER", visibleToCustomer: false, uploadedById: "u" });
    });

    it("deleteVehiclePhoto: the photo read lies, the delete (scoped through the vehicle) removes nothing", async () => {
      vi.spyOn(db(fake).vehiclePhoto, "findFirst").mockResolvedValue({ id: "ph_b", vehicleId: "veh_a", url: "https://x.example.test/p.jpg" } as never);
      await expect(deleteVehiclePhoto(actorA, "veh_a", "ph_b")).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fake.rows("vehiclePhoto")).toHaveLength(1);
      expect(fake.rows("activityLog")).toHaveLength(0);
    });

    it("deleteVehicleDocument: same", async () => {
      vi.spyOn(db(fake).vehicleDocument, "findFirst").mockResolvedValue({ id: "doc_b", vehicleId: "veh_a", url: "https://x.example.test/d.pdf", name: "d" } as never);
      await expect(deleteVehicleDocument(actorA, "veh_a", "doc_b")).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fake.rows("vehicleDocument")).toHaveLength(1);
      expect(fake.rows("activityLog")).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe("device tokens (keyed by the token, still scoped by org and user)", () => {
  const EXPO = "ExponentPushToken[abcdefghijklmnopqrstuv]";

  it("a registered token is stored in the registering user's org", async () => {
    const fake = createFakePrisma();
    state.fake = fake;
    await registerDeviceToken(ORG_A, "user_1", { expoPushToken: EXPO, platform: "ios" });
    expect(fake.rows("deviceToken")).toHaveLength(1);
    expect(fake.rows("deviceToken")[0]).toMatchObject({ org_id: ORG_A, userId: "user_1", expoPushToken: EXPO });
  });

  it("unregistering from another org (even with the same user id) removes nothing; from the right org it removes the row", async () => {
    const fake = createFakePrisma();
    state.fake = fake;
    await registerDeviceToken(ORG_A, "user_1", { expoPushToken: EXPO, platform: "ios" });
    await unregisterDeviceToken(ORG_B, "user_1", { expoPushToken: EXPO });
    expect(fake.rows("deviceToken")).toHaveLength(1);
    await unregisterDeviceToken(ORG_A, "user_1", { expoPushToken: EXPO });
    expect(fake.rows("deviceToken")).toHaveLength(0);
  });
});
