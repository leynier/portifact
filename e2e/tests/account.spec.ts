// The dashboard's shell and account pages in a real browser: the sidebar collapses and resizes
// and remembers both, phones get a drawer instead of the sidebar and no page scrolls sideways,
// and the defaults for new artifacts are saved for the account.

import type { Page } from "@playwright/test";
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
  // Browser sessions are cards on a phone, not a table.
  await open(page, "/profile", "Profile");
  await expect(
    page.getByRole("list", { name: "Browsers signed in to your account" }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toBeHidden();
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
