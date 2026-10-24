import { describe, expect, it } from "vitest";
import { mobileLoginSchema } from "../src/validation/mobile-auth.schema.js";
import { changePasswordSchema } from "../src/validation/profile.schema.js";
import { newPasswordSchema } from "../src/validation/shared.js";
import { staffCreateSchema, staffUpdateSchema } from "../src/validation/user.schema.js";

describe("new password policy", () => {
  const ok = "example-12-chars";

  it("accepts 12 characters and rejects 11", () => {
    expect(newPasswordSchema.safeParse("a".repeat(12)).success).toBe(true);
    expect(newPasswordSchema.safeParse("a".repeat(11)).success).toBe(false);
  });

  it("accepts exactly 72 bytes and rejects 73 (bcrypt ignores the rest)", () => {
    expect(newPasswordSchema.safeParse("a".repeat(72)).success).toBe(true);
    const result = newPasswordSchema.safeParse("a".repeat(73));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Must be 72 bytes or fewer");
  });

  it("counts bytes, not characters", () => {
    // 3 bytes each in UTF-8: 25 characters = 75 bytes.
    expect(newPasswordSchema.safeParse("あ".repeat(25)).success).toBe(false);
    expect(newPasswordSchema.safeParse("あ".repeat(24)).success).toBe(true);
  });

  it("applies to staff create, staff update (when set) and change-password", () => {
    const staff = { name: "N", email: "n@example.test", phone: "", role: "OPERATOR" };
    expect(staffCreateSchema.safeParse({ ...staff, password: "example-s1" }).success).toBe(false);
    expect(staffCreateSchema.safeParse({ ...staff, password: ok }).success).toBe(true);

    const update = { ...staff, active: true };
    expect(staffUpdateSchema.safeParse({ ...update, password: "" }).success).toBe(true); // blank = unchanged
    expect(staffUpdateSchema.safeParse({ ...update, password: "example-s1" }).success).toBe(false);
    expect(staffUpdateSchema.safeParse({ ...update, password: "a".repeat(73) }).success).toBe(false);
    expect(staffUpdateSchema.safeParse({ ...update, password: ok }).success).toBe(true);

    const change = (newPassword: string) =>
      changePasswordSchema.safeParse({ currentPassword: "x", newPassword, confirmPassword: newPassword }).success;
    expect(change("example-s1")).toBe(false);
    expect(change(ok)).toBe(true);
  });

  it("login stays lenient so older, weaker passwords still work", () => {
    expect(mobileLoginSchema.safeParse({ email: "a@example.test", password: "short" }).success).toBe(true);
  });
});
