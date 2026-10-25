// Prisma CLI config for MIGRATIONS, used only by scripts/migrate.ts (which runs the guard first):
//   prisma migrate <dev|deploy|status|diff> --config scripts/prisma.migrate.config.ts
//
// It reads MIGRATION_DATABASE_URL and nothing else. It never reads DATABASE_URL or DIRECT_URL, and
// scripts/migrate.ts removes those from the child process environment as well.

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "../prisma/schema.prisma",
  migrations: { path: "../prisma/migrations" },
  datasource: {
    url: process.env["MIGRATION_DATABASE_URL"] ?? "postgresql://localhost:5432/cargodev_migration_unset",
  },
});
