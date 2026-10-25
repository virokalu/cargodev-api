// Fake data for the customer zone: two orgs, several customers, one staff user. Nothing here is real.

import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { signCustomerToken } from "../../src/lib/customer-jwt.js";
import { createFakePrisma, type FakePrisma } from "./fake-prisma.js";
import { ORG_A, ORG_B } from "./fixtures.js";

/** The password every seeded customer has. Built at runtime so no secret-looking literal sits next to a name. */
export const CUSTOMER_PASSWORD = ["example", "Password", "12345"].join("-");
export const NEW_PASSWORD = ["example", "Another", "Password", "678"].join("-");

// Cost 4 keeps the suite fast; production uses 10 (the compare works with any cost).
const SEEDED_HASH = bcrypt.hashSync(CUSTOMER_PASSWORD, 4);

const verifiedAt = new Date("2026-01-01T00:00:00Z");

type Row = Record<string, unknown>;

function customer(id: string, org: string, email: string | null, over: Row = {}): Row {
  return {
    id,
    org_id: org,
    userType: "CUSTOMER",
    name: `Customer ${id}`,
    email,
    phone: null,
    country: null,
    address: null,
    companyName: null,
    language: null,
    theme: null,
    destinationPort: null,
    assignedAgentId: null,
    password: SEEDED_HASH,
    loginEnabled: true,
    emailVerifiedAt: verifiedAt,
    deletedAt: null,
    role: null,
    failedLoginAttempts: 0,
    lockoutUntil: null,
    ...over,
  };
}

export function newCustomerFake(): FakePrisma {
  const fake = createFakePrisma();
  fake.seed(
    "user",
    // Org A
    customer("cust_a1", ORG_A, "a1@example.test", { companyName: "Example Trading" }),
    customer("cust_a2", ORG_A, "a2@example.test"),
    customer("cust_unverified", ORG_A, "unverified@example.test", { emailVerifiedAt: null, loginEnabled: false, password: null }),
    customer("cust_disabled", ORG_A, "disabled@example.test", { loginEnabled: false }),
    customer("cust_deleted", ORG_A, null, { deletedAt: new Date(), loginEnabled: false, password: null, emailVerifiedAt: null }),
    // A customer staff created, with no password yet but login switched on
    customer("cust_invited", ORG_A, "invited@example.test", { password: null, emailVerifiedAt: null }),
    { id: "staff_a1", org_id: ORG_A, userType: "STAFF", name: "Staff A", email: "staff@example.test", password: SEEDED_HASH, loginEnabled: true, role: "MANAGER", failedLoginAttempts: 0, lockoutUntil: null, emailVerifiedAt: null, deletedAt: null },
    // Org B
    customer("cust_b1", ORG_B, "b1@example.test")
  );
  return fake;
}

export const customerToken = (userId: string, orgId = ORG_A) => signCustomerToken({ sub: userId, orgId });

export const bearerFor = async (userId: string, orgId = ORG_A) => ({ authorization: `Bearer ${await customerToken(userId, orgId)}` });

/** POST helper for the customer API. */
export const post = (app: FastifyInstance, path: string, body: unknown, headers: Record<string, string> = {}, remoteAddress?: string) =>
  app.inject({ method: "POST", url: `/api/customer/v1${path}`, payload: body as object, headers, ...(remoteAddress ? { remoteAddress } : {}) });

export const request = (app: FastifyInstance, method: "GET" | "PATCH" | "POST" | "DELETE", path: string, headers: Record<string, string> = {}, body?: unknown) =>
  app.inject({ method, url: `/api/customer/v1${path}`, headers, ...(body === undefined ? {} : { payload: body as object }) });

/** The plain 6-digit code inside an email the app queued. */
export function codeFrom(message: { text: string } | undefined): string {
  const match = /\b(\d{6})\b/.exec(message?.text ?? "");
  if (!match) throw new Error("no code in message");
  return match[1]!;
}

/**
 * IDOR scaffold for every customer route that touches data owned by one customer.
 * `fetchAs(actor, targetId)` calls the route as `actor` for a resource owned by `targetId`'s customer.
 * Rules: your own resource is found; another customer's in the same org is 404; another org's is 404.
 */
export interface IdorActor {
  id: string;
  orgId: string;
}

export const IDOR_WORLD = {
  own: { id: "cust_a1", orgId: ORG_A } as IdorActor,
  sameOrgOther: { id: "cust_a2", orgId: ORG_A } as IdorActor,
  otherOrg: { id: "cust_b1", orgId: ORG_B } as IdorActor,
};
