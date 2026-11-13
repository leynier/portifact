import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, test as base, type Frame, type Page } from "@playwright/test";
import { APP_ORIGIN, type ArtifactId, artifactHost, artifactOrigin } from "./hosts.ts";
import { startProxy } from "./proxy.ts";
import { type GrantServer, startServer } from "./server.ts";

/** What the grant flows should do in one engine configuration (decision 0002's measurements). */
export interface EngineProfile {
  /** Ordinary third-party cookies are blocked in this configuration. */
  blocksThirdPartyCookies: boolean;
  /** The partitioned cookies of the frame flow are kept in the viewer's frame. */
  frameWorks: boolean;
  /** Chromium only: a profile whose preferences block third-party cookies. */
  chromiumProfile?: boolean;
}

/**
 * The renewal period the server uses: production renews claims every 60 seconds; the tests use
 * 3 seconds so the revocation bound is measured on the same code path in a few seconds.
 */
export const CLAIMS_MS = 3_000;

interface WorkerFixtures {
  grantServer: GrantServer;
  proxyUrl: string;
}

interface TestFixtures {
  engine: EngineProfile;
  /** Another browser (its own cookie jar and profile), for the person who did not ask. */
  openBrowser: () => Promise<BrowserContext>;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  engine: [{ blocksThirdPartyCookies: true, frameWorks: true }, { option: true }],
  grantServer: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
    async ({}, use) => {
      const server = await startServer({ claimsMs: CLAIMS_MS });
      await use(server);
      await server.close();
    },
    { scope: "worker" },
  ],
  proxyUrl: [
    async ({ grantServer }, use) => {
      const proxy = await startProxy(grantServer.port);
      await use(proxy.url);
      await proxy.close();
    },
    { scope: "worker" },
  ],
  proxy: async ({ proxyUrl }, use) => {
    await use({ server: proxyUrl });
  },
  ignoreHTTPSErrors: true,
  openBrowser: async ({ browser, engine, playwright, proxyUrl }, use) => {
    const opened: { context: BrowserContext; dir?: string }[] = [];
    await use(async () => {
      if (!engine.chromiumProfile) {
        const context = await browser.newContext({
          proxy: { server: proxyUrl },
          ignoreHTTPSErrors: true,
        });
        opened.push({ context });
        return context;
      }
      const dir = chromiumProfile();
      const context = await playwright.chromium.launchPersistentContext(dir, {
        channel: "chromium",
        proxy: { server: proxyUrl },
        ignoreHTTPSErrors: true,
      });
      opened.push({ context, dir });
      return context;
    });
    for (const { context, dir } of opened) {
      await context.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  },
  context: async ({ context, openBrowser, engine }, use) => {
    // Chromium blocks third-party cookies only through a profile preference, so its "first
    // browser" is a persistent profile too.
    await use(engine.chromiumProfile ? await openBrowser() : context);
  },
  page: async ({ context }, use) => {
    await use(await context.newPage());
  },
});

export { expect } from "@playwright/test";

/** A profile directory with the preference "Block third-party cookies" (decision 0002). */
function chromiumProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pf-grant-spike-chromium-"));
  mkdirSync(join(dir, "Default"));
  writeFileSync(
    join(dir, "Default", "Preferences"),
    JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }),
  );
  return dir;
}

export async function signIn(context: BrowserContext, user: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`${APP_ORIGIN}/test/signin?user=${user}&name=${user}`);
  await page.close();
}

export interface Answer {
  status: number;
  body: string;
}

export async function me(target: Page | Frame): Promise<Answer> {
  await target.waitForFunction(() => "spike" in window);
  return target.evaluate(() =>
    (window as unknown as { spike: { me(): Promise<Answer> } }).spike.me(),
  );
}

export async function write(target: Page | Frame, text: string): Promise<Answer> {
  await target.waitForFunction(() => "spike" in window);
  return target.evaluate(
    (value) =>
      (window as unknown as { spike: { write(t: string): Promise<Answer> } }).spike.write(value),
    text,
  );
}

export function artifactFrame(page: Page, id: ArtifactId): Frame | undefined {
  return page.frames().find((frame) => {
    try {
      return new URL(frame.url()).host === artifactHost(id);
    } catch {
      return false;
    }
  });
}

/** Waits until the viewer's frame shows the artifact's own page again (not a Portifact page). */
export async function artifactPageInFrame(page: Page, id: ArtifactId): Promise<Frame> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const frame = artifactFrame(page, id);
    if (frame && new URL(frame.url()).pathname === "/") {
      const ready = await frame
        .waitForFunction(() => "spike" in window, undefined, { timeout: 1_000 })
        .then(() => true)
        .catch(() => false);
      if (ready) return frame;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`the artifact page never loaded in the frame for ${id}`);
}

/** The direct-visit flow in the same tab: begin, the control on the app, Allow, back. */
export async function grantInThisTab(page: Page, id: ArtifactId): Promise<void> {
  await page.goto(`${artifactOrigin(id)}/`);
  await page.click("#save-here");
  await page.waitForURL(`${APP_ORIGIN}/data/consent?**`);
  await page.click("#allow");
  await page.waitForURL(`${artifactOrigin(id)}/`);
}
