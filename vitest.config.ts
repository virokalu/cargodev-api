import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Real-database tests have their own config (vitest.db.config.ts) and a throwaway database.
    exclude: ["tests/db/**", "node_modules/**"],
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
  },
});
