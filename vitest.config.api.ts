/**
 * Vitest config for API-driven integration tests.
 *
 * These tests run against the live dev server (no WebDriver needed).
 * Start the app with `npm run tauri dev` first, then run:
 *   npx vitest run --config vitest.config.api.ts
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/api/**/*.test.ts"],
    globalSetup: ["tests/api/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    // Run serially — tests share a single live app instance
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    reporters: ["verbose"],
  },
});
