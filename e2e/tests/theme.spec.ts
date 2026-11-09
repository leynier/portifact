// The theme choice (System, Light or Dark) in a real browser under the real CSP: the inline
// theme script must run (allowed by its hash) so a reload starts in the chosen theme, and the
// logo follows the choice rather than the operating system.

import type { Locator, Page } from "@playwright/test";
import { createUser, expect, signIn, test } from "../src/fixtures.ts";
import { APP_ORIGIN, SITE_ORIGIN } from "../src/hosts.ts";

// `--pf-color-canvas`, which the page background uses: neutral-0 in light, neutral-900 in dark.
const LIGHT = "rgb(255, 255, 255)";
const DARK = "rgb(20, 20, 20)";

const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

/** Presses a choice's visible label, as a person does; the radio itself is visually hidden. */
const choose = (group: Locator, name: string) =>
  group
    .locator("label")
    .filter({ has: group.page().getByRole("radio", { name, exact: true }) })
    .click();

/**
 * Collects refused inline scripts, which would mean the theme script was blocked. Other reports,
 * such as a library probing for `eval`, which the policy refuses on purpose, are not about it.
 */
function watchViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content[- ]Security[- ]Policy/i.test(text) && /inline/i.test(text)) violations.push(text);
  });
  return violations;
}

test("choosing Dark on the landing page applies at once and survives a reload", async ({
  page,
}) => {
  const violations = watchViolations(page);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const response = await page.goto(`${SITE_ORIGIN}/`);
  expect(response?.headers()["content-security-policy"]).toContain("'sha256-");
  expect(await background(page)).toBe(LIGHT);

  const theme = page.getByRole("group", { name: "Theme" });
  await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();
  await choose(theme, "Dark");
  await expect.poll(() => background(page)).toBe(DARK);
  await expect(page.locator("header picture source").first()).toHaveAttribute("media", "all");

  await page.reload();
  expect(await background(page)).toBe(DARK);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("header picture source").first()).toHaveAttribute("media", "all");
  await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();

  // The legal pages on the same origin start in the chosen theme too.
  await page.goto(`${SITE_ORIGIN}/terms`);
  expect(await background(page)).toBe(DARK);

  // Back to System: the operating system's light theme shows again.
  await page.goto(`${SITE_ORIGIN}/`);
  await choose(theme, "System");
  await expect.poll(() => background(page)).toBe(LIGHT);
  expect(violations).toEqual([]);
});

test("choosing Dark in the dashboard's settings applies at once and survives a reload", async ({
  page,
  context,
}) => {
  const violations = watchViolations(page);
  const owner = await createUser("Themer");
  await signIn(context, owner);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(`${APP_ORIGIN}/settings`);
  const appearance = page.getByRole("region", { name: "Appearance" });
  await expect(appearance.getByRole("radio", { name: "System" })).toBeChecked();
  expect(await background(page)).toBe(LIGHT);

  await choose(appearance, "Dark");
  await expect.poll(() => background(page)).toBe(DARK);
  // The sidebar's quick switch follows.
  const groups = page.getByRole("group", { name: "Theme" });
  await expect(groups.first().getByRole("radio", { name: "Dark" })).toBeChecked();

  await page.reload();
  await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
  expect(await background(page)).toBe(DARK);
  await expect(page.locator("picture source").first()).toHaveAttribute("media", "all");

  // The sidebar's theme switch and language choice share one row, and every theme choice shows
  // the pointer, like any control that acts on click.
  const sidebar = page.getByRole("banner");
  const quickTheme = await sidebar.getByRole("group", { name: "Theme" }).boundingBox();
  const language = await sidebar.getByRole("combobox", { name: "Language" }).boundingBox();
  const middle = (box: typeof quickTheme) => (box?.y ?? 0) + (box?.height ?? 0) / 2;
  expect(Math.abs(middle(quickTheme) - middle(language))).toBeLessThanOrEqual(4);
  for (const name of ["System", "Light", "Dark"]) {
    const option = sidebar.getByRole("radio", { name }).locator("xpath=ancestor::label[1]");
    expect(await option.evaluate((label) => getComputedStyle(label).cursor)).toBe("pointer");
  }

  // The quick switch in the sidebar changes it back.
  await choose(groups.first(), "Light");
  await expect.poll(() => background(page)).toBe(LIGHT);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await background(page)).toBe(LIGHT);
  expect(violations).toEqual([]);
});
