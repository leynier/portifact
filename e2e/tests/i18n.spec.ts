// Languages in a real browser: the landing's switcher goes to the Spanish page and back, the
// dashboard switches to Spanish from the settings, keeps it across a reload and saves it in the
// account, and the login page asked for Spanish sends the sign-in code email in Spanish. Japanese
// and German (the longest strings) and Russian are checked on narrow and wide screens for
// overflow, with every language offered in the switchers.

import type { Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import { createUser, expect, lastEmail, publish, signIn, sql, test } from "../src/fixtures.ts";
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

/** Every language, as the switchers list them. */
const LANGUAGE_CODES = ["en", "es", "pt-BR", "fr", "de", "ru", "ja", "zh-CN"];

/** Every language, by its own name, in the same order. */
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

/**
 * What makes the page scroll sideways: every element or run of text that ends past the viewport
 * and is not inside something that clips or scrolls it. Empty when the page fits.
 */
async function sidewaysOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const width = root.clientWidth;
    if (root.scrollWidth <= width + 1) return [];
    const contained = (element: Element | null): boolean => {
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        if (/^(auto|scroll|hidden|clip)$/.test(getComputedStyle(node).overflowX)) return true;
      }
      return false;
    };
    const label = (element: Element) =>
      `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${String(element.className).trim().split(/\s+/).slice(0, 4).join(".")}`;
    const found: string[] = [];
    for (const element of document.body.querySelectorAll("*")) {
      const right = element.getBoundingClientRect().right;
      if (right <= width + 1 || contained(element.parentElement)) continue;
      const childPast = [...element.children].some(
        (child) => child.getBoundingClientRect().right > width + 1,
      );
      if (!childPast) found.push(`${label(element)} ends at ${Math.round(right)}px`);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || contained(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const right = Math.max(...[...range.getClientRects()].map((rect) => rect.right));
      if (right > width + 1) {
        found.push(
          `text "${node.textContent.trim().slice(0, 40)}" in ${label(parent)} ends at ${Math.round(right)}px`,
        );
      }
    }
    return found.length > 0 ? found : [`the page is ${root.scrollWidth}px wide in ${width}px`];
  });
}

/**
 * A wide font where the machine has one (DejaVu Sans, Verdana) with every glyph widened, so the
 * check does not depend on the fonts of the machine running it: CI's fallback fonts are wider
 * than a developer's. Static pages refuse inline styles, so the tests that use it bypass the CSP.
 */
const WIDER_TEXT =
  "*, *::before, *::after { font-family: 'DejaVu Sans', Verdana, sans-serif !important; letter-spacing: 0.08em !important; }";

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
});

test.describe("at 320 px with wider text than any font gives", () => {
  test.use({ bypassCSP: true });

  test("no static or sign-in page in any language scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    for (const code of LANGUAGE_CODES) {
      const prefix = code === "en" ? "" : `/${code.toLowerCase()}`;
      const pages = [
        ...["/", "/mcp-compatibility", "/terms", "/privacy", "/acceptable-use"].map(
          (path) => `${SITE_ORIGIN}${prefix}${path}`,
        ),
        ...["/login", "/device", "/report"].map((path) => `${APP_ORIGIN}${path}?lang=${code}`),
      ];
      for (const url of pages) {
        await page.goto(url);
        await expect(page.locator("html")).toHaveAttribute("lang", code);
        // Every page draws its language switchers last, once its text is in place.
        await expect(
          page.getByRole("link", { name: "Deutsch", exact: true }).first(),
          url,
        ).toBeAttached();
        await page.waitForLoadState("networkidle");
        expect(await sidewaysOverflow(page), url).toEqual([]);
        await page.addStyleTag({ content: WIDER_TEXT });
        expect(await sidewaysOverflow(page), `${url} with wider text`).toEqual([]);
      }
    }
  });

  test("no dashboard page in any language scrolls sideways", async ({ page, context }) => {
    const owner = await createUser("Breite");
    await signIn(context, owner);
    const { artifactId } = await publish({
      ownerId: owner.userId,
      name: "Plan",
      files: { "index.html": "<h1>Plan</h1>" },
    });
    await page.setViewportSize({ width: 320, height: 800 });
    for (const code of LANGUAGE_CODES) {
      for (const path of [
        "/",
        "/settings",
        "/usage",
        "/apps",
        "/profile",
        "/publish",
        `/artifacts/${artifactId}`,
        `/view/${artifactId}`,
      ]) {
        await page.goto(`${APP_ORIGIN}${path}?lang=${code}`);
        await expect(page.locator("html")).toHaveAttribute("lang", code);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        expect(await sidewaysOverflow(page), `${path} in ${code}`).toEqual([]);
        await page.addStyleTag({ content: WIDER_TEXT });
        expect(await sidewaysOverflow(page), `${path} in ${code} with wider text`).toEqual([]);
      }
    }
  });
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
    await page.goto(`${APP_ORIGIN}${path}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await sidewaysOverflow(page), path).toEqual([]);
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
