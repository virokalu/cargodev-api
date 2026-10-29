// Staff (userType = STAFF) management service — CD-D2-16. Server Actions in
// app/(dashboard)/users/actions.ts are thin wrappers that call this; nothing
// here is UI-specific (CLAUDE.md rule 2).
//
// Role changes are gated here as well as at the Server Action layer
// (requireUser(["ADMINISTRATOR"])) — CLAUDE.md's RBAC rule says enforcement
// must not rely on the UI alone, so this check has to hold even if a future
// caller reaches updateStaff() a different way.

import bcrypt from "bcryptjs";
import { Prisma, type StaffRole } from "@prisma/client";
import { getPrisma } from "../lib/prisma.js";
import { ServiceError } from "../lib/errors.js";
import type { SessionUser } from "../lib/session-user.js";
import {
  staffCreateSchema,
  staffUpdateSchema,
} from "../validation/user.schema.js";
import {
  profileDetailsSchema,
  changePasswordSchema,
} from "../validation/profile.schema.js";
import { flattenFieldErrors } from "../validation/shared.js";
import * as activityLog from "./activity-log.service.js";
import { revokeAllUserTokens } from "./mobile-auth.service.js";
import { invalidateStaffAuth } from "./staff-auth-state.service.js";

const PASSWORD_SALT_ROUNDS = 10;

// The seeded super-admin account (prisma/seed.ts) is identified by this
// literal name, not just its role — every org has exactly one, and
// createStaff() below refuses to let anyone create a second one. It's
// invisible in the Users list to everyone but itself, and it's the only
// account that can create/edit/deactivate other ADMINISTRATOR-role rows.
// Regular admins can freely manage Manager/Operator/Viewer accounts, but
// never each other — this is a deliberate blast-radius limit: no single
// admin who isn't the super-admin can lock every other admin out.
const SUPER_ADMIN_NAME = "Administrator";

/** Case-insensitive and trimmed, so "administrator" or " Administrator " cannot
 * be used to sidestep the reserved-name checks below. */
function isReservedName(name: string): boolean {
  return name.trim().toLowerCase() === SUPER_ADMIN_NAME.toLowerCase();
}

export function isSuperAdmin(actor: Pick<SessionUser, "name" | "role">): boolean {
  return actor.role === "ADMINISTRATOR" && actor.name === SUPER_ADMIN_NAME;
}

export interface StaffListItem {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: StaffRole;
  loginEnabled: boolean;
  lastActiveAt: Date | null;
}

const STAFF_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  loginEnabled: true,
  lastActiveAt: true,
} satisfies Prisma.UserSelect;

