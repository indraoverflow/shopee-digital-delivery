import { defineConfig } from "vitest/config";

/**
 * One vitest process for the whole workspace. Tests run against pglite (real
 * PostgreSQL in WASM) and the fixture Shopee gateway, so no test needs a
 * container, a network call or a Shopee partner key.
 */
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/api/test/**/*.test.ts", "apps/worker/test/**/*.test.ts"],
    environment: "node",
    globals: false,
    reporters: ["default"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
