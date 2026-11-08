import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, type Frame, type Page } from "@playwright/test";
import { type ArtifactId, artifactHost, viewerUrl } from "./hosts.ts";
import { startProxy } from "./proxy.ts";
import { type ContentRequest, type SpikeServer, startServer } from "./server.ts";

// The observed behavior of one engine configuration. Tests assert against it, so a browser
// update that changes any of these facts fails the spike instead of passing silently.
export interface EngineProfile {
  // Whether this project blocks unpartitioned third-party cookies. The unpartitioned control
  // cookie must then be missing from every iframe request.
  blocksThirdPartyCookies: boolean;
  // Whether the `Partitioned` review cookie set inside the viewer iframe is stored and sent.
  partitionedCookieWorks: boolean;
  // Outcome of document.requestStorageAccess() in the iframe when the partitioned cookie fails.
  storageAccess?: "denied" | "granted-without-cookies" | "granted-with-cookies";
  // Whether a sibling can set `__host-pf_review` (lowercase prefix) with a Domain attribute.
  acceptsLowercaseHostPrefixWithDomain: boolean;
  // Chromium only: run in a persistent profile whose preferences block third-party cookies.
  chromiumBlockThirdPartyCookies?: boolean;
}

export interface ArtifactData {
  artifact: ArtifactId;
  mode: "review" | "public";
  reviewValues: string[];
  cookieNames: string[];
}

interface WorkerFixtures {
  spike: SpikeServer;
  proxyUrl: string;
}

interface TestFixtures {
  engine: EngineProfile;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  engine: [
    {
      blocksThirdPartyCookies: true,
      partitionedCookieWorks: true,
      acceptsLowercaseHostPrefixWithDomain: false,
    },
    { option: true },
  ],
  spike: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
    async ({}, use) => {
      const server = await startServer();
      await use(server);
      await server.close();
    },
    { scope: "worker" },
  ],
  proxyUrl: [
    async ({ spike }, use) => {
      const proxy = await startProxy(spike.port);
      await use(proxy.url);
      await proxy.close();
    },
    { scope: "worker" },
  ],
  proxy: async ({ proxyUrl }, use) => {
    await use({ server: proxyUrl });
  },
  ignoreHTTPSErrors: true,
  context: async ({ context, engine, playwright, proxyUrl }, use) => {
    if (!engine.chromiumBlockThirdPartyCookies) {
      await use(context);
      return;
    }
    // Chromium has no launch switch for this setting, so the test profile starts with the
    // preference that the "Block third-party cookies" option writes.
    const dir = mkdtempSync(join(tmpdir(), "pf-review-spike-chromium-"));
    mkdirSync(join(dir, "Default"));
    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }),
    );
    // The headless shell is not Chrome and ignores profile preferences; the `chromium`
    // channel runs the full browser in new headless mode.
    const persistent = await playwright.chromium.launchPersistentContext(dir, {
      channel: "chromium",
      proxy: { server: proxyUrl },
      ignoreHTTPSErrors: true,
    });
    try {
      await use(persistent);
    } finally {
      await persistent.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  page: async ({ context }, use) => {
    await use(await context.newPage());
  },
});

export { expect } from "@playwright/test";

export const SUBRESOURCES = ["/", "/style.css", "/app.js", "/pixel.svg", "/data.json"];

export function artifactFrame(page: Page, id: ArtifactId): Frame | undefined {
  return page.frames().find((frame) => new URL(frame.url()).host === artifactHost(id));
}

// Waits until the iframe has left the code exchange and the artifact page finished loading
// its subresources. Navigations inside the frame can reset the wait, so it retries.
export async function waitForArtifactFrame(page: Page, id: ArtifactId): Promise<Frame> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const frame = artifactFrame(page, id);
    if (frame && !new URL(frame.url()).pathname.startsWith("/__portifact/")) {
      const ready = await frame
        .waitForFunction(
          () => {
            const pixel = document.getElementById("pixel");
            return pixel instanceof HTMLImageElement && pixel.complete && "spike" in window;
          },
          undefined,
          { timeout: 2_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (ready) return frame;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`artifact frame for ${id} never finished loading`);
}

export async function openViewer(page: Page, id: ArtifactId, path = "/"): Promise<Frame> {
  await page.goto(viewerUrl(id, path));
  return waitForArtifactFrame(page, id);
}

export async function frameData(frame: Frame): Promise<ArtifactData> {
  return frame.evaluate(
    () => (window as unknown as { spike: { data: Promise<ArtifactData> } }).spike.data,
  );
}

export async function refetchData(frame: Frame): Promise<ArtifactData> {
  return frame.evaluate(() =>
    (window as unknown as { spike: { refetch(): Promise<ArtifactData> } }).spike.refetch(),
  );
}

export function requestsSince(spike: SpikeServer, start: number, id: ArtifactId): ContentRequest[] {
  return spike.requests.slice(start).filter((request) => request.artifact === id);
}

export function liveSessionsFor(spike: SpikeServer, id: ArtifactId): string[] {
  return [...spike.sessions].filter(([, artifact]) => artifact === id).map(([session]) => session);
}
