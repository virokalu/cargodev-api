// Real-Postgres tests. Run with `npm run test:db` against a throwaway database only:
// TEST_DATABASE_URL must point at localhost (or the CI service container) and a database whose
// name starts with cargodev_test. The setup refuses to run otherwise. See docs/testing.md.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/db/**/*.db.test.ts"],
    environment: "node",
    setupFiles: ["tests/db/setup-env.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    // One shared database: files run one at a time, and each test starts from empty tables.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
