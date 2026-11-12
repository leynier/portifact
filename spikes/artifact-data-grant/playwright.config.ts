import { defineConfig, devices } from "@playwright/test";
import type { EngineProfile } from "./src/fixtures.ts";

// The e2e suite's projects (e2e/playwright.config.ts), same names, so CI's e2e matrix job of
// each engine runs this experiment too. `frameWorks` is what decision 0002 measured for
// partitioned cookies in the viewer's frame; the tests assert it, so a browser change fails the
// experiment instead of passing silently. Playwright's WebKit uses Apple's network stack on
// macOS and libsoup on Linux; only the macOS run stands in for Safari.
const webkitOnMac = process.platform === "darwin";

export default defineConfig<{ engine: EngineProfile }>({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium-3pc-blocked",
      use: {
        ...devices["Desktop Chrome"],
        engine: { blocksThirdPartyCookies: true, frameWorks: true, chromiumProfile: true },
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
        engine: { blocksThirdPartyCookies: true, frameWorks: true },
      },
    },
    {
      // "All third-party cookies" blocked: partitioned cookies too, so the frame flow falls back.
      name: "firefox-3pc-blocked",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: { firefoxUserPrefs: { "network.cookie.cookieBehavior": 1 } },
        engine: { blocksThirdPartyCookies: true, frameWorks: false },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        engine: { blocksThirdPartyCookies: true, frameWorks: webkitOnMac },
      },
    },
  ],
});
