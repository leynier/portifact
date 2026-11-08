import { defineConfig, devices } from "@playwright/test";
import type { EngineProfile } from "./src/fixtures.ts";

// One project per engine configuration, with third-party cookies blocked wherever the engine
// exposes that setting, as decision 0002 measured them. `engine` states what review mode
// should do there; the tests assert it, including the fallback where partitioned cookies do not
// work. Playwright's WebKit uses Apple's network stack on macOS and libsoup on Linux; only the
// macOS run stands in for Safari.
const webkitOnMac = process.platform === "darwin";

export default defineConfig<{ engine: EngineProfile }>({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  // No retries: a flaky test here usually hides a race in review mode or the stack, so it fails
  // and keeps its trace (test-results/, uploaded by CI) instead of passing on a second try.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium-3pc-blocked",
      use: {
        ...devices["Desktop Chrome"],
        engine: { blocksThirdPartyCookies: true, reviewWorks: true, chromiumProfile: true },
      },
    },
    {
      // Only cookies marked Partitioned survive in third-party contexts.
      name: "firefox-chips",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: {
            "network.cookie.cookieBehavior": 5,
            "network.cookie.cookieBehavior.optInPartitioning": true,
          },
        },
        engine: { blocksThirdPartyCookies: true, reviewWorks: true },
      },
    },
    {
      // "All third-party cookies" blocked: partitioned cookies too, so review falls back.
      name: "firefox-3pc-blocked",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: { firefoxUserPrefs: { "network.cookie.cookieBehavior": 1 } },
        engine: { blocksThirdPartyCookies: true, reviewWorks: false },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        engine: { blocksThirdPartyCookies: true, reviewWorks: webkitOnMac },
      },
    },
  ],
});
