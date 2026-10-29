// Staff authorization freshness against real Postgres: the single query behind getFreshStaffAuth (loginEnabled, role, user type,
// org), the services that invalidate it, and a real HTTP request before and after a deactivation. Fake data only.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPrisma, getTestPrisma, resetDb } from "./helpers/db.js";

vi.mock("../../src/lib/prisma.js", async () => {
  const { getTestPrisma } = await import("./helpers/db.js");
  return { getPrisma: () => getTestPrisma() };
});

import { buildApp } from "../../src/app.js";
import { signAccessToken } from "../../src/lib/mobile-jwt.js";
import { clearStaffAuthCache, getFreshStaffAuth } from "../../src/services/staff-auth-state.service.js";
import { createStaff, setStaffActive, updateStaff } from "../../src/services/user.service.js";

const prisma = getTestPrisma();
const ORG = "org_test_a";
const OTHER = "org_test_b";
const superAdmin = { id: "staff_super", role: "ADMINISTRATOR" as const, orgId: ORG, name: "Administrator", email: null };

beforeEach(async () => {
  await resetDb(prisma);
  clearStaffAuthCache();
  for (const id of [ORG, OTHER]) await prisma.organization.create({ data: { id, name: id } });
  await prisma.user.createMany({
    data: [
      { id: "staff_super", org_id: ORG, userType: "STAFF", name: "Administrator", role: "ADMINISTRATOR", loginEnabled: true, email: "super@example.test" },
      { id: "staff_mgr", org_id: ORG, userType: "STAFF", name: "Manager", role: "MANAGER", loginEnabled: true, email: "mgr@example.test" },
      { id: "staff_off", org_id: ORG, userType: "STAFF", name: "Off", role: "MANAGER", loginEnabled: false, email: "off@example.test" },
      { id: "staff_b", org_id: OTHER, userType: "STAFF", name: "Other", role: "MANAGER", loginEnabled: true, email: "b@example.test" },
      { id: "cust_1", org_id: ORG, userType: "CUSTOMER", name: "Buyer", role: null, loginEnabled: true, email: "c1@example.test" },
    ],
  });
});
afterAll(async () => {
  await closeTestPrisma();
});

describe("getFreshStaffAuth reads the real row", () => {
  it("an active staff member: the database role, name and email", async () => {
    expect(await getFreshStaffAuth("staff_mgr", ORG)).toEqual({ id: "staff_mgr", orgId: ORG, role: "MANAGER", name: "Manager", email: "mgr@example.test" });
  });

  it.each([
    ["a deactivated account", "staff_off", ORG],
    ["an unknown id", "staff_nobody", ORG],
    ["a user of another org", "staff_b", ORG],
    ["a customer (NULL role)", "cust_1", ORG],
  ])("%s is not allowed", async (_label, id, org) => {
    expect(await getFreshStaffAuth(id, org)).toBeNull();
  });
});

describe("a change made by the services applies on the next call, with the cache on", () => {
  it("demotion, deactivation and reactivation", async () => {
    expect((await getFreshStaffAuth("staff_mgr", ORG))?.role).toBe("MANAGER"); // remembered
    await updateStaff(superAdmin, "staff_mgr", { name: "Manager", email: "mgr@example.test", phone: null, role: "VIEWER", active: true });
    expect((await getFreshStaffAuth("staff_mgr", ORG))?.role).toBe("VIEWER");

    await setStaffActive(superAdmin, "staff_mgr", false);
    expect(await getFreshStaffAuth("staff_mgr", ORG)).toBeNull();

    await setStaffActive(superAdmin, "staff_mgr", true);
    expect((await getFreshStaffAuth("staff_mgr", ORG))?.role).toBe("VIEWER");
  });

  it("a new account is allowed on its first call even if its id was asked about before", async () => {
    const created = await createStaff(superAdmin, { name: "Fresh Person", email: "fresh@example.test", phone: null, role: "OPERATOR", password: "example-Passw0rd-1" });
    expect((await getFreshStaffAuth(created.id, ORG))?.role).toBe("OPERATOR");
  });

  it("an id remembered as 'not allowed' stops being so once the row exists and is invalidated by the service path", async () => {
    expect(await getFreshStaffAuth("staff_late", ORG)).toBeNull();
    await prisma.user.create({ data: { id: "staff_late", org_id: ORG, userType: "STAFF", name: "Late", role: "VIEWER", loginEnabled: false, email: "late@example.test" } });
    await setStaffActive(superAdmin, "staff_late", true); // the service invalidates after its commit
    expect((await getFreshStaffAuth("staff_late", ORG))?.role).toBe("VIEWER");
  });
});

describe("a real request before and after a deactivation", () => {
  it("200, then 401 on the very next request with the same token", async () => {
    const app = await buildApp({ rateLimit: false });
    try {
      const headers = { authorization: `Bearer ${await signAccessToken({ sub: "staff_mgr", orgId: ORG, role: "MANAGER", name: "Manager", email: null })}` };
      expect((await app.inject({ method: "GET", url: "/api/v1/staff", headers })).statusCode).toBe(200);
      await setStaffActive(superAdmin, "staff_mgr", false);
      const after = await app.inject({ method: "GET", url: "/api/v1/staff", headers });
      expect(after.statusCode).toBe(401);
      expect(after.json().error.code).toBe("UNAUTHENTICATED");
    } finally {
      await app.close();
    }
  });

  it("a role changed in the database is the role used, whatever the token claims", async () => {
    const app = await buildApp({ rateLimit: false });
    try {
      // The token claims ADMINISTRATOR; the row says MANAGER: the admin-only create route is refused.
      const headers = { authorization: `Bearer ${await signAccessToken({ sub: "staff_mgr", orgId: ORG, role: "ADMINISTRATOR", name: "Manager", email: null })}` };
      const res = await app.inject({ method: "POST", url: "/api/v1/staff", headers, payload: { name: "X Person", email: "x@example.test", phone: null, role: "VIEWER", password: "example-Passw0rd-1" } });
      expect(res.statusCode).toBe(403);
      expect(await prisma.user.count({ where: { email: "x@example.test" } })).toBe(0);
    } finally {
      await app.close();
    }
  });
});
