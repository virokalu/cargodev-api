import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { actor, actorA, ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import {
  changeOwnPassword,
  createStaff,
  getOwnProfile,
  isSuperAdmin,
  listStaff,
  setStaffActive,
  updateOwnProfileDetails,
  updateStaff,
} from "../src/services/user.service.js";

const OLD_SECRET = "example-Old-Passw0rd";
const NEW_SECRET = "example-New-Passw0rd";

const superAdmin = actor({ id: "staff_a_super", role: "ADMINISTRATOR", name: "Administrator" });
const plainAdmin = actor({ id: "staff_a_admin", role: "ADMINISTRATOR", name: "Regular Admin" });

let fake: FakePrisma;

const staffRow = (id: string, org_id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
  id,
  org_id,
  userType: "STAFF",
  name,
  email: `${id}@example.test`,
  phone: null,
  role,
  loginEnabled: true,
  lastActiveAt: null,
  ...extra,
});

beforeEach(() => {
  fake = createFakePrisma();
  state.fake = fake;
  fake.seed(
    "user",
    staffRow("staff_a_super", ORG_A, "Administrator", "ADMINISTRATOR"),
    staffRow("staff_a_admin", ORG_A, "Regular Admin", "ADMINISTRATOR"),
    staffRow("staff_a_mgr", ORG_A, "Test Manager A", "MANAGER", { password: bcrypt.hashSync(OLD_SECRET, 4) }),
    staffRow("staff_b_mgr", ORG_B, "Test Manager B", "MANAGER"),
    { id: "cust_a1", org_id: ORG_A, userType: "CUSTOMER", name: "Buyer", email: null, phone: null, role: null }
  );
  fake.seed(
    "refreshToken",
    { id: "rt_a", org_id: ORG_A, userId: "staff_a_mgr", revokedAt: null },
    { id: "rt_b", org_id: ORG_B, userId: "staff_b_mgr", revokedAt: null }
  );
});

describe("isSuperAdmin", () => {
  it("requires both the ADMINISTRATOR role and the reserved name", () => {
    expect(isSuperAdmin({ role: "ADMINISTRATOR", name: "Administrator" })).toBe(true);
    expect(isSuperAdmin({ role: "ADMINISTRATOR", name: "Regular Admin" })).toBe(false);
    expect(isSuperAdmin({ role: "MANAGER", name: "Administrator" })).toBe(false);
  });
});

describe("listStaff", () => {
  it("returns only this org's staff, never customers", async () => {
    const ids = (await listStaff(superAdmin)).map((s) => s.id);
    expect(ids.sort()).toEqual(["staff_a_admin", "staff_a_mgr", "staff_a_super"]);
  });
  it("hides the super-admin row from everyone else", async () => {
    const ids = (await listStaff(plainAdmin)).map((s) => s.id);
    expect(ids).not.toContain("staff_a_super");
    expect(ids).toContain("staff_a_admin");
  });
});

