// The examples behind docs/staff-frontend-integration.md. Every `example:<id>` block in the doc is produced by the recipe of
// the same id here: it builds fake data, calls the REAL route on a real app, and returns the real response. The contract test
// (tests/staff-frontend-contract.test.ts) compares the doc's JSON with that response, key set for key set.
// Fake data only. Nothing here is real.

import { Readable } from "node:stream";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { FakePrisma } from "./fake-prisma.js";
import { ORG_A } from "./fixtures.js";
import { createFakePrisma } from "./fake-prisma.js";
import { seedVehicleWorld, VEHICLE_RELATIONS } from "./vehicle-fixtures.js";
import { signAccessToken } from "../../src/lib/mobile-jwt.js";
import { setObjectStore, type ObjectStore } from "../../src/lib/object-storage.js";
import { orgSegment, setPublicStockStore } from "../../src/lib/public-stock-storage.js";

export type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
export const USER_OF: Record<Role, string> = { ADMINISTRATOR: "staff_admin", MANAGER: "staff_mgr", OPERATOR: "staff_op", VIEWER: "staff_vw" };
/** The password of every seeded staff account (built at runtime so no secret-looking literal sits in the source). */
export const STAFF_PASSWORD = ["example", "Staff", "Password", "12345"].join("-");
const HASH = bcrypt.hashSync(STAFF_PASSWORD, 4);

type Row = Record<string, unknown>;
const at = (iso: string) => new Date(iso);

/** Keys of the objects the fake storage "holds" (registering a file by key checks that the object exists). */
export const UPLOADED = new Map<string, number>();

const store: ObjectStore = {
  presignPut: async ({ key }) => `https://storage.example.test/bucket/${key}?X-Signature=example`,
  getObject: async ({ key }) => {
    const size = UPLOADED.get(key);
    if (size === undefined) return { kind: "missing" };
    return { kind: "found", body: Readable.from([Buffer.from("x")]), contentLength: size, etag: null };
  },
  putObject: async () => undefined,
  deleteKey: async () => undefined,
};

export function installFakeStorage(): void {
  setObjectStore(store);
  setPublicStockStore(store);
}
export function removeFakeStorage(): void {
  setObjectStore(null);
  setPublicStockStore(null);
}

export const photoKey = (name = "front.jpg") => `org/${ORG_A}/vehicles/v_fc_booked_future/photos/${name}`;
export const docKey = (name = "bl.pdf") => `org/${ORG_A}/vehicles/v_fc_booked_future/documents/${name}`;
export const sheetKey = (name = "sheet.jpg") => `org/${ORG_A}/vehicles/v_fc_booked_future/auction-sheet/${name}`;
// Stock images live in the PUBLIC bucket under stock/<org segment>/<uuid>.<ext>.
export const stockKey = (n = 1) => `stock/${orgSegment(ORG_A)}/0000000${n}-0000-4000-8000-000000000000.jpg`;

const staff = (id: string, role: Role, name: string, over: Row = {}): Row => ({
  id, org_id: ORG_A, userType: "STAFF", role, name, email: `${id.replace("staff_", "")}@example.test`, phone: "0770000000",
  password: HASH, loginEnabled: true, failedLoginAttempts: 0, lockoutUntil: null, lastActiveAt: at("2026-10-30T09:00:00Z"),
  createdAt: at("2026-01-01T00:00:00Z"), ...over,
});

