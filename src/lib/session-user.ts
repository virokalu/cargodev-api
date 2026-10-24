// The authenticated staff actor, attached by the auth hook from the verified
// access token. Replaces the Next-specific SessionUser from next-auth.

import type { StaffRole } from "@prisma/client";

export interface SessionUser {
  id: string;
  role: StaffRole;
  orgId: string;
  name: string;
  email: string | null;
}
