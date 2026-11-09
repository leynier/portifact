import { defineConfig, devices } from "@playwright/test";

// The landing page's product screenshots and terminal transcripts (bun run landing:shots): one
// Chromium run against the same stack as the end-to-end suite. Not part of bun run test:e2e.
export default defineConfig({
  testDir: ".",
  testMatch: "*.shots.ts",
  globalSetup: "../global-setup.ts",
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 600_000,
  expect: { timeout: 20_000 },
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
});