/** The world every example starts from: the shared vehicle fake plus one staff account per role and a little of everything. */
export function newContractWorld(): FakePrisma {
  UPLOADED.clear();
  const fake = createFakePrisma({ relations: { ...VEHICLE_RELATIONS, activityLog: { actor: { model: "user", fk: "actorId" } } } as never });
  seedVehicleWorld(fake);
  fake.seed("serialCounter", { org_id: ORG_A, prefix: "FC", lastNumber: 109 }, { org_id: ORG_A, prefix: "FL", lastNumber: 202 });
  fake.seed(
    "user",
    staff("staff_admin", "ADMINISTRATOR", "Administrator", { email: "admin@example.test" }),
    staff("staff_mgr", "MANAGER", "Example Manager", { email: "manager@example.test" }),
    staff("staff_op", "OPERATOR", "Example Operator", { email: "operator@example.test" }),
    staff("staff_vw", "VIEWER", "Example Viewer", { email: "viewer@example.test" }),
    { id: "cust_1", org_id: ORG_A, userType: "CUSTOMER", name: "Alpha Buyer", email: "alpha.buyer@example.test", phone: "0771111111", country: "LK", address: "1 Example Road", companyName: null, assignedAgentId: "staff_op", loginEnabled: true, password: HASH, emailVerifiedAt: at("2026-01-01T00:00:00Z"), deletedAt: null, createdAt: at("2026-02-01T00:00:00Z"), lastActiveAt: new Date() }
  );
  fake.seed("notification", { id: "n_1", org_id: ORG_A, userId: "staff_mgr", event: "BOOKING_RECEIVED", title: "Booking received", body: "FC102 now has a booking.", isRead: false, vehicleId: "v_fc_booked_future", createdAt: at("2026-10-30T10:00:00Z") });
  fake.seed("vehicleMilestone", { id: "ms_1", org_id: ORG_A, vehicleId: "v_fc_booked_future", type: "BOUGHT", occurredAt: at("2026-10-01T00:00:00Z"), recordedById: "staff_mgr", createdAt: at("2026-10-01T00:00:00Z") });
  fake.seed("vehiclePhoto", { id: "ph_1", vehicleId: "v_fc_booked_future", url: `https://files.example.test/${photoKey()}`, uploadedById: "staff_mgr", createdAt: at("2026-10-02T00:00:00Z"), visibleToCustomer: false });
  fake.seed("vehicleDocument", { id: "doc_1", vehicleId: "v_fc_booked_future", url: `https://files.example.test/${docKey()}`, name: "Bill of lading", documentType: "BL", uploadedById: "staff_mgr", createdAt: at("2026-10-03T00:00:00Z"), visibleToCustomer: false });
  UPLOADED.set(photoKey(), 1000);
  UPLOADED.set(docKey(), 1000);
  UPLOADED.set(photoKey("new.jpg"), 1000);
  UPLOADED.set(docKey("new.pdf"), 1000);
  UPLOADED.set(sheetKey(), 1000);
  fake.seed("faq", { id: "faq_1", org_id: ORG_A, question: "How long does shipping take?", answer: "About four weeks.", sortOrder: 1, published: true, createdAt: at("2026-03-01T00:00:00Z"), updatedAt: at("2026-03-01T00:00:00Z") });
  fake.seed("vehicleLinkRequest", { id: "lr_1", org_id: ORG_A, customerId: "cust_1", serialEntered: "FC104", vehicleId: "v_fc_shipped", status: "PENDING", decidedById: null, decidedAt: null, createdAt: at("2026-10-29T00:00:00Z") });
  fake.seed("conversation", { id: "conv_1", org_id: ORG_A, customerId: "cust_1", vehicleId: "v_fc_pending", lastMessageAt: at("2026-10-30T12:00:00Z"), handledAt: null, handledById: null, createdAt: at("2026-10-30T11:00:00Z") });
  fake.seed("message", { id: "msg_1", org_id: ORG_A, conversationId: "conv_1", senderType: "CUSTOMER", senderId: "cust_1", body: "Where is my vehicle now?", createdAt: at("2026-10-30T12:00:00Z") });
  fake.seed("stockVehicle", { id: "stock_1", org_id: ORG_A, slug: "alpha-one-2020-abc123", make: "Alpha", model: "One", year: 2020, priceFob: 1500000, mileageKm: 42000, bodyType: "Sedan", fuel: "Petrol", transmission: "Automatic", colour: "White", description: "Example listing.", status: "DRAFT", publishedAt: null, createdAt: at("2026-10-20T00:00:00Z"), updatedAt: at("2026-10-20T00:00:00Z") });
  fake.seed("stockImage", { id: "simg_1", org_id: ORG_A, stockVehicleId: "stock_1", key: stockKey(), altText: "Side view", sortOrder: 0, createdAt: at("2026-10-20T00:00:00Z") });
  UPLOADED.set(stockKey(), 1000);
  UPLOADED.set(stockKey(2), 1000);
  fake.seed("stockVehicle", { id: "stock_2", org_id: ORG_A, slug: "beta-two-2019-def456", make: "Beta", model: "Two", year: 2019, priceFob: 1200000, mileageKm: 60000, bodyType: "SUV", fuel: "Diesel", transmission: "Manual", colour: "Blue", description: null, status: "PUBLISHED", publishedAt: at("2026-10-25T00:00:00Z"), createdAt: at("2026-10-24T00:00:00Z"), updatedAt: at("2026-10-25T00:00:00Z") });
  fake.seed("enquiry", { id: "enq_1", org_id: ORG_A, name: "Example Visitor", email: "visitor@example.test", phone: "+94 77 000 0000", message: "Is this still available?", stockSlug: "alpha-one-2020-abc123", handledAt: null, createdAt: at("2026-10-28T00:00:00Z") });
  fake.seed("activityLog", { id: "al_1", org_id: ORG_A, actorId: "staff_mgr", action: "UPDATE_VEHICLE", entity: "Vehicle", entityId: "v_fc_booked_future", before: { destination: "Country One" }, after: { destination: "Country Two" }, createdAt: at("2026-10-30T08:00:00Z") });
  fake.seed("deviceToken", { id: "dt_1", org_id: ORG_A, userId: "staff_mgr", expoPushToken: "ExponentPushToken[example-old]", platform: "ios", lastSeenAt: at("2026-10-30T00:00:00Z"), createdAt: at("2026-10-30T00:00:00Z"), appVersion: null });
  return fake;
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: unknown;
}

