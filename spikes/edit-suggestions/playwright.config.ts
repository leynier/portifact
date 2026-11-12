import { defineConfig, devices } from "@playwright/test";

// The browser differential of decision 0027: parse5 against real engines for the HTML contexts the
// subset refuses, and the preview document loading nothing. Run with `bun run --cwd
// spikes/edit-suggestions browser`; not part of `bun run test`, like `spikes/review-cookies`.
export default defineConfig({
  testDir: "./browser",
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
