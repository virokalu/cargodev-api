// Fake two-org fixtures shared by service tests. No real names, ids or data.

import type { SessionUser } from "../../src/lib/session-user.js";

export const ORG_A = "org_test_a";
export const ORG_B = "org_test_b";

export function actor(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "user_a_manager",
    role: "MANAGER",
    orgId: ORG_A,
    name: "Test Manager A",
    email: "manager.a@example.test",
    ...overrides,
  };
}

export const actorA = actor();
export const actorB = actor({
  id: "user_b_manager",
  orgId: ORG_B,
  name: "Test Manager B",
  email: "manager.b@example.test",
});
