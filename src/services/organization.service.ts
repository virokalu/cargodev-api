// Organization lookup. Phase 1 has exactly one org (the default org config), but this
// still takes orgId as a parameter rather than reading the default org itself —
// keeps it ready for Phase 2 multi-tenant routing with no signature change.

import { getPrisma } from "../lib/prisma.js";

export async function getOrganizationName(orgId: string): Promise<string> {
  const org = await getPrisma().organization.findUnique({
    where: { id: orgId },
    select: { name: true },
  });
  // Falls back to the seeded name if the row is ever missing — display text
  // should never crash a page render.
  return org?.name ?? "Example Organization";
}
