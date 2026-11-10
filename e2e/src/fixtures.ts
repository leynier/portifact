import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserContext,
  test as base,
  expect,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";
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

export async function createUser(name: string, at?: string): Promise<User> {
  const local = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${local}@${at ?? "example.test"}`;
  const user = await control<Omit<User, "email" | "name">>("/user", { email, name });
  return { ...user, email, name };
}

export function publish(input: {
  ownerId: string;
  /** A workspace to publish into as `ownerId`. */
  targetOwnerId?: string;
  type?: "site" | "markdown" | "text";
  name: string;
  files: Record<string, string>;
  accessMode?: "public" | "authenticated" | "restricted" | "workspace" | "domain";
  readers?: string[];
  annotations?: "off" | "open" | "locked";
  /**
   * The Portifact bar, on by default like in production. Tests of what a top-level visit to the
   * artifact gets (the artifact itself) turn it off.
   */
  bar?: boolean;
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

/** Runs the waiting content search jobs now, as the jobs Worker would (decision 0012). */
export function runSearchIndexing(): Promise<{ ran: number; outcomes: string[] }> {
  return control("/search-index", {});
}

/** Gives an owner a plan, as the operator's grant writes the row. */
export async function grantPlan(ownerId: string, plan: "free" | "pro" | "team"): Promise<void> {
  await sql(
    "insert into owner_plans (owner_id, plan, seats, granted_by, updated_at) values (?, ?, 1, 'e2e', ?) on conflict (owner_id) do update set plan = excluded.plan",
    [ownerId, plan, Date.now()],
  );
}

/**
 * A workspace as the operator creates it, on a Team plan with `seats` seats (10 by default), with
 * `admin` as its first admin and any other members given.
 */
export function createWorkspace(input: {
  slug: string;
  name: string;
  admin: User;
  seats?: number;
  members?: { user: User; role: "admin" | "editor" | "member" }[];
}): Promise<{ id: string; slug: string; name: string }> {
  return control("/workspace", {
    slug: input.slug,
    name: input.name,
    adminUserId: input.admin.userId,
    seats: input.seats,
    members: (input.members ?? []).map((m) => ({ userId: m.user.userId, role: m.role })),
  });
}

/** Publishes a TXT record in the stack's fake DNS, or reports a hostname active in its Cloudflare. */
export function fakeDomains(input: {
  txt?: { name: string; value: string };
  activate?: string;
  attach?: { hostname: string; artifactId: string };
}): Promise<{ ok: boolean }> {
  return control("/domains", input);
}

/** A share link of the artifact, created by its owner; the URL holds the token. */
export function createShareLink(input: {
  ownerId: string;
  artifactId: string;
  label?: string;
  expiresAt?: number;
  password?: string;
}): Promise<{ id: string; url: string; token: string }> {
  return control("/share-link", input);
}

export function revokeShareLink(input: {
  ownerId: string;
  artifactId: string;
  linkId: string;
}): Promise<{ ok: boolean }> {
  return control("/share-link", { ...input, revoke: input.linkId });
}

/**
 * Runs the content Worker's clock `offsetMs` ahead of real time for one artifact (0 puts it
 * back), so a test can pass a delivery time window without waiting. Other artifacts keep real
 * time, so tests running next to it are not affected. Reset it in a `finally`.
 */
export async function setContentClock(artifactId: string, offsetMs: number): Promise<void> {
  await control("/clock", { artifactId, offsetMs });
}

export interface SentEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * The last email the app sent to `to`, waiting briefly for it to arrive. Reading it gives back the
 * per-IP sign-in code budget: every browser of the stack shares one address, and the code limit
 * per IP (`OTP_LIMITS.perIp`, 20 an hour) would otherwise run out across the projects of a run,
 * leaving the last one (WebKit in CI) refused with 429 and no email to read.
 */
export async function lastEmail(to: string): Promise<SentEmail> {
  const deadline = Date.now() + 10_000;
  try {
    for (;;) {
      try {
        return await control<SentEmail>("/mail", { to });
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  } finally {
    await sql("delete from rate_limits where key like 'otp:ip:%'");
  }
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

/**
 * Lets the dashboard's presigned uploads from this page reach the stack: the browser sends them
 * to the bucket's S3 endpoint (`<account>.r2.cloudflarestorage.com`), which the proxy does not
 * map, so they are forwarded to the control host's storage stand-in (as `shots/cli.ts` does for
 * the CLI), with the CORS answers the bucket's rule would give. Test-only, at the network edge.
 * Playwright's WebKit does not hand the body of a `File` or `Blob` upload to request
 * interception (`postDataBuffer()` is null there), so the stand-in would get an empty body and
 * refuse it: tests that upload from the browser stop before the upload in WebKit.
 */
export async function routeStorage(page: Page): Promise<void> {
  await page.route(/^https:\/\/[^/]+\.r2\.cloudflarestorage\.com\//, async (route) => {
    const request = route.request();
    const cors = {
      "access-control-allow-origin": APP_ORIGIN,
      "access-control-allow-methods": "GET, PUT",
      "access-control-allow-headers": "*",
      "access-control-expose-headers": "etag",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const url = new URL(request.url());
    const [, ...key] = url.pathname.split("/").slice(1).map(decodeURIComponent);
    const query = new URLSearchParams({ key: key.join("/") });
    for (const name of ["uploadId", "partNumber"]) {
      const value = url.searchParams.get(name);
      if (value !== null) query.set(name, value);
    }
    const body = request.postDataBuffer() ?? Buffer.alloc(0);
    const headers = await request.allHeaders();
    const response = await fetch(`${controlUrl()}/storage?${query}`, {
      method: request.method(),
      headers: {
        "content-length": String(body.byteLength),
        "x-amz-checksum-sha256": headers["x-amz-checksum-sha256"] ?? "",
      },
      body: new Uint8Array(body),
    });
    await route.fulfill({
      status: response.status,
      headers: {
        ...cors,
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag") as string } : {}),
      },
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
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

/** Opens the viewer with the Portifact bar on the artifact, from the app. */
export async function openReview(page: Page, artifactId: string, name: string): Promise<void> {
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  await page.getByRole("heading", { level: 1, name }).waitFor();
}

/**
 * Opens a disclosure (a `details` element) by its summary. In the viewer the sidebar moves while
 * the frame connects (the tools above the list appear), so a click aimed at the summary can land
 * where it used to be and toggle nothing: click until the disclosure reports that it is open,
 * never when it already is, which would close it.
 */
export async function openDisclosure(summary: Locator): Promise<void> {
  const details = summary.locator("xpath=ancestor-or-self::details[1]");
  await expect(async () => {
    if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await summary.click({ timeout: 2_000 });
    }
    await expect(details).toHaveAttribute("open", "", { timeout: 1_000 });
  }).toPass();
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

export { expect };