export async function listStaff(actor: SessionUser, query?: string): Promise<StaffListItem[]> {
  const q = query?.trim();
  const staff = await getPrisma().user.findMany({
    where: {
      org_id: actor.orgId,
      userType: "STAFF",
      // The super-admin row is invisible to everyone but itself.
      ...(isSuperAdmin(actor) ? {} : { NOT: { name: SUPER_ADMIN_NAME, role: "ADMINISTRATOR" } }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: STAFF_SELECT,
    orderBy: { name: "asc" },
  });
  // role/email are non-null for STAFF rows by construction — narrow the type
  // once here instead of forcing every caller to handle the customer case.
  return staff as StaffListItem[];
}

/**
 * Fetches one staff row scoped to the org, or throws NOT_FOUND.
 *
 * When `actor` isn't the super-admin, a super-admin target is reported as
 * NOT_FOUND rather than FORBIDDEN — same as it being missing from
 * listStaff, so its existence isn't revealed by a different error shape.
 */
async function getOwnedStaff(actor: SessionUser, staffId: string) {
  const existing = await getPrisma().user.findUnique({ where: { id: staffId } });
  if (!existing || existing.org_id !== actor.orgId || existing.userType !== "STAFF") {
    throw new ServiceError("NOT_FOUND", "Staff account not found.");
  }
  if (existing.name === SUPER_ADMIN_NAME && existing.role === "ADMINISTRATOR" && !isSuperAdmin(actor)) {
    throw new ServiceError("NOT_FOUND", "Staff account not found.");
  }
  return existing;
}

export async function createStaff(actor: SessionUser, rawInput: unknown): Promise<StaffListItem> {
  const parsed = staffCreateSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ServiceError(
      "VALIDATION",
      "Please fix the highlighted fields.",
      flattenFieldErrors(parsed.error)
    );
  }
  const input = parsed.data;

  if (input.role === "ADMINISTRATOR" && !isSuperAdmin(actor)) {
    throw new ServiceError(
      "FORBIDDEN",
      "Only the Administrator account can create administrator accounts.",
      { role: "Only the Administrator account can assign this role" }
    );
  }
  if (isReservedName(input.name)) {
    throw new ServiceError(
      "VALIDATION",
      `"${SUPER_ADMIN_NAME}" is reserved for the system super-admin account.`,
      { name: "This name is reserved" }
    );
  }

  const passwordHash = await bcrypt.hash(input.password, PASSWORD_SALT_ROUNDS);

  try {
    const result = await getPrisma().$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          org_id: actor.orgId,
          userType: "STAFF",
          name: input.name,
          email: input.email,
          phone: input.phone,
          role: input.role,
          password: passwordHash,
          loginEnabled: true,
        },
        select: STAFF_SELECT,
      });

      await activityLog.record(tx, {
        orgId: actor.orgId,
        actorId: actor.id,
        action: "CREATE_STAFF",
        entity: "User",
        entityId: created.id,
        after: JSON.parse(JSON.stringify(created)),
      });

      // role is non-null here — it was just written above as a required
      // StaffRole, unlike the nullable column Prisma's type reflects for the
      // shared User model (customers have no role).
      return created as StaffListItem;
    });
    // After the commit: the new account's first request must see it (a "not allowed" answer may be cached for this id).
    invalidateStaffAuth(actor.orgId, result.id);
    return result;
  } catch (error) {
    // @@unique([org_id, email]) — surfaced as a field error rather than a 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ServiceError("CONFLICT", "A staff account with this email already exists.", {
        email: "Email already in use",
      });
    }
    throw error;
  }
}

export async function updateStaff(
  actor: SessionUser,
  staffId: string,
  rawInput: unknown
): Promise<StaffListItem> {
  const parsed = staffUpdateSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ServiceError(
      "VALIDATION",
      "Please fix the highlighted fields.",
      flattenFieldErrors(parsed.error)
    );
  }
  const input = parsed.data;
  const existing = await getOwnedStaff(actor, staffId);
  const actorIsSuperAdmin = isSuperAdmin(actor);

  // Any existing Administrator account — including the actor's own row — can
  // only be edited here by the super-admin. Regular admins update their own
  // details via My Profile instead; this table is for managing *other*
  // accounts, and no single regular admin should be able to touch another's.
  if (existing.role === "ADMINISTRATOR" && !actorIsSuperAdmin) {
    throw new ServiceError(
      "FORBIDDEN",
      "Only the Administrator account can edit administrator accounts.",
      { role: "Only the Administrator account can edit this account" }
    );
  }
  // Promoting someone into the Administrator role is equally restricted.
  if (input.role === "ADMINISTRATOR" && !actorIsSuperAdmin) {
    throw new ServiceError(
      "FORBIDDEN",
      "Only the Administrator account can grant the administrator role.",
      { role: "Only the Administrator account can assign this role" }
    );
  }
  if (isReservedName(input.name) && !actorIsSuperAdmin) {
    throw new ServiceError(
      "VALIDATION",
      `"${SUPER_ADMIN_NAME}" is reserved for the system super-admin account.`,
      { name: "This name is reserved" }
    );
  }

  const passwordHash = input.password
    ? await bcrypt.hash(input.password, PASSWORD_SALT_ROUNDS)
    : undefined;

  try {
    const result = await getPrisma().$transaction(async (tx) => {
      // The write carries org_id itself (not only getOwnedStaff above): another org's id changes nothing.
      const written = await tx.user.updateMany({
        where: { id: staffId, org_id: actor.orgId, userType: "STAFF" },
        data: {
          name: input.name,
          email: input.email,
          phone: input.phone,
          role: input.role,
          loginEnabled: input.active,
          ...(passwordHash ? { password: passwordHash } : {}),
        },
      });
      if (written.count !== 1) throw new ServiceError("NOT_FOUND", "Staff account not found.");
      const updated = await tx.user.findFirst({ where: { id: staffId, org_id: actor.orgId, userType: "STAFF" }, select: STAFF_SELECT });
      if (!updated) throw new ServiceError("NOT_FOUND", "Staff account not found.");

      await activityLog.record(tx, {
        orgId: actor.orgId,
        actorId: actor.id,
        action: "UPDATE_STAFF",
        entity: "User",
        entityId: updated.id,
        before: {
          name: existing.name,
          email: existing.email,
          phone: existing.phone,
          role: existing.role,
          loginEnabled: existing.loginEnabled,
        },
        after: JSON.parse(JSON.stringify(updated)),
      });

      // An admin-set password, a deactivation or a role change must cut off the
      // account's existing mobile sessions, not wait for them to expire. Same
      // treatment setStaffActive and changeOwnPassword already give.
      const deactivated = existing.loginEnabled && input.active === false;
      const roleChanged = existing.role !== input.role;
      if (passwordHash || deactivated || roleChanged) {
        await revokeAllUserTokens(tx, actor.orgId, staffId);
      }

      return updated as StaffListItem;
    });
    // After the commit: a deactivation or a role change applies on the very next request in this process.
    invalidateStaffAuth(actor.orgId, staffId);
    return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ServiceError("CONFLICT", "A staff account with this email already exists.", {
        email: "Email already in use",
      });
    }
    throw error;
  }
}

