// The dashboard's shell and account pages in a real browser: the sidebar collapses and resizes
// and remembers both, phones get a drawer instead of the sidebar and no page scrolls sideways,
// and the defaults for new artifacts are saved for the account.

import type { Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import { createUser, expect, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const PAGES: [string, string][] = [
  ["/profile", "Profile"],
  ["/apps", "Apps"],
  ["/usage", "Usage"],
  ["/settings", "Settings"],
];

async function open(page: Page, path: string, title: string) {
  await page.goto(`${APP_ORIGIN}${path}`);
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

test("the sidebar collapses to icons, resizes from its edge and remembers both", async ({
  page,
  context,
}) => {
  const owner = await createUser("Sidebar");
  await signIn(context, owner);
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, "/", "Artifacts");

  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText([
    "Artifacts",
    "Publish",
    "Apps",
    "Usage",
    "Settings",
  ]);
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  await expect(handle).toHaveAttribute("aria-valuenow", "240");
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "272");
  const box = await page.getByRole("banner").boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(272);
  const main = await page.getByRole("main").boundingBox();
  expect(Math.round(main?.x ?? 0)).toBe(0);

  await page.reload();
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute(
    "aria-valuenow",
    "272",
  );

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByRole("separator")).toHaveCount(0);
  // The names stay as accessible names, and a hover shows them.
  const usage = nav.getByRole("link", { name: "Usage" });
  await usage.hover();
  await expect(page.locator("[data-tooltip]")).toHaveText("Usage");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-tooltip]")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute(
    "aria-valuenow",
    "272",
  );

  // The account at the foot of the sidebar opens the profile.
  await page.getByRole("link", { name: /^Profile: Sidebar/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Profile" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/profile");
});