describe("createStaff", () => {
  const valid = { name: "New Operator", email: "New.Op@Example.test", phone: "", role: "OPERATOR", password: NEW_SECRET };

  it("creates a staff user in the actor's org with a hashed password and an ActivityLog row", async () => {
    const created = await createStaff(actorA, valid);
    expect(created).toMatchObject({ name: "New Operator", email: "new.op@example.test", role: "OPERATOR", loginEnabled: true });
    const row = fake.rows("user").find((r) => r["id"] === created.id);
    expect(row).toMatchObject({ org_id: ORG_A, userType: "STAFF" });
    expect(row?.["password"]).not.toBe(NEW_SECRET);
    expect(await bcrypt.compare(NEW_SECRET, row?.["password"] as string)).toBe(true);
    expect(fake.rows("activityLog")[0]).toMatchObject({ action: "CREATE_STAFF", org_id: ORG_A, actorId: actorA.id });
  });

  it("never writes the password into the audit trail", async () => {
    await createStaff(actorA, valid);
    expect(JSON.stringify(fake.rows("activityLog"))).not.toContain(NEW_SECRET);
    expect(JSON.stringify(fake.rows("activityLog"))).not.toContain("password");
  });

  it("rejects invalid input with field errors", async () => {
    const error = await createStaff(actorA, { ...valid, password: "short", email: "nope" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION" });
    expect((error as { fieldErrors: Record<string, string> }).fieldErrors).toHaveProperty("password");
    expect((error as { fieldErrors: Record<string, string> }).fieldErrors).toHaveProperty("email");
  });

  it("only the super-admin can create an ADMINISTRATOR", async () => {
    await expect(createStaff(plainAdmin, { ...valid, role: "ADMINISTRATOR" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createStaff(superAdmin, { ...valid, role: "ADMINISTRATOR" })).resolves.toMatchObject({ role: "ADMINISTRATOR" });
  });

  it("refuses the reserved super-admin name", async () => {
    await expect(createStaff(superAdmin, { ...valid, name: "Administrator" })).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { name: "This name is reserved" },
    });
  });
});

describe("updateStaff", () => {
  const update = { name: "Renamed Manager", email: "mgr@example.test", phone: "", role: "MANAGER", active: true, password: "" };

  it("updates a staff member and logs before/after", async () => {
    const updated = await updateStaff(plainAdmin, "staff_a_mgr", update);
    expect(updated.name).toBe("Renamed Manager");
    expect(fake.rows("activityLog")[0]).toMatchObject({ action: "UPDATE_STAFF", before: { name: "Test Manager A" } });
  });

  it("returns NOT_FOUND for another org's staff and changes nothing", async () => {
    await expect(updateStaff(plainAdmin, "staff_b_mgr", update)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.rows("user").find((r) => r["id"] === "staff_b_mgr")?.["name"]).toBe("Test Manager B");
  });

  it("returns NOT_FOUND for a customer id", async () => {
    await expect(updateStaff(plainAdmin, "cust_a1", update)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports the super-admin as NOT_FOUND to a regular admin (existence not revealed)", async () => {
    await expect(updateStaff(plainAdmin, "staff_a_super", update)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a regular admin cannot edit another administrator or grant the role", async () => {
    await expect(updateStaff(plainAdmin, "staff_a_admin", { ...update, role: "ADMINISTRATOR" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(updateStaff(plainAdmin, "staff_a_mgr", { ...update, role: "ADMINISTRATOR" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("a blank password leaves the stored hash unchanged", async () => {
    const before = fake.rows("user").find((r) => r["id"] === "staff_a_mgr")?.["password"];
    await updateStaff(plainAdmin, "staff_a_mgr", update);
    expect(fake.rows("user").find((r) => r["id"] === "staff_a_mgr")?.["password"]).toBe(before);
  });
});

describe("setStaffActive", () => {
  it("deactivating disables login, logs it, and revokes that user's refresh tokens", async () => {
    const result = await setStaffActive(plainAdmin, "staff_a_mgr", false);
    expect(result.loginEnabled).toBe(false);
    expect(fake.rows("activityLog")[0]).toMatchObject({ action: "DEACTIVATE_STAFF" });
    expect(fake.rows("refreshToken").find((r) => r["id"] === "rt_a")?.["revokedAt"]).toBeInstanceOf(Date);
  });

  it("does not revoke tokens belonging to another org", async () => {
    await setStaffActive(plainAdmin, "staff_a_mgr", false);
    expect(fake.rows("refreshToken").find((r) => r["id"] === "rt_b")?.["revokedAt"]).toBeNull();
  });

  it("re-activating does not touch tokens", async () => {
    await setStaffActive(plainAdmin, "staff_a_mgr", true);
    expect(fake.rows("activityLog")[0]).toMatchObject({ action: "ACTIVATE_STAFF" });
    expect(fake.rows("refreshToken").find((r) => r["id"] === "rt_a")?.["revokedAt"]).toBeNull();
  });

  it("returns NOT_FOUND for another org's staff", async () => {
    await expect(setStaffActive(plainAdmin, "staff_b_mgr", false)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.rows("user").find((r) => r["id"] === "staff_b_mgr")?.["loginEnabled"]).toBe(true);
  });

  it("only the super-admin can deactivate an administrator", async () => {
    await expect(setStaffActive(plainAdmin, "staff_a_admin", false)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setStaffActive(superAdmin, "staff_a_admin", false)).resolves.toMatchObject({ loginEnabled: false });
  });
});

describe("own profile", () => {
  const self = actor({ id: "staff_a_mgr" });

  it("getOwnProfile is org-scoped", async () => {
    await expect(getOwnProfile(ORG_A, "staff_a_mgr")).resolves.toMatchObject({ id: "staff_a_mgr" });
    await expect(getOwnProfile(ORG_B, "staff_a_mgr")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("updateOwnProfileDetails updates only the actor and logs it", async () => {
    const updated = await updateOwnProfileDetails(self, { name: "New Name", email: "self@example.test", phone: "" });
    expect(updated.name).toBe("New Name");
    expect(fake.rows("user").find((r) => r["id"] === "staff_a_admin")?.["name"]).toBe("Regular Admin");
    expect(fake.rows("activityLog")[0]).toMatchObject({ action: "UPDATE_PROFILE", entityId: "staff_a_mgr" });
  });

  it("changeOwnPassword rejects a wrong current password", async () => {
    const error = await changeOwnPassword(self, {
      currentPassword: "example-wrong-one",
      newPassword: NEW_SECRET,
      confirmPassword: NEW_SECRET,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION", fieldErrors: { currentPassword: "Current password is incorrect" } });
  });

  it("changeOwnPassword rejects mismatched confirmation", async () => {
    const error = await changeOwnPassword(self, {
      currentPassword: OLD_SECRET,
      newPassword: NEW_SECRET,
      confirmPassword: "example-different",
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION", fieldErrors: { confirmPassword: "Passwords do not match" } });
  });

  it("changeOwnPassword stores a new hash, revokes tokens, and logs without secrets", async () => {
    await changeOwnPassword(self, { currentPassword: OLD_SECRET, newPassword: NEW_SECRET, confirmPassword: NEW_SECRET });
    const hash = fake.rows("user").find((r) => r["id"] === "staff_a_mgr")?.["password"] as string;
    expect(await bcrypt.compare(NEW_SECRET, hash)).toBe(true);
    expect(fake.rows("refreshToken").find((r) => r["id"] === "rt_a")?.["revokedAt"]).toBeInstanceOf(Date);
    expect(fake.rows("refreshToken").find((r) => r["id"] === "rt_b")?.["revokedAt"]).toBeNull();
    const log = fake.rows("activityLog")[0];
    expect(log).toMatchObject({ action: "CHANGE_PASSWORD" });
    expect(log).not.toHaveProperty("before");
    expect(log).not.toHaveProperty("after");
  });

  it("changeOwnPassword cannot reach an account in another org", async () => {
    const outsider = actor({ id: "staff_a_mgr", orgId: ORG_B });
    await expect(
      changeOwnPassword(outsider, { currentPassword: OLD_SECRET, newPassword: NEW_SECRET, confirmPassword: NEW_SECRET })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reserved super-admin name", () => {
  const self = actor({ id: "staff_a_admin", role: "ADMINISTRATOR", name: "Regular Admin" });

  it("a regular admin cannot take the reserved name by renaming themselves", async () => {
    const error = await updateOwnProfileDetails(self, {
      name: "Administrator",
      email: "staff_a_admin@example.test",
      phone: "",
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION", fieldErrors: { name: "This name is reserved" } });
    expect(fake.rows("user").find((r) => r["id"] === "staff_a_admin")?.["name"]).toBe("Regular Admin");
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  it("the check ignores case and surrounding whitespace", async () => {
    for (const name of ["administrator", "  ADMINISTRATOR ", "Administrator"]) {
      await expect(
        updateOwnProfileDetails(self, { name, email: "staff_a_admin@example.test", phone: "" })
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("the super-admin can still edit their own profile", async () => {
    const updated = await updateOwnProfileDetails(superAdmin, {
      name: "Administrator",
      email: "staff_a_super@example.test",
      phone: "123",
    });
    expect(updated.phone).toBe("123");
  });

  it("createStaff and updateStaff reject case variants of the reserved name", async () => {
    await expect(
      createStaff(superAdmin, { name: "administrator", email: "n@example.test", phone: "", role: "OPERATOR", password: NEW_SECRET })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      updateStaff(plainAdmin, "staff_a_mgr", {
        name: " ADMINISTRATOR", email: "m@example.test", phone: "", role: "MANAGER", active: true, password: "",
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("updateStaff revokes sessions when access changes", () => {
  const base = { name: "Test Manager A", email: "mgr@example.test", phone: "", role: "MANAGER", active: true, password: "" };
  const revokedAt = (id: string) => fake.rows("refreshToken").find((r) => r["id"] === id)?.["revokedAt"];

  it("revokes that user's tokens when an admin sets a new password", async () => {
    await updateStaff(plainAdmin, "staff_a_mgr", { ...base, password: NEW_SECRET });
    expect(revokedAt("rt_a")).toBeInstanceOf(Date);
    expect(revokedAt("rt_b")).toBeNull();
  });

  it("revokes when the account is deactivated through an edit", async () => {
    await updateStaff(plainAdmin, "staff_a_mgr", { ...base, active: false });
    expect(revokedAt("rt_a")).toBeInstanceOf(Date);
  });

  it("revokes when the role changes", async () => {
    await updateStaff(plainAdmin, "staff_a_mgr", { ...base, role: "VIEWER" });
    expect(revokedAt("rt_a")).toBeInstanceOf(Date);
  });

  it("leaves sessions alone for an edit that changes nothing sensitive", async () => {
    await updateStaff(plainAdmin, "staff_a_mgr", { ...base, name: "Renamed Manager" });
    expect(revokedAt("rt_a")).toBeNull();
  });
});
