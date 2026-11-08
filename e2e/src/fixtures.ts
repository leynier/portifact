import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, test as base, type Frame, type Page } from "@playwright/test";
import { APP_ORIGIN, artifactOrigin, CONTENT_SITE, SESSION_COOKIE } from "./hosts.ts";
import type { ContentRequest } from "./stack.ts";

/** What review mode should do in one engine configuration. */
export interface EngineProfile {
  /** Ordinary third-party cookies are blocked: the control cookie never comes back. */
  blocksThirdPartyCookies: boolean;
  /** The partitioned review cookie works in the viewer's frame. */
  reviewWorks: boolean;
  /** Chromium only: a profile whose preferences block third-party cookies. */
  chromiumProfile?: boolean;
}

export interface User {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  cookie: string;
}

export interface Published {
  artifactId: string;
  versionId: string;
}

function controlUrl(): string {
  const url = process.env.PF_E2E_CONTROL;
  if (!url) throw new Error("the e2e stack is not running (global-setup.ts)");
  return url;
}

/** Calls a seeding or inspection endpoint of the e2e Worker (e2e/worker/control.ts). */
export async function control<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${controlUrl()}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  return (await response.json()) as T;
}

export async function createUser(name: string): Promise<User> {
  const email = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const user = await control<Omit<User, "email" | "name">>("/user", { email, name });
  return { ...user, email, name };
}

export function publish(input: {
  ownerId: string;
  type?: "site" | "markdown" | "text";
  name: string;
  files: Record<string, string>;
  accessMode?: "public" | "authenticated" | "restricted";
  readers?: string[];
  /** Publishes a new version of an existing artifact, keeping its access and comment mode. */
  update?: { artifactId: string; baseVersionId: string };
}): Promise<Published> {
  return control<Published>("/publish", { type: "site", ...input });
}

/** The owner's access change, through the access service the API and dashboard use. */
export function changeAccess(input: {
  ownerId: string;
  artifactId: string;
  addReaders?: string[];
  removeReaders?: string[];
}): Promise<{ ok: boolean }> {
  return control("/access", input);
}

/**
 * Runs the content Worker's clock `offsetMs` ahead of real time (0 puts it back), so a test can
 * pass a delivery time window without waiting. Reset it in a `finally`.
 */
export async function setContentClock(offsetMs: number): Promise<void> {
  await control("/clock", { offsetMs });
}

export function sql<T>(query: string, params: (string | number | null)[] = []): Promise<T[]> {
  return control<T[]>("/sql", { query, params });
}

/** Like `sql`, against the access log database. */
export function accessSql<T>(query: string, params: (string | number | null)[] = []): Promise<T[]> {
  return control<T[]>("/sql", { query, params, database: "access" });
}

/** Requests browsers sent to artifact hosts so far, as the content Worker saw them. */
export async function contentRequests(): Promise<ContentRequest[]> {
  return (await (await fetch(`${controlUrl()}/requests`)).json()) as ContentRequest[];
}

export async function signIn(context: BrowserContext, user: User): Promise<void> {
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: user.cookie,
      url: APP_ORIGIN,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

/** The artifact frame of the viewer, once it shows the artifact itself. */
export async function artifactFrame(page: Page, artifactId: string): Promise<Frame> {
  const host = `${artifactId}.${CONTENT_SITE}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const frame = page
      .frames()
      .find(
        (f) =>
          f.url().startsWith(`https://${host}/`) &&
          !new URL(f.url()).pathname.startsWith("/__portifact/"),
      );
    if (frame) {
      await frame.waitForLoadState("load");
      return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`the frame never showed ${artifactOrigin(artifactId)}`);
}

export async function openReview(page: Page, artifactId: string, name: string): Promise<void> {
  await page.goto(`${APP_ORIGIN}/review/${artifactId}`);
  await page.getByRole("heading", { level: 1, name: `Review ${name}` }).waitFor();
}

interface Fixtures {
  engine: EngineProfile;
}

export const test = base.extend<Fixtures>({
  engine: [{ blocksThirdPartyCookies: true, reviewWorks: true }, { option: true }],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
  proxy: async ({}, use) => {
    const server = process.env.PF_E2E_PROXY;
    if (!server) throw new Error("the e2e stack is not running (global-setup.ts)");
    await use({ server });
  },
  ignoreHTTPSErrors: true,
  context: async ({ context, engine, playwright, proxy }, use) => {
    if (!engine.chromiumProfile) {
      await use(context);
      return;
    }
    // Chromium has no launch switch for "Block third-party cookies"; the profile starts with the
    // preference that setting writes. The headless shell ignores profile preferences, so the
    // `chromium` channel runs the full browser in new headless mode.
    const dir = mkdtempSync(join(tmpdir(), "pf-e2e-chromium-"));
    mkdirSync(join(dir, "Default"));
    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }),
    );
    const persistent = await playwright.chromium.launchPersistentContext(dir, {
      channel: "chromium",
      ...(proxy ? { proxy } : {}),
      ignoreHTTPSErrors: true,
      // Without the switch, Chromium sometimes fails a service worker script fetch on the
      // throwaway certificate before sending it, which ignoreHTTPSErrors does not cover.
      args: ["--ignore-certificate-errors"],
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
