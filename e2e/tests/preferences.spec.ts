// The theme and the language a visitor chooses are shared by the landing (portifact.test, the
// stand-in for portifact.com) and the app (app.portifact.test) through the preference cookies,
// so a choice made on one host shows on the other without choosing again. Visitors who chose
// nothing, crawlers included, are never redirected.

import type { Locator, Page } from "@playwright/test";
import { createUser, expect, signIn, test } from "../src/fixtures.ts";
import { APP_ORIGIN, SITE_HOST, SITE_ORIGIN } from "../src/hosts.ts";

const choose = (group: Locator, name: string) =>
  group
    .locator("label")
    .filter({ has: group.page().getByRole("radio", { name, exact: true }) })
    .click();

const theme = (page: Page) => page.locator("html").getAttribute("data-theme");

async function pickLanguage(page: Page, name: string): Promise<void> {
  const menu = page.locator("details[data-language-menu]").first();
  await menu.locator("summary").click();
  await menu.getByRole("link", { name }).click();
}

test("Dark and Español chosen on the landing show in the dashboard, and English chosen there shows on the landing", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  const owner = await createUser("Compartido");
  await signIn(context, owner);

  await page.goto(`${SITE_ORIGIN}/`);
  await choose(page.getByRole("group", { name: "Theme" }), "Dark");
  await pickLanguage(page, "Español");
  await expect(page).toHaveURL(`${SITE_ORIGIN}/es/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");

  // The cookies are shared with the app host, never host-only, and say nothing about the visitor.
  const cookies = await context.cookies(SITE_ORIGIN);
  const shared = cookies.filter((cookie) => cookie.name.startsWith("__Secure-pf_"));
  expect(shared.map(({ name, value }) => `${name}=${value}`).sort()).toEqual([
    "__Secure-pf_lang=es",
    "__Secure-pf_theme=dark",
  ]);
  for (const cookie of shared) {
    expect(cookie.domain).toBe(`.${SITE_HOST}`);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
  }

  await page.goto(`${APP_ORIGIN}/settings`);
  await expect(page.getByRole("heading", { level: 1, name: "Configuración" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  expect(await theme(page)).toBe("dark");
  const appearance = page.getByRole("region", { name: "Apariencia" });
  await expect(appearance.getByRole("radio", { name: "Oscuro" })).toBeChecked();

  const language = page.getByRole("region", { name: "Idioma" });
  await language.getByRole("combobox", { name: "Idioma" }).click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await choose(page.getByRole("region", { name: "Appearance" }), "Light");

  // A Spanish page is now answered with the English one.
  await page.goto(`${SITE_ORIGIN}/es/`);
  await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(await theme(page)).toBe("light");
});

test("Dark and Español chosen in the dashboard show on the landing and its documents", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  const owner = await createUser("Reverso");
  await signIn(context, owner);

  await page.goto(`${APP_ORIGIN}/settings`);
  await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
  await choose(page.getByRole("region", { name: "Appearance" }), "Dark");
  const language = page.getByRole("region", { name: "Language" });
  await language.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "Español" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Configuración" })).toBeVisible();

  await page.goto(`${SITE_ORIGIN}/`);
  await expect(page).toHaveURL(`${SITE_ORIGIN}/es/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  expect(await theme(page)).toBe("dark");
  // A visitor with a choice gets no suggestion to switch.
  await expect(page.locator("[data-locale-suggestion]:visible")).toHaveCount(0);

  await page.goto(`${SITE_ORIGIN}/privacy`);
  await expect(page).toHaveURL(`${SITE_ORIGIN}/es/privacy`);
  expect(await theme(page)).toBe("dark");

  // The scriptless legal page's switcher still switches, without bouncing back.
  await page.getByRole("contentinfo").getByRole("link", { name: "English" }).click();
  await expect(page).toHaveURL(`${SITE_ORIGIN}/privacy`);
  await page.goto(`${SITE_ORIGIN}/`);
  await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
});

test("a language chosen on the landing applies to the sign-in page", async ({ page }) => {
  await page.goto(`${SITE_ORIGIN}/`);
  await pickLanguage(page, "Français");
  await expect(page).toHaveURL(`${SITE_ORIGIN}/fr/`);
  await page.goto(`${APP_ORIGIN}/login`);
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
});

test.describe("a first visit", () => {
  test.use({ locale: "de-DE" });

  test("gets the page it asked for whatever its languages, and no cookie", async ({
    page,
    context,
  }) => {
    const response = await page.goto(`${SITE_ORIGIN}/`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    // The note offers German instead of sending the visitor there.
    await expect(page.locator('[data-locale-suggestion="de"]')).toBeVisible();
    const cookies = await context.cookies(SITE_ORIGIN);
    expect(cookies.filter((cookie) => cookie.name.startsWith("__Secure-pf_"))).toEqual([]);
  });
});
