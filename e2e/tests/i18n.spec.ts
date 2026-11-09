// Languages in a real browser: the landing's switcher goes to the Spanish page and back, the
// dashboard switches to Spanish from the settings, keeps it across a reload and saves it in the
// account, and the login page asked for Spanish sends the sign-in code email in Spanish. Japanese
// and German (the longest strings) and Russian are checked on narrow and wide screens for
// overflow, with every language offered in the switchers.

import { axeViolations } from "../src/axe.ts";
import { createUser, expect, lastEmail, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN, SITE_ORIGIN } from "../src/hosts.ts";

test("the landing switches to Spanish from its top bar and stays there on reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${SITE_ORIGIN}/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const menu = page.locator("details[data-language-menu]").first();
  await menu.locator("summary").click();
  await menu.getByRole("link", { name: "Español" }).click();
  await expect(page).toHaveURL(`${SITE_ORIGIN}/es/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByRole("link", { name: "Saltar al contenido" })).toBeAttached();
  await expect(page.getByRole("link", { name: "Iniciar sesión" }).first()).toHaveAttribute(
    "href",
    "https://app.portifact.com/?lang=es",
  );
  expect(await axeViolations(page)).toEqual([]);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  // The Spanish page never suggests Spanish, and the choice is remembered on this site.
  await expect(page.locator('[data-locale-suggestion="es"]')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("portifact.locale"))).toBe("es");

  const footer = page.getByRole("contentinfo").getByRole("navigation", { name: "Idioma" });
  await footer.getByRole("link", { name: "English" }).click();
  await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("the dashboard switches to Spanish, keeps it on reload and saves it in the account", async ({
  page,
  context,
}) => {
  const owner = await createUser("Idioma");
  await signIn(context, owner);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${APP_ORIGIN}/settings`);
  await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();

  const section = page.getByRole("region", { name: "Language" });
  await section.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "Español" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Configuración" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page).toHaveTitle("Configuración · Portifact");
  await expect
    .poll(async () => {
      const rows = await sql<{ locale: string | null }>(
        "select locale from account_settings where user_id = ?",
        [owner.userId],
      );
      return rows[0]?.locale ?? null;
    })
    .toBe("es");

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Configuración" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(
    page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Artifacts" }),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // A browser that kept nothing, like another device, follows the account's language.
  await page.evaluate(() => localStorage.removeItem("portifact.locale"));
  await page.goto(`${APP_ORIGIN}/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("portifact.locale"))).toBe("es");
});

/** Every language, by its own name, as the switchers list them. */
const LANGUAGE_NAMES = [
  "English",
  "Español",
  "Português (Brasil)",
  "Français",
  "Deutsch",
  "Русский",
  "日本語",
  "简体中文",
];

/** The page scrolls sideways when its content is wider than the viewport. */
async function overflowsSideways(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

test("the landing offers every language and goes to Japanese and German without overflowing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${SITE_ORIGIN}/`);
  const menu = page.locator("details[data-language-menu]").first();
  await menu.locator("summary").click();
  await expect(menu.getByRole("link")).toHaveText(LANGUAGE_NAMES);
  await menu.getByRole("link", { name: "日本語" }).click();
  await expect(page).toHaveURL(`${SITE_ORIGIN}/ja/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("link", { name: "サインイン" }).first()).toHaveAttribute(
    "href",
    "https://app.portifact.com/?lang=ja",
  );
  // Japanese text is drawn with a Japanese font stack, after the Latin fonts.
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
    "Hiragino Sans",
  );
  expect(await axeViolations(page)).toEqual([]);

  const footer = page.getByRole("contentinfo").getByRole("navigation", { name: "言語" });
  await footer.getByRole("link", { name: "Deutsch" }).click();
  await expect(page).toHaveURL(`${SITE_ORIGIN}/de/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByRole("link", { name: "Zum Inhalt springen" })).toBeAttached();
  expect(await axeViolations(page)).toEqual([]);

  for (const path of ["/de/", "/ru/", "/ja/", "/zh-cn/", "/de/mcp-compatibility", "/ru/terms"]) {
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${SITE_ORIGIN}${path}`);
      expect(await overflowsSideways(page), `${path} at ${width}px`).toBe(false);
    }
  }
});

test("the dashboard switches to Japanese, then German, without overflowing", async ({
  page,
  context,
}) => {
  const owner = await createUser("Sprache");
  await signIn(context, owner);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${APP_ORIGIN}/settings`);
  await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();

  await page
    .getByRole("region", { name: "Language" })
    .getByRole("combobox", { name: "Language" })
    .click();
  await expect(page.getByRole("option")).toHaveText(LANGUAGE_NAMES);
  await page.getByRole("option", { name: "日本語" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "設定" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page).toHaveTitle("設定 · Portifact");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("region", { name: "言語" }).getByRole("combobox", { name: "言語" }).click();
  await page.getByRole("option", { name: "Deutsch" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Einstellungen" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect
    .poll(async () => {
      const rows = await sql<{ locale: string | null }>(
        "select locale from account_settings where user_id = ?",
        [owner.userId],
      );
      return rows[0]?.locale ?? null;
    })
    .toBe("de");
  expect(await axeViolations(page)).toEqual([]);

  for (const path of ["/settings", "/", "/usage", "/apps", "/profile"]) {
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${APP_ORIGIN}${path}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await overflowsSideways(page), `${path} at ${width}px`).toBe(false);
    }
  }
});

test("the login page asked for Spanish shows Spanish and sends the code email in Spanish", async ({
  page,
}) => {
  const email = `idioma-${Date.now()}@example.test`;
  await page.goto(`${APP_ORIGIN}/login?lang=es`);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  // The choice is kept and the parameter leaves the address bar.
  await expect(page).toHaveURL(`${APP_ORIGIN}/login`);
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByRole("button", { name: "Envíame un código" }).click();
  const message = await lastEmail(email);
  expect(message.subject).toBe("Tu código para iniciar sesión en Portifact");
  expect(message.html).toContain('<html lang="es"');

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
});