test("phones get a drawer instead of the sidebar, and no account page scrolls sideways", async ({
  page,
  context,
}) => {
  const owner = await createUser("Phone");
  await signIn(context, owner);
  await page.setViewportSize({ width: 375, height: 740 });
  await open(page, "/", "Artifacts");

  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  const menu = page.getByRole("button", { name: "Open navigation" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  const drawer = page.getByRole("dialog", { name: "Open navigation" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Sign out" })).toBeVisible();
  // The page behind does not scroll while the drawer is open.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
    "hidden",
  );
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(menu).toBeFocused();

  await menu.click();
  await drawer.getByRole("link", { name: "Usage" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
  await expect(drawer).toBeHidden();

  for (const [path, title] of PAGES) {
    await open(page, path, title);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls sideways`).toBe(0);
  }
  // Browser sessions stack as cards on a phone: each row is a flex card, not a table row.
  await open(page, "/profile", "Profile");
  const sessions = page.getByRole("table", { name: "Browsers signed in to your account" });
  await expect(sessions).toBeVisible();
  expect(
    await sessions
      .getByRole("row")
      .nth(1)
      .evaluate((row) => getComputedStyle(row).display),
  ).toBe("flex");
});

test("the defaults for new artifacts are saved for the account", async ({ page, context }) => {
  const owner = await createUser("Defaults");
  await signIn(context, owner);
  await open(page, "/settings", "Settings");
  const defaults = page.getByRole("region", { name: "Defaults for new artifacts" });
  await defaults.getByRole("radio", { name: /Anyone signed in to Portifact/ }).check();
  await defaults.getByRole("radio", { name: /^Open/ }).check();
  await defaults
    .getByRole("checkbox", { name: "Show the Portifact bar on new artifacts" })
    .uncheck();
  await defaults.getByRole("button", { name: "Save defaults" }).click();
  await expect(page.getByText("Defaults saved. New artifacts start this way.")).toBeVisible();
  const [row] = await sql<{
    default_access_mode: string;
    default_annotations: string;
    default_bar: number;
  }>(
    "select default_access_mode, default_annotations, default_bar from account_settings where user_id = ?",
    [owner.userId],
  );
  expect(row).toEqual({
    default_access_mode: "authenticated",
    default_annotations: "open",
    default_bar: 0,
  });
  // Links to the old account page land on the page that holds each section now.
  await page.goto(`${APP_ORIGIN}/account#delete`);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await page.goto(`${APP_ORIGIN}/account`);
  await expect(page.getByRole("heading", { level: 1, name: "Profile" })).toBeVisible();
});

test("settings and profile have a section guide, a compact menu on phones", async ({
  page,
  context,
}) => {
  const owner = await createUser("Guide");
  await signIn(context, owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/profile", "Profile");
  const profile = page.getByRole("navigation", { name: "Profile sections" });
  await expect(profile.getByRole("link")).toHaveText([
    "Your account",
    "Sign-in methods",
    "Browser sessions",
  ]);
  await open(page, "/settings", "Settings");
  const settings = page.getByRole("navigation", { name: "Settings sections" });
  await expect(settings.getByRole("link")).toHaveText([
    "Defaults for new artifacts",
    "Email notices",
    "Your data",
    "Danger zone",
  ]);
  await settings.getByRole("link", { name: "Danger zone" }).click();
  await expect(page.getByRole("region", { name: "Danger zone" })).toBeInViewport();
  await expect(settings.getByRole("link", { name: "Danger zone" })).toHaveAttribute(
    "aria-current",
    "true",
  );

  await page.setViewportSize({ width: 375, height: 740 });
  await open(page, "/settings", "Settings");
  const menu = page.getByRole("navigation", { name: "Settings sections" });
  const summary = menu.locator("summary");
  await expect(summary).toHaveText(/On this page\s*Defaults for new artifacts/);
  await expect(menu.getByRole("link", { name: "Your data" })).toBeHidden();
  await summary.click();
  await menu.getByRole("link", { name: "Your data" }).click();
  await expect(menu.getByRole("link", { name: "Your data" })).toBeHidden();
  await expect(summary).toHaveText(/On this page\s*Your data/);
  // The menu stays at the top without covering the section it opened.
  const heading = await page.getByRole("heading", { name: "Your data" }).boundingBox();
  const bar = await menu.boundingBox();
  expect(heading?.y ?? 0).toBeGreaterThanOrEqual((bar?.y ?? 0) + (bar?.height ?? 0));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("connected apps are cards with a summary, details on demand and Disconnect", async ({
  page,
  context,
}) => {
  const owner = await createUser("Apps");
  const now = Date.now();
  await sql(
    "INSERT OR IGNORE INTO oauth_clients (id, client_id, name, redirect_uris, scopes) VALUES ('e2e-agent', 'e2e-agent', 'Agent', '[]', '[]')",
  );
  await sql(
    "INSERT INTO oauth_refresh_tokens (id, token, client_id, user_id, resources, expires_at, created_at, auth_time, scopes) VALUES (?, ?, 'e2e-agent', ?, ?, ?, ?, ?, ?)",
    [
      crypto.randomUUID(),
      crypto.randomUUID(),
      owner.userId,
      JSON.stringify([`${APP_ORIGIN}/mcp`]),
      now + 30 * 86_400_000,
      now - 2 * 3_600_000,
      now - 5 * 86_400_000,
      JSON.stringify(["artifacts:read", "annotations:read", "offline_access"]),
    ],
  );
  await signIn(context, owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/apps", "Apps");
  const card = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Agent" }) });
  await expect(card).toContainText("Third-party app");
  await expect(card).toContainText("Read only");
  await expect(card).toContainText("Connects to Portifact MCP");
  await expect(card).toContainText("Last used 2 hours ago");
  await expect(card.getByText("Read comments on your artifacts")).toBeHidden();
  await card.locator("summary").click();
  await expect(card.getByText("Read comments on your artifacts")).toBeVisible();
  await expect(page.getByRole("region", { name: "Connect an app" })).toContainText(
    "portifact login",
  );
  expect(await axeViolations(page)).toEqual([]);

  await card.getByRole("button", { name: "Disconnect Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Disconnect Agent?" });
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("heading", { name: "No apps connected" })).toBeVisible();
});
