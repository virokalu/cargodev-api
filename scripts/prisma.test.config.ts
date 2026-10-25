// Prisma CLI config for the TEST HARNESS ONLY, used as:
//   prisma migrate diff --config scripts/prisma.test.config.ts --from-empty --to-schema ... --script
//
// Prisma 7's schema engine will not run without a datasource, even for an offline diff
// that never connects. This repo has no root prisma.config.ts on purpose (migrations only run
// through the guarded scripts/migrate.ts, ADR 0004), so this file is
// kept out of the default lookup and only ever sees TEST_DATABASE_URL, never DATABASE_URL.

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "../prisma/schema.prisma",
  datasource: {
    url: process.env["TEST_DATABASE_URL"] ?? "postgresql://localhost:5432/cargodev_test_unused",
  },
});