export interface Ctx {
  app: FastifyInstance;
  fake: FakePrisma;
  /** Calls a route as a role (or with no token when `as` is null). */
  call(as: Role | null, method: string, url: string, payload?: unknown, extraHeaders?: Record<string, string>): Promise<Reply>;
}

export async function tokenFor(role: Role): Promise<string> {
  return signAccessToken({ sub: USER_OF[role], orgId: ORG_A, role, name: role, email: null });
}

export function makeCtx(app: FastifyInstance, fake: FakePrisma): Ctx {
  return {
    app,
    fake,
    async call(as, method, url, payload, extraHeaders = {}) {
      const headers: Record<string, string> = { ...extraHeaders };
      if (as) headers["authorization"] = `Bearer ${await tokenFor(as)}`;
      const res = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
      let body: unknown;
      try {
        body = res.json();
      } catch {
        body = res.body;
      }
      return { status: res.statusCode, headers: res.headers, body };
    },
  };
}

export interface Example {
  id: string;
  /** Expected HTTP status of the recipe's final call. */
  status: number;
  run(ctx: Ctx): Promise<Reply>;
}

const ex = (id: string, status: number, run: Example["run"]): Example => ({ id, status, run });
const get = (id: string, role: Role, url: string, status = 200) => ex(id, status, (c) => c.call(role, "GET", url));
const send = (id: string, role: Role, method: string, url: string, payload: unknown, status = 200) => ex(id, status, (c) => c.call(role, method, url, payload));

const VEHICLE_BODY = {
  track: "FC", isLegacyEntry: false, chassisNo: "CHASSIS-NEW-1", brandId: "brand_a1", modelId: "model_a1", gradeId: "grade_a1", yom: 2021,
  auctionHallId: "", supplierId: null, purchaseDate: "2026-10-15", customerId: "cust_a1", destination: "Country One", auctionBillPaid: null,
  logBook: null, extraKey: null, vehicleRemark: "Example remark",
};

