// Own-domain file links against real Postgres: revocation is immediate because every fetch asks the database again (the relation filters,
// the soft delete, the release flags, the staff and customer account checks). Fake data only.

import { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";
import { minimalVehicle, ORG_A, ORG_B, seedTwoOrgs } from "./helpers/seed.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { setObjectStore, type ObjectStore } from "../../src/lib/object-storage.js";
import { clearStaffAuthCache } from "../../src/services/staff-auth-state.service.js";
import { issueFileLink } from "../../src/services/file-link.service.js";
import { setStaffActive } from "../../src/services/user.service.js";

const prisma = getTestPrisma();
const BASE = "https://files.example.test";
const key = (org: string, vehicle: string, folder: string, name: string) => `org/${org}/vehicles/${vehicle}/${folder}/${name}`;
const PHOTO = Buffer.from("db-photo-bytes");
const reads: string[] = [];
const store: ObjectStore = {
  presignPut: async () => "https://upload.example.test/x",
  getObject: async ({ key: k }) => {
    reads.push(k);
    return k.endsWith("missing.jpg") ? { kind: "missing" } : { kind: "found", body: Readable.from([PHOTO]), contentLength: PHOTO.length, etag: '"e"' };
  },
  putObject: async () => undefined,
  deleteKey: async () => undefined,
};

let app: FastifyInstance;
let vehicleId: string;
let photoId: string;
let hiddenPhotoId: string;
let docId: string;
let otherOrgPhotoId: string;
const admin = { id: "staff_admin", role: "ADMINISTRATOR" as const, orgId: ORG_A, name: "Administrator", email: null };

const open = (url: string) => {
  const u = new URL(url);
  return app.inject({ method: "GET", url: `${u.pathname}${u.search}` });
};
const staffLink = (kind: "photo" | "document" | "auction-sheet", id: string, user = "staff_mgr", org = ORG_A) =>
  issueFileLink({ orgId: org, userId: user, audience: "staff" }, kind, id, "full")!.url;
const customerLink = (kind: "photo" | "document", id: string, user = "cust_1") =>
  issueFileLink({ orgId: ORG_A, userId: user, audience: "customer" }, kind, id, "full")!.url;

beforeEach(async () => {
  await resetDb(prisma);
  await seedTwoOrgs(prisma);
  clearStaffAuthCache();
  reads.length = 0;
  await prisma.user.createMany({
    data: [
      { id: "staff_admin", org_id: ORG_A, userType: "STAFF", name: "Administrator", role: "ADMINISTRATOR", loginEnabled: true, email: "admin@example.test" },
      { id: "staff_mgr", org_id: ORG_A, userType: "STAFF", name: "Manager", role: "MANAGER", loginEnabled: true, email: "mgr@example.test" },
      { id: "staff_off", org_id: ORG_A, userType: "STAFF", name: "Off", role: "MANAGER", loginEnabled: false, email: "off@example.test" },
      { id: "staff_b", org_id: ORG_B, userType: "STAFF", name: "Other", role: "MANAGER", loginEnabled: true, email: "b@example.test" },
      { id: "cust_1", org_id: ORG_A, userType: "CUSTOMER", name: "Buyer One", email: "c1@example.test", password: "x-hash", emailVerifiedAt: new Date("2026-01-01"), loginEnabled: true },
      { id: "cust_2", org_id: ORG_A, userType: "CUSTOMER", name: "Buyer Two", email: "c2@example.test", password: "x-hash", emailVerifiedAt: new Date("2026-01-01"), loginEnabled: true },
    ],
  });
  const vehicle = await prisma.vehicle.create({
    data: minimalVehicle(ORG_A, 1, { customerId: "cust_1", customerVisible: true, auctionSheetUrl: `${BASE}/${key(ORG_A, "VEH", "auction-sheet", "s.jpg")}` }),
  });
  vehicleId = vehicle.id;
  await prisma.vehicle.update({ where: { id: vehicleId }, data: { auctionSheetUrl: `${BASE}/${key(ORG_A, vehicleId, "auction-sheet", "s.jpg")}` } });
  photoId = (await prisma.vehiclePhoto.create({ data: { vehicleId, url: `${BASE}/${key(ORG_A, vehicleId, "photos", "a.jpg")}`, uploadedById: "staff_mgr", visibleToCustomer: true } })).id;
  hiddenPhotoId = (await prisma.vehiclePhoto.create({ data: { vehicleId, url: `${BASE}/${key(ORG_A, vehicleId, "photos", "b.jpg")}`, uploadedById: "staff_mgr", visibleToCustomer: false } })).id;
  docId = (await prisma.vehicleDocument.create({ data: { vehicleId, url: `${BASE}/${key(ORG_A, vehicleId, "documents", "bl.pdf")}`, name: "BL", documentType: "BL", uploadedById: "staff_mgr", visibleToCustomer: true } })).id;
  const otherVehicle = await prisma.vehicle.create({ data: minimalVehicle(ORG_B, 2) });
  otherOrgPhotoId = (await prisma.vehiclePhoto.create({ data: { vehicleId: otherVehicle.id, url: `${BASE}/org/${ORG_B}/vehicles/${otherVehicle.id}/photos/z.jpg`, uploadedById: "staff_b" } })).id;
  setObjectStore(store);
  app = await buildApp({ rateLimit: false });
});
afterEach(async () => {
  await app.close();
  setObjectStore(null);
});
afterAll(async () => {
  await closeTestPrisma();
});

describe("staff links against real rows", () => {
  it("open for a photo, a document and the auction sheet of the user's own org", async () => {
    expect((await open(staffLink("photo", photoId))).statusCode).toBe(200);
    expect((await open(staffLink("document", docId))).statusCode).toBe(200);
    expect((await open(staffLink("auction-sheet", vehicleId))).statusCode).toBe(200);
  });

  it("another org's file is a 404 for this org's staff (the relation filter in SQL), and the store is never asked", async () => {
    expect((await open(staffLink("photo", otherOrgPhotoId))).statusCode).toBe(404);
    expect(reads).toEqual([]);
  });

  it("a staff user of another org holding a link signed for this org's file gets a 404", async () => {
    expect((await open(staffLink("photo", photoId, "staff_b"))).statusCode).toBe(404);
    expect((await open(staffLink("photo", photoId, "staff_b", ORG_B))).statusCode).toBe(404);
  });

  it("deactivating the staff user (through the service, with a long cache) revokes a link already issued, at once", async () => {
    const url = staffLink("photo", photoId);
    expect((await open(url)).statusCode).toBe(200);
    await setStaffActive(admin, "staff_mgr", false);
    expect((await open(url)).statusCode).toBe(404);
    await setStaffActive(admin, "staff_mgr", true);
    expect((await open(url)).statusCode).toBe(200);
  });

  it("a user who was never active, and an unknown user, get a 404", async () => {
    expect((await open(staffLink("photo", photoId, "staff_off"))).statusCode).toBe(404);
    expect((await open(staffLink("photo", photoId, "staff_nobody"))).statusCode).toBe(404);
  });

  it("soft-deleting the vehicle revokes the photo, the document and the sheet; restoring brings them back", async () => {
    const urls = [staffLink("photo", photoId), staffLink("document", docId), staffLink("auction-sheet", vehicleId)];
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { deletedAt: new Date() } });
    for (const url of urls) expect((await open(url)).statusCode).toBe(404);
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { deletedAt: null } });
    for (const url of urls) expect((await open(url)).statusCode).toBe(200);
  });

  it("deleting the photo row revokes its link", async () => {
    const url = staffLink("photo", photoId);
    await prisma.vehiclePhoto.delete({ where: { id: photoId } });
    expect((await open(url)).statusCode).toBe(404);
  });

  it("a stored address that points elsewhere (an old row) is a 404", async () => {
    await prisma.vehiclePhoto.update({ where: { id: photoId }, data: { url: "https://evil.test/a.jpg" } });
    expect((await open(staffLink("photo", photoId))).statusCode).toBe(404);
  });

  it("an object that is gone from storage is a 404", async () => {
    await prisma.vehiclePhoto.update({ where: { id: photoId }, data: { url: `${BASE}/${key(ORG_A, vehicleId, "photos", "missing.jpg")}` } });
    expect((await open(staffLink("photo", photoId))).statusCode).toBe(404);
  });
});

