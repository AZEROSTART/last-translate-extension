import { defineConfig } from "@playwright/test";

/**
 * Extension E2E only. Unit tests stay in Vitest (`tests/unit/**`), and each
 * spec starts its own mock provider + fixture HTTP server, so there is no
 * `webServer` here.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
});