export const EXAMPLES: Example[] = [
  // ---- auth
  ex("auth.login", 200, (c) => c.call(null, "POST", "/api/v1/auth/login", { email: "manager@example.test", password: STAFF_PASSWORD })),
  ex("auth.refresh", 200, async (c) => {
    const login = await c.call(null, "POST", "/api/v1/auth/login", { email: "manager@example.test", password: STAFF_PASSWORD });
    return c.call(null, "POST", "/api/v1/auth/refresh", { refreshToken: (login.body as { data: { refreshToken: string } }).data.refreshToken });
  }),
  ex("auth.refresh.reused", 403, async (c) => {
    const login = await c.call(null, "POST", "/api/v1/auth/login", { email: "manager@example.test", password: STAFF_PASSWORD });
    const refreshToken = (login.body as { data: { refreshToken: string } }).data.refreshToken;
    await c.call(null, "POST", "/api/v1/auth/refresh", { refreshToken });
    return c.call(null, "POST", "/api/v1/auth/refresh", { refreshToken });
  }),
  ex("auth.logout", 200, async (c) => {
    const login = await c.call(null, "POST", "/api/v1/auth/login", { email: "manager@example.test", password: STAFF_PASSWORD });
    return c.call(null, "POST", "/api/v1/auth/logout", { refreshToken: (login.body as { data: { refreshToken: string } }).data.refreshToken });
  }),
  ex("auth.login.wrong", 400, (c) => c.call(null, "POST", "/api/v1/auth/login", { email: "manager@example.test", password: ["wrong", "guess"].join("-") })),
  ex("auth.login.invalid", 400, (c) => c.call(null, "POST", "/api/v1/auth/login", { email: "not-an-email", password: "" })),
  ex("auth.login.locked", 403, async (c) => {
    for (let i = 0; i < 5; i += 1) await c.call(null, "POST", "/api/v1/auth/login", { email: "viewer@example.test", password: ["wrong", "guess"].join("-") });
    return c.call(null, "POST", "/api/v1/auth/login", { email: "viewer@example.test", password: STAFF_PASSWORD });
  }),
  ex("errors.401", 401, (c) => c.call(null, "GET", "/api/v1/profile")),
  ex("errors.403", 403, (c) => c.call("VIEWER", "GET", "/api/v1/staff")),
  ex("errors.404", 404, (c) => c.call("MANAGER", "GET", "/api/v1/vehicles/FC999999")),
  ex("errors.404.route", 404, (c) => c.call("MANAGER", "GET", "/api/v1/no-such-route")),
  ex("errors.409", 409, (c) => c.call("ADMINISTRATOR", "PATCH", "/api/v1/vehicles/v_fc_pending/serial", { serialNumber: 102 })),
  ex("errors.400.fields", 400, (c) => c.call("MANAGER", "POST", "/api/v1/customers", { name: "", email: "nope" })),

  // ---- profile, organization
  get("profile.get", "MANAGER", "/api/v1/profile"),
  send("profile.update", "MANAGER", "PATCH", "/api/v1/profile", { name: "Example Manager", email: "manager@example.test", phone: "0770000000" }),
  send("profile.password", "MANAGER", "POST", "/api/v1/profile/password", { currentPassword: STAFF_PASSWORD, newPassword: `${STAFF_PASSWORD}-new`, confirmPassword: `${STAFF_PASSWORD}-new` }),
  send("profile.password.wrong", "MANAGER", "POST", "/api/v1/profile/password", { currentPassword: "wrong", newPassword: `${STAFF_PASSWORD}-new`, confirmPassword: `${STAFF_PASSWORD}-new` }, 400),
  get("organization.get", "VIEWER", "/api/v1/organization"),

  // ---- staff management
  get("staff.list", "MANAGER", "/api/v1/staff"),
  send("staff.create", "ADMINISTRATOR", "POST", "/api/v1/staff", { name: "New Operator", email: "new.operator@example.test", phone: null, role: "OPERATOR", password: STAFF_PASSWORD }, 201),
  send("staff.update", "ADMINISTRATOR", "PATCH", "/api/v1/staff/staff_op", { name: "Example Operator", email: "operator@example.test", phone: "0770000000", role: "OPERATOR", active: true, password: null }),
  send("staff.active", "ADMINISTRATOR", "POST", "/api/v1/staff/staff_op/active", { active: false }),

  // ---- customers
  get("customers.list", "MANAGER", "/api/v1/customers"),
  get("customers.list.viewer", "VIEWER", "/api/v1/customers"),
  get("customers.search", "VIEWER", "/api/v1/customers/search?q=alp"),
  get("customers.get", "VIEWER", "/api/v1/customers/cust_1"),
  send("customers.create", "MANAGER", "POST", "/api/v1/customers", { name: "New Buyer", email: "new.buyer@example.test", phone: "0772222222", country: "LK", address: null }, 201),
  send("customers.update", "MANAGER", "PATCH", "/api/v1/customers/cust_1", { name: "Alpha Buyer", email: "alpha.buyer@example.test", phone: "0771111111", country: "LK", address: "1 Example Road" }),
  send("customers.login-access", "MANAGER", "PATCH", "/api/v1/customers/cust_1/login-access", { loginEnabled: false }),
  send("customers.agent", "MANAGER", "PATCH", "/api/v1/customers/cust_1/agent", { agentId: "staff_op" }),
  get("customers.active", "MANAGER", "/api/v1/staff/customers/active"),

  // ---- lookups
  get("lookups.list", "VIEWER", "/api/v1/lookups/brands?q=al"),
  get("lookups.get", "VIEWER", "/api/v1/lookups/brands/brand_a1"),
  send("lookups.create", "MANAGER", "POST", "/api/v1/lookups/brands", { name: "Delta Cars" }),
  send("lookups.create.existing", "MANAGER", "POST", "/api/v1/lookups/brands", { name: "alpha motors" }),
  send("lookups.rename", "MANAGER", "PATCH", "/api/v1/lookups/brands/brand_a1", { name: "Alpha Motors Ltd" }),
  get("lookups.models", "VIEWER", "/api/v1/lookups/models?brandId=brand_a1"),
  send("lookups.models.create", "MANAGER", "POST", "/api/v1/lookups/models", { brandId: "brand_a1", name: "Zeta Two" }),
  get("lookups.freight-agents", "VIEWER", "/api/v1/lookups/freight-agents"),
  get("lookups.freight-agents.search", "VIEWER", "/api/v1/lookups/freight-agents/search?q=ag&method=RORO"),
  send("lookups.freight-agents.create", "MANAGER", "POST", "/api/v1/lookups/freight-agents", { name: "Agent B", offersRoro: true, offersContainer: false }),
  get("lookups.row-colours", "VIEWER", "/api/v1/lookups/row-colour-statuses"),

  // ---- vehicles: reading
  get("vehicles.list", "VIEWER", "/api/v1/vehicles?pageSize=1&track=ALL&sort=purchaseDate&dir=desc"),
  get("vehicles.detail", "VIEWER", "/api/v1/vehicles/FC102"),
  get("vehicles.detail.fl", "VIEWER", "/api/v1/vehicles/FL201"),
  get("vehicles.status-history", "VIEWER", "/api/v1/vehicles/FC102/status-history"),
  get("vehicles.filter-options", "VIEWER", "/api/v1/vehicles/filter-options"),
  get("vehicles.destinations", "VIEWER", "/api/v1/vehicles/destinations"),
  get("vehicles.partner-names", "VIEWER", "/api/v1/vehicles/partner-names"),
  get("vehicles.check-chassis", "VIEWER", "/api/v1/vehicles/check-chassis?chassisNo=CHASSIS-AAA-1"),
  get("vehicles.next-serial", "VIEWER", "/api/v1/vehicles/next-serial?track=FC"),

  // ---- vehicles: writing
  send("vehicles.create", "MANAGER", "POST", "/api/v1/vehicles", VEHICLE_BODY, 201),
  send("vehicles.create.invalid", "MANAGER", "POST", "/api/v1/vehicles", { track: "FC", isLegacyEntry: true, chassisNo: "", brandId: "", modelId: "" }, 400),
  send("vehicles.update", "MANAGER", "PUT", "/api/v1/vehicles/v_fc_booked_future", { ...VEHICLE_BODY, chassisNo: "CHASSIS-AAA-2" }),
  send("vehicles.delete", "MANAGER", "DELETE", "/api/v1/vehicles/v_fc_pending", undefined),
  send("vehicles.row-colour", "OPERATOR", "PATCH", "/api/v1/vehicles/v_fc_pending/row-colour", { rowColourStatusId: "rc_done" }),
  send("vehicles.auction-bill-paid", "OPERATOR", "PATCH", "/api/v1/vehicles/v_fc_pending/auction-bill-paid", { auctionBillPaid: null }),
  send("vehicles.convert-to-export", "MANAGER", "POST", "/api/v1/vehicles/v_fl_native/convert-to-export", { destination: "Country One" }),
  send("vehicles.revert-to-local", "MANAGER", "POST", "/api/v1/vehicles/v_fl_to_export/revert-to-local", undefined),
  send("vehicles.serial", "ADMINISTRATOR", "PATCH", "/api/v1/vehicles/v_fc_pending/serial", { serialNumber: 150 }),
  send("vehicles.serial.conflict", "ADMINISTRATOR", "PATCH", "/api/v1/vehicles/v_fc_pending/serial", { serialNumber: 102 }, 409),
  send("vehicles.serial.reuse", "ADMINISTRATOR", "PATCH", "/api/v1/vehicles/v_fc_pending/serial", { serialNumber: 106 }),

  // ---- milestones
  get("milestones.list", "VIEWER", "/api/v1/vehicles/FC102/milestones"),
  get("vehicles.timeline", "VIEWER", "/api/v1/vehicles/FC102/timeline"),
  send("milestones.set", "OPERATOR", "PUT", "/api/v1/vehicles/v_fc_booked_future/milestones/AT_EXPORT_YARD", { occurredAt: "2026-10-20" }),
  send("milestones.delete", "OPERATOR", "DELETE", "/api/v1/vehicles/v_fc_booked_future/milestones/BOUGHT", undefined),
  send("milestones.mark-arrived", "OPERATOR", "POST", "/api/v1/vehicles/v_fc_booked_future/mark-arrived", {}),

  // ---- files
  send("uploads.presign", "OPERATOR", "POST", "/api/v1/uploads/presign", { vehicleId: "v_fc_booked_future", kind: "VEHICLE_PHOTO", fileName: "front.jpg", contentType: "image/jpeg", fileSize: 1000 }),
  get("files.list", "VIEWER", "/api/v1/vehicles/FC102/files"),
  get("files.pdf-images", "VIEWER", "/api/v1/vehicles/FC102/pdf-images"),
  send("files.photo.add", "OPERATOR", "POST", "/api/v1/vehicles/v_fc_booked_future/photos", { key: photoKey("new.jpg") }, 201),
  send("files.photos-added", "OPERATOR", "POST", "/api/v1/vehicles/v_fc_booked_future/photos-added", { count: 3 }),
  send("files.document.add", "OPERATOR", "POST", "/api/v1/vehicles/v_fc_booked_future/documents", { key: docKey("new.pdf"), name: "Export certificate", documentType: "EC" }, 201),
  send("files.auction-sheet", "OPERATOR", "PUT", "/api/v1/vehicles/v_fc_booked_future/auction-sheet", { key: sheetKey() }),
  send("files.photo.delete", "MANAGER", "DELETE", "/api/v1/vehicles/v_fc_booked_future/photos/ph_1", undefined),
  send("files.document.delete", "MANAGER", "DELETE", "/api/v1/vehicles/v_fc_booked_future/documents/doc_1", undefined),

  // ---- release to the customer
  get("release.readiness", "OPERATOR", "/api/v1/vehicles/v_fc_booked_future/release-readiness"),
  send("release.visibility", "MANAGER", "PATCH", "/api/v1/vehicles/v_fc_booked_future/customer-visibility", { customerVisible: true }),
  send("release.info", "MANAGER", "PATCH", "/api/v1/vehicles/v_fc_booked_future/customer-info", { portOfLoading: "Example Port", portOfDischarge: null, voyageNo: "V001" }),
  send("release.document", "MANAGER", "PATCH", "/api/v1/vehicles/v_fc_booked_future/documents/doc_1", { visibleToCustomer: true }),
  send("release.photo", "MANAGER", "PATCH", "/api/v1/vehicles/v_fc_booked_future/photos/ph_1", { visibleToCustomer: true }),
  send("release.photos", "MANAGER", "PATCH", "/api/v1/vehicles/v_fc_booked_future/photos", { visibleToCustomer: true, photoIds: ["ph_1"] }),

  // ---- dashboard, reports, activity log
  get("dashboard.stats", "VIEWER", "/api/v1/dashboard/stats"),
  get("dashboard.trends", "VIEWER", "/api/v1/dashboard/trends"),
  get("reports.by-customer", "MANAGER", "/api/v1/reports/by-customer?track=FC"),
  get("reports.by-customer.viewer", "VIEWER", "/api/v1/reports/by-customer?track=FC"),
  get("reports.by-auction-hall", "VIEWER", "/api/v1/reports/by-auction-hall"),
  get("reports.by-destination", "VIEWER", "/api/v1/reports/by-destination"),
  get("reports.by-freight-agent", "VIEWER", "/api/v1/reports/by-freight-agent"),
  get("activity-log.list", "ADMINISTRATOR", "/api/v1/activity-log"),
  get("activity-log.filters", "ADMINISTRATOR", "/api/v1/activity-log/filters"),

  // ---- notifications
  get("notifications.list", "MANAGER", "/api/v1/notifications"),
  get("notifications.unread", "MANAGER", "/api/v1/notifications/unread-count"),
  send("notifications.read", "MANAGER", "POST", "/api/v1/notifications/n_1/read", undefined),
  send("notifications.read-all", "MANAGER", "POST", "/api/v1/notifications/read-all", undefined),
  send("device-tokens.register", "MANAGER", "POST", "/api/v1/device-tokens", { expoPushToken: "ExponentPushToken[example-new]", platform: "ios" }),
  send("device-tokens.unregister", "MANAGER", "DELETE", "/api/v1/device-tokens", { expoPushToken: "ExponentPushToken[example-old]" }),

  // ---- customer administration
  get("link-requests.list", "MANAGER", "/api/v1/link-requests"),
  send("link-requests.approve", "MANAGER", "POST", "/api/v1/link-requests/lr_1/approve", {}),
  send("link-requests.reject", "MANAGER", "POST", "/api/v1/link-requests/lr_1/reject", { reason: "Serial does not match your purchase." }),
  get("faqs.list", "MANAGER", "/api/v1/faqs"),
  send("faqs.create", "MANAGER", "POST", "/api/v1/faqs", { question: "Can I visit the yard?", answer: "Yes, by appointment.", sortOrder: 2, published: true }, 201),
  send("faqs.update", "MANAGER", "PATCH", "/api/v1/faqs/faq_1", { published: false }),
  send("faqs.delete", "MANAGER", "DELETE", "/api/v1/faqs/faq_1", undefined),

  // ---- chat
  get("chat.inbox", "OPERATOR", "/api/v1/chat/conversations"),
  get("chat.messages", "OPERATOR", "/api/v1/chat/conversations/conv_1/messages"),
  send("chat.reply", "OPERATOR", "POST", "/api/v1/chat/conversations/conv_1/messages", { body: "It left the port yesterday." }, 201),
  send("chat.handled", "OPERATOR", "POST", "/api/v1/chat/conversations/conv_1/handled", { handled: true }),
  send("chat.read", "OPERATOR", "POST", "/api/v1/chat/conversations/conv_1/read", undefined),

  // ---- public stock and enquiries
  get("stock.list", "MANAGER", "/api/v1/stock"),
  get("stock.get", "MANAGER", "/api/v1/stock/stock_1"),
  send("stock.create", "MANAGER", "POST", "/api/v1/stock", { make: "Beta", model: "Two", year: 2019, price: 1200000, mileageKm: 60000, bodyType: "SUV", fuel: "Diesel", transmission: "Manual", colour: "Blue", description: "Another example." }, 201),
  send("stock.update", "MANAGER", "PATCH", "/api/v1/stock/stock_1", { price: 1450000 }),
  send("stock.publish", "MANAGER", "POST", "/api/v1/stock/stock_1/publish", { notifyCustomers: false }),
  send("stock.unpublish", "MANAGER", "POST", "/api/v1/stock/stock_2/unpublish", {}),
  send("stock.mark-sold", "MANAGER", "POST", "/api/v1/stock/stock_2/mark-sold", {}),
  send("stock.delete", "MANAGER", "DELETE", "/api/v1/stock/stock_1", undefined),
  send("stock.images.presign", "MANAGER", "POST", "/api/v1/stock/stock_1/images/presign", { contentType: "image/jpeg", fileSize: 1000 }),
  send("stock.images.add", "MANAGER", "POST", "/api/v1/stock/stock_1/images", { key: stockKey(2), altText: "Rear view" }, 201),
  send("stock.images.reorder", "MANAGER", "POST", "/api/v1/stock/stock_1/images/reorder", { imageIds: ["simg_1"] }),
  send("stock.images.update", "MANAGER", "PATCH", "/api/v1/stock/stock_1/images/simg_1", { altText: "Left side" }),
  send("stock.images.delete", "MANAGER", "DELETE", "/api/v1/stock/stock_1/images/simg_1", undefined),
  get("enquiries.list", "MANAGER", "/api/v1/enquiries"),
  send("enquiries.handled", "MANAGER", "POST", "/api/v1/enquiries/enq_1/handled", { handled: true }),

  // ---- admin job
  send("admin.daily-checks", "ADMINISTRATOR", "POST", "/api/v1/admin/jobs/daily-checks", undefined),
];
