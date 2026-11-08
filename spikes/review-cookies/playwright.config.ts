import { defineConfig, devices } from "@playwright/test";
import type { EngineProfile } from "./src/fixtures.ts";

// Each project is one engine configuration, with third-party cookies blocked wherever the
// engine exposes that setting. `engine` records what the spike observed for that
// configuration; the tests assert it. See docs/decisions/0002-review-mode-cookies.md.

// Playwright's WebKit uses Apple's network stack on macOS and libsoup on Linux. Cookie
// partitioning lives in that layer, so only the macOS run stands in for Safari.
const webkitOnMac = process.platform === "darwin";

export default defineConfig<{ engine: EngineProfile }>({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      // Chrome 156 still allows third-party cookies by default. The profile preference is the
      // one written by Settings > Privacy > Third-party cookies > Block third-party cookies.
      name: "chromium-3pc-blocked",
      use: {
        ...devices["Desktop Chrome"],
        engine: {
          blocksThirdPartyCookies: true,
          partitionedCookieWorks: true,
          acceptsLowercaseHostPrefixWithDomain: false,
          chromiumBlockThirdPartyCookies: true,
        },
      },
    },
    {
      // Firefox default (Standard and Strict): Total Cookie Protection partitions every
      // third-party cookie instead of rejecting it.
      name: "firefox-default-tcp",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: { firefoxUserPrefs: { "network.cookie.cookieBehavior": 5 } },
        engine: {
          blocksThirdPartyCookies: false,
          partitionedCookieWorks: true,
          acceptsLowercaseHostPrefixWithDomain: false,
        },
      },
    },
    {
      // Firefox keeping only opted-in partitioned cookies in third-party contexts: plain
      // third-party cookies are blocked and `Partitioned` cookies are kept.
      name: "firefox-chips-opt-in",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: {
            "network.cookie.cookieBehavior": 5,
            "network.cookie.cookieBehavior.optInPartitioning": true,
          },
        },
        engine: {
          blocksThirdPartyCookies: true,
          partitionedCookieWorks: true,
          acceptsLowercaseHostPrefixWithDomain: false,
        },
      },
    },
    {
      // Firefox "Custom > Cookies: All third-party cookies". Rejects partitioned cookies too.
      name: "firefox-3pc-blocked",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: { firefoxUserPrefs: { "network.cookie.cookieBehavior": 1 } },
        engine: {
          blocksThirdPartyCookies: true,
          partitionedCookieWorks: false,
          storageAccess: "denied",
          acceptsLowercaseHostPrefixWithDomain: false,
        },
      },
    },
    {
      // WebKit blocks third-party cookies by default; Playwright exposes no switch for it.
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        engine: webkitOnMac
          ? {
              blocksThirdPartyCookies: true,
              partitionedCookieWorks: true,
              acceptsLowercaseHostPrefixWithDomain: true,
            }
          : {
              blocksThirdPartyCookies: true,
              partitionedCookieWorks: false,
              storageAccess: "granted-without-cookies",
              acceptsLowercaseHostPrefixWithDomain: false,
            },
      },
    },
  ],
});