export async function setStaffActive(
  actor: SessionUser,
  staffId: string,
  active: boolean
): Promise<StaffListItem> {
  const existing = await getOwnedStaff(actor, staffId);

  // Same rule as updateStaff — no one but the super-admin can activate or
  // deactivate an Administrator account.
  if (existing.role === "ADMINISTRATOR" && !isSuperAdmin(actor)) {
    throw new ServiceError(
      "FORBIDDEN",
      "Only the Administrator account can activate or deactivate administrator accounts."
    );
  }

  const result = await getPrisma().$transaction(async (tx) => {
    const written = await tx.user.updateMany({ where: { id: staffId, org_id: actor.orgId, userType: "STAFF" }, data: { loginEnabled: active } });
    if (written.count !== 1) throw new ServiceError("NOT_FOUND", "Staff account not found.");
    const updated = await tx.user.findFirst({ where: { id: staffId, org_id: actor.orgId, userType: "STAFF" }, select: STAFF_SELECT });
    if (!updated) throw new ServiceError("NOT_FOUND", "Staff account not found.");

    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: active ? "ACTIVATE_STAFF" : "DEACTIVATE_STAFF",
      entity: "User",
      entityId: updated.id,
      before: { loginEnabled: existing.loginEnabled },
      after: { loginEnabled: updated.loginEnabled },
    });

    // Deactivating a staff account must cut off its mobile sessions
    // immediately, not just wait for the next refresh cycle's DB recheck.
    if (!active) {
      await revokeAllUserTokens(tx, actor.orgId, staffId);
    }

    return updated as StaffListItem;
  });
  invalidateStaffAuth(actor.orgId, staffId);
  return result;
}

// ─────────────────────────────────────────────
// OWN PROFILE — every user (any role) edits their own name/phone/password.
// Unlike the staff-management functions above, these never take a `staffId`
// argument — they only ever act on `actor.id`, so there's no owned-record
// lookup to bypass and no role gate to enforce (CD-D2-17, US-03).
// ─────────────────────────────────────────────

export interface OwnProfile {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: StaffRole;
}

const OWN_PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
} satisfies Prisma.UserSelect;

