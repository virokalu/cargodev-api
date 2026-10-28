// Fake seed data for the real-database tests. Nothing here is real.

import type { Prisma, PrismaClient } from "@prisma/client";

export const ORG_A = "org_db_test_a";
export const ORG_B = "org_db_test_b";

/** Two orgs, each with FC and FL serial counters starting at 0. */
export async function seedTwoOrgs(prisma: PrismaClient): Promise<void> {
  for (const [id, name] of [[ORG_A, "Test Org A"], [ORG_B, "Test Org B"]] as const) {
    await prisma.organization.create({ data: { id, name } });
    await prisma.serialCounter.createMany({
      data: [
        { org_id: id, prefix: "FC", lastNumber: 0 },
        { org_id: id, prefix: "FL", lastNumber: 0 },
      ],
    });
  }
}

/** The smallest valid Vehicle row. Everything else is optional or defaulted. */
export function minimalVehicle(
  org_id: string,
  serialNumber: number,
  over: Partial<Prisma.VehicleUncheckedCreateInput> = {}
): Prisma.VehicleUncheckedCreateInput {
  const serialPrefix = over.serialPrefix ?? "FC";
  return { org_id, serialPrefix, serialNumber, serial: `${serialPrefix}${serialNumber}`, ...over };
}