describe("customer links against real rows: revocation is immediate", () => {
  it("opens the customer's own released photo and document, and not an unreleased photo", async () => {
    expect((await open(customerLink("photo", photoId))).statusCode).toBe(200);
    expect((await open(customerLink("document", docId))).statusCode).toBe(200);
    expect((await open(customerLink("photo", hiddenPhotoId))).statusCode).toBe(404);
  });

  it("another customer's link for this customer's photo is a 404", async () => {
    expect((await open(customerLink("photo", photoId, "cust_2"))).statusCode).toBe(404);
  });

  it("un-releasing the photo (visibleToCustomer false) revokes a link already issued; releasing it again restores it", async () => {
    const url = customerLink("photo", photoId);
    expect((await open(url)).statusCode).toBe(200);
    await prisma.vehiclePhoto.update({ where: { id: photoId }, data: { visibleToCustomer: false } });
    expect((await open(url)).statusCode).toBe(404);
    await prisma.vehiclePhoto.update({ where: { id: photoId }, data: { visibleToCustomer: true } });
    expect((await open(url)).statusCode).toBe(200);
  });

  it.each([
    ["the vehicle is no longer released", { customerVisible: false }],
    ["the vehicle is unlinked from the customer", { customerId: "cust_2" }],
    ["the vehicle is converted to local", { serialPrefix: "FL" as const }],
    ["the vehicle is soft-deleted", { deletedAt: new Date() }],
  ])("%s", async (_label, change) => {
    const url = customerLink("document", docId);
    expect((await open(url)).statusCode).toBe(200);
    await prisma.vehicle.update({ where: { id: vehicleId }, data: change });
    expect((await open(url)).statusCode).toBe(404);
  });

  it.each([
    ["is disabled", { loginEnabled: false }],
    ["is deleted", { deletedAt: new Date() }],
    ["is no longer verified", { emailVerifiedAt: null }],
    ["has no password", { password: null }],
  ])("a customer link stops when the account %s", async (_label, change) => {
    const url = customerLink("photo", photoId);
    expect((await open(url)).statusCode).toBe(200);
    await prisma.user.update({ where: { id: "cust_1" }, data: change });
    expect((await open(url)).statusCode).toBe(404);
  });

  it("a customer never gets an auction sheet", async () => {
    const url = issueFileLink({ orgId: ORG_A, userId: "cust_1", audience: "customer" }, "auction-sheet", vehicleId, "full")!.url;
    expect((await open(url)).statusCode).toBe(404);
  });
});