export async function getOwnProfile(orgId: string, userId: string): Promise<OwnProfile> {
  const profile = await getPrisma().user.findFirst({
    where: { id: userId, org_id: orgId },
    select: OWN_PROFILE_SELECT,
  });
  if (!profile) {
    throw new ServiceError("NOT_FOUND", "Profile not found.");
  }
  // role is non-null here — every STAFF row has one; only customers don't,
  // and only STAFF users hold a session that can call this.
  return profile as OwnProfile;
}

export async function updateOwnProfileDetails(
  actor: SessionUser,
  rawInput: unknown
): Promise<OwnProfile> {
  const parsed = profileDetailsSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ServiceError(
      "VALIDATION",
      "Please fix the highlighted fields.",
      flattenFieldErrors(parsed.error)
    );
  }
  const input = parsed.data;

  // The reserved name IS the super-admin identity (see isSuperAdmin), so a
  // regular account must not be able to take it by renaming itself.
  if (isReservedName(input.name) && !isSuperAdmin(actor)) {
    throw new ServiceError(
      "VALIDATION",
      `"${SUPER_ADMIN_NAME}" is reserved for the system super-admin account.`,
      { name: "This name is reserved" }
    );
  }

  const existing = await getOwnProfile(actor.orgId, actor.id);

  try {
    return await getPrisma().$transaction(async (tx) => {
      const written = await tx.user.updateMany({ where: { id: actor.id, org_id: actor.orgId }, data: { name: input.name, email: input.email, phone: input.phone } });
      if (written.count !== 1) throw new ServiceError("NOT_FOUND", "Profile not found.");
      const updated = await tx.user.findFirst({ where: { id: actor.id, org_id: actor.orgId }, select: OWN_PROFILE_SELECT });
      if (!updated) throw new ServiceError("NOT_FOUND", "Profile not found.");

      await activityLog.record(tx, {
        orgId: actor.orgId,
        actorId: actor.id,
        action: "UPDATE_PROFILE",
        entity: "User",
        entityId: actor.id,
        before: { name: existing.name, email: existing.email, phone: existing.phone },
        after: { name: updated.name, email: updated.email, phone: updated.phone },
      });

      return updated as OwnProfile;
    });
  } catch (error) {
    // @@unique([org_id, email]) — surfaced as a field error rather than a 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ServiceError("CONFLICT", "An account with this email already exists.", {
        email: "Email already in use",
      });
    }
    throw error;
  }
}

export async function changeOwnPassword(actor: SessionUser, rawInput: unknown): Promise<void> {
  const parsed = changePasswordSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ServiceError(
      "VALIDATION",
      "Please fix the highlighted fields.",
      flattenFieldErrors(parsed.error)
    );
  }
  const input = parsed.data;

  // Never trust the JWT session for the password hash — fetch it fresh so a
  // stale/forged session can't skip the current-password check.
  const existing = await getPrisma().user.findFirst({
    where: { id: actor.id, org_id: actor.orgId },
    select: { password: true },
  });
  if (!existing?.password) {
    throw new ServiceError("NOT_FOUND", "Account not found.");
  }

  const currentValid = await bcrypt.compare(input.currentPassword, existing.password);
  if (!currentValid) {
    throw new ServiceError("VALIDATION", "Current password is incorrect.", {
      currentPassword: "Current password is incorrect",
    });
  }

  const passwordHash = await bcrypt.hash(input.newPassword, PASSWORD_SALT_ROUNDS);

  await getPrisma().$transaction(async (tx) => {
    const written = await tx.user.updateMany({ where: { id: actor.id, org_id: actor.orgId }, data: { password: passwordHash } });
    if (written.count !== 1) throw new ServiceError("NOT_FOUND", "Profile not found.");

    // No before/after snapshot here — a password hash has no business being
    // written to the audit trail, even hashed.
    await activityLog.record(tx, {
      orgId: actor.orgId,
      actorId: actor.id,
      action: "CHANGE_PASSWORD",
      entity: "User",
      entityId: actor.id,
    });

    // Standard "changing your password logs out every other session"
    // behavior — a leaked old password's still-valid mobile refresh token
    // must not remain usable after rotation. Does not touch the separate
    // web NextAuth cookie session.
    await revokeAllUserTokens(tx, actor.orgId, actor.id);
  });
}
