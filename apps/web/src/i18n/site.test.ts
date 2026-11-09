// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALE_CODES, LOCALES, localeInfo } from "@portifact/contracts/locales";
import { THEME_SCRIPT } from "@portifact/contracts/theme";
import { axeViolations } from "@portifact/ui/testing";
import { describe, expect, it } from "vitest";
import { collectMessages, localizeDocument, markupOf, stripMarkers } from "./markers.ts";
import { SITE_CATALOGS } from "./site/catalogs.ts";
import { localePrefix, localizedFile, SITE_PAGES, type SitePage, sitePath } from "./site.ts";
import { renderSiteHtml, sitePageForPath } from "./site-build.ts";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (page: SitePage) => readFileSync(join(WEB, page.file), "utf8");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const page = (file: string) => SITE_PAGES.find((candidate) => candidate.file === file) as SitePage;
const LANDING = page("index.html");
const TERMS = page("terms.html");
const MCP = page("mcp-compatibility.html");

/** Every marker of the site's English pages with its text. */
const english = new Map<string, string>();
for (const sitePage of SITE_PAGES) {
  for (const [key, text] of collectMessages(parse(source(sitePage)))) english.set(key, text);
}

const hrefsOf = (html: string) =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "").sort();

describe.each(LOCALE_CODES.filter((code) => code !== "en"))("the %s site catalog", (code) => {
  const { pages, chrome } = SITE_CATALOGS[code];

  it("translates every marker of the site's pages, and nothing else", () => {
    expect(Object.keys(pages).sort()).toEqual([...english.keys()].sort());
  });

  it("keeps the English markup and links of every message", () => {
    for (const [key, text] of english) {
      const translated = pages[key] ?? "";
      expect(markupOf(translated).sort(), key).toEqual(markupOf(text).sort());
      expect(hrefsOf(translated), key).toEqual(hrefsOf(text));
      expect(translated.trim(), key).not.toBe("");
    }
  });

  it("has no em or en dashes", () => {
    for (const text of [...Object.values(pages), ...Object.values(chrome)]) {
      expect(text).not.toMatch(/[–—]/);
    }
  });
});

describe.each(LOCALE_CODES.filter((code) => code !== "en"))("the %s pages", (code) => {
  const prefix = `/${code.toLowerCase()}`;

  it.each(SITE_PAGES.map((sitePage) => [sitePage.file, sitePage] as const))(
    "render %s with its language, canonical, alternates and switchers",
    (_file, sitePage) => {
      const document = parse(renderSiteHtml(source(sitePage), sitePage, code));
      expect(document.documentElement.lang).toBe(code);
      expect(document.documentElement.dir).toBe(localeInfo(code).dir);
      const own = `https://portifact.com${prefix}${sitePage.path}`;
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        sitePage.kind === "legal" ? `https://portifact.com${sitePage.path}` : own,
      );
      const alternates = [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map(
        (link) => link.getAttribute("hreflang"),
      );
      expect(alternates).toEqual(sitePage.kind === "legal" ? [] : [...LOCALE_CODES, "x-default"]);
      expect(
        document.querySelector('meta[property="og:url"]')?.getAttribute("content") ?? own,
      ).toBe(own);
      const switchers = document.querySelectorAll("nav[aria-label]");
      const languageNavs = [...switchers].filter((nav) => nav.querySelector("a[hreflang]"));
      expect(languageNavs.length).toBeGreaterThanOrEqual(1);
      for (const nav of languageNavs) {
        expect(nav.getAttribute("aria-label")).toBe(SITE_CATALOGS[code].chrome.languageLabel);
        const links = [...nav.querySelectorAll("a[hreflang]")];
        expect(links.map((link) => link.textContent)).toEqual(LOCALES.map((l) => l.name));
        expect(links.map((link) => link.getAttribute("lang"))).toEqual([...LOCALE_CODES]);
        expect(nav.querySelector('a[aria-current="true"]')?.getAttribute("href")).toBe(
          `${prefix}${sitePage.path}`,
        );
      }
      expect(document.documentElement.outerHTML).not.toContain("data-i18n");
      if (sitePage.kind === "translated") {
        expect(document.title).not.toBe(parse(source(sitePage)).title);
      }
    },
  );

  it("passes the accessibility checks on the landing", async () => {
    const rendered = parse(renderSiteHtml(source(LANDING), LANDING, code));
    document.documentElement.lang = code;
    document.body.innerHTML = rendered.body.innerHTML;
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe("legal pages", () => {
  it("never mark the legal text itself, which stays English in every language", () => {
    for (const legal of SITE_PAGES.filter((candidate) => candidate.kind === "legal")) {
      const main = parse(source(legal)).querySelector("main");
      expect(main, legal.file).not.toBeNull();
      expect(collectMessages(main as HTMLElement).size, legal.file).toBe(0);
    }
  });
});

describe("renderSiteHtml", () => {
  it("renders the English landing in place with its alternates and switchers", () => {
    const document = parse(renderSiteHtml(source(LANDING), LANDING, "en"));
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    const head = document.head;
    expect(head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      "https://portifact.com/",
    );
    expect(
      [...head.querySelectorAll('link[rel="alternate"]')].map((link) => [
        link.getAttribute("hreflang"),
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["en", "https://portifact.com/"],
      ["es", "https://portifact.com/es/"],
      ["pt-BR", "https://portifact.com/pt-br/"],
      ["fr", "https://portifact.com/fr/"],
      ["de", "https://portifact.com/de/"],
      ["ru", "https://portifact.com/ru/"],
      ["ja", "https://portifact.com/ja/"],
      ["zh-CN", "https://portifact.com/zh-cn/"],
      ["x-default", "https://portifact.com/"],
    ]);
    const switchers = document.querySelectorAll('nav[aria-label="Language"]');
    expect(switchers.length).toBeGreaterThanOrEqual(2);
    for (const nav of switchers) {
      const current = nav.querySelector('a[aria-current="true"]');
      expect(current?.getAttribute("href")).toBe("/");
      expect(nav.querySelector('a[hreflang="es"]')?.getAttribute("href")).toBe("/es/");
      expect(nav.querySelector('a[hreflang="es"]')?.getAttribute("lang")).toBe("es");
      expect(nav.querySelector('a[hreflang="es"]')?.textContent).toBe("Español");
    }
    // The English page carries the hidden Spanish suggestion, written in Spanish.
    const note = document.querySelector('[data-locale-suggestion="es"]');
    expect(note?.hasAttribute("hidden")).toBe(true);
    expect(note?.getAttribute("lang")).toBe("es");
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/es/");
    expect(document.querySelector("[data-i18n]")).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain("data-i18n");
  });

  it("renders the Spanish landing with Spanish text and links that keep the language", () => {
    const html = renderSiteHtml(source(LANDING), LANDING, "es");
    const document = parse(html);
    expect(document.documentElement.lang).toBe("es");
    expect(document.title).toBe(SITE_CATALOGS.es.pages[titleKey(LANDING)]);
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      "https://portifact.com/es/",
    );
    expect(document.head.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe(
      "https://portifact.com/es/",
    );
    const hrefs = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/es/terms");
    expect(hrefs).toContain("/es/mcp-compatibility");
    expect(hrefs).not.toContain("/terms");
    expect(hrefs).toContain("https://app.portifact.com/?lang=es");
    // Hash links, external links and the notices stay as they are.
    expect(hrefs).toContain("#install");
    expect(hrefs).toContain("/third-party-notices");
    expect(hrefs).toContain("https://github.com/leynier/portifact");
    expect(
      document.querySelector('nav[aria-label="Idioma"] a[aria-current="true"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-locale-suggestion="en"]')?.getAttribute("lang")).toBe(
      "en",
    );
    expect(document.querySelector('[data-locale-suggestion="es"]')).toBeNull();
    expect(html).not.toContain("data-i18n");
  });

  it("keeps the transcripts and the agent prompt in English", () => {
    const englishPage = parse(renderSiteHtml(source(LANDING), LANDING, "en"));
    const spanishPage = parse(renderSiteHtml(source(LANDING), LANDING, "es"));
    expect(spanishPage.getElementById("agent-prompt")?.textContent).toBe(
      englishPage.getElementById("agent-prompt")?.textContent,
    );
    // The CLI transcripts that `bun run landing:shots` writes are the real output, in English.
    const transcripts = (document: Document) =>
      [...document.querySelectorAll("pre")].map((element) => element.textContent);
    expect(transcripts(englishPage).length).toBeGreaterThan(0);
    expect(transcripts(spanishPage)).toEqual(transcripts(englishPage));
  });

  it("renders a Spanish legal page around the English text, which governs", () => {
    const document = parse(renderSiteHtml(source(TERMS), TERMS, "es"));
    expect(document.documentElement.lang).toBe("es");
    const main = document.querySelector("main");
    expect(main?.getAttribute("lang")).toBe("en");
    const note = main?.querySelector("[data-legal-note]");
    expect(note?.getAttribute("lang")).toBe("es");
    expect(note?.textContent).toBe(SITE_CATALOGS.es.chrome.legalNote);
    expect(main?.querySelector("h1")?.textContent).toBe("Terms of Service");
    // The English page is the one to index; no alternates point at a copy of the same text.
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      "https://portifact.com/terms",
    );
    expect(document.head.querySelectorAll('link[rel="alternate"]')).toHaveLength(0);
    // Its links to the other legal pages stay in Spanish.
    expect(document.querySelector('a[href="/es/privacy"]')).not.toBeNull();
  });

  it("keeps the English legal text identical in every language", () => {
    const text = (locale: "en" | "es") => {
      const main = parse(renderSiteHtml(source(TERMS), TERMS, locale)).querySelector("main");
      main?.querySelector("[data-legal-note]")?.remove();
      for (const link of main?.querySelectorAll("a[href]") ?? []) link.removeAttribute("href");
      return main?.textContent;
    };
    expect(text("es")).toBe(text("en"));
  });

  it("translates the MCP compatibility page whole", () => {
    const document = parse(renderSiteHtml(source(MCP), MCP, "es"));
    expect(document.documentElement.lang).toBe("es");
    expect(document.querySelector("main")?.hasAttribute("lang")).toBe(false);
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      "https://portifact.com/es/mcp-compatibility",
    );
  });

  it("keeps the inline theme script byte for byte, so its CSP hash still allows it", () => {
    // Vite adds the script to the built English page; the localized pages are rendered from it.
    const built = source(LANDING).replace("</head>", `<script>${THEME_SCRIPT}</script></head>`);
    for (const locale of LOCALE_CODES) {
      const html = renderSiteHtml(built, LANDING, locale);
      expect(html, locale).toContain(`<script>${THEME_SCRIPT}</script>`);
    }
  });

  it("fails on a marker the catalog lacks, naming it", () => {
    const html = source(LANDING).replace("<main", '<p data-i18n="landing.missing.key">x</p><main');
    expect(() => renderSiteHtml(html, LANDING, "es")).toThrow("landing.missing.key");
  });

  it("passes the accessibility checks in Spanish", async () => {
    const rendered = parse(renderSiteHtml(source(LANDING), LANDING, "es"));
    document.documentElement.lang = "es";
    document.body.innerHTML = rendered.body.innerHTML;
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

/** The marker key of a page's `<title>`. */
function titleKey(sitePage: SitePage): string {
  return parse(source(sitePage)).querySelector("title")?.getAttribute("data-i18n") ?? "";
}

describe("site paths", () => {
  it("prefix every language but English, in lowercase", () => {
    expect(localePrefix("en")).toBe("");
    expect(localePrefix("pt-BR")).toBe("/pt-br");
    expect(localePrefix("zh-CN")).toBe("/zh-cn");
    expect(sitePath("/terms", "zh-CN")).toBe("/zh-cn/terms");
    expect(localizedFile(LANDING, "pt-BR")).toBe("pt-br/index.html");
    expect(localePrefix("es")).toBe("/es");
    expect(sitePath("/", "es")).toBe("/es/");
    expect(sitePath("/terms", "es")).toBe("/es/terms");
    expect(sitePath("/terms", "en")).toBe("/terms");
    expect(localizedFile(LANDING, "es")).toBe("es/index.html");
    expect(localizedFile(TERMS, "en")).toBe("terms.html");
  });

  it("map dev-server paths to a page and a language", () => {
    expect(sitePageForPath("/es/")).toMatchObject({ locale: "es", file: "index.html" });
    expect(sitePageForPath("/es/terms?x=1")).toMatchObject({ locale: "es", file: "terms.html" });
    expect(sitePageForPath("/es/terms.html")).toMatchObject({ locale: "es", file: "terms.html" });
    expect(sitePageForPath("/")).toMatchObject({ locale: "en", file: "index.html" });
    expect(sitePageForPath("/index.html")).toMatchObject({ locale: "en", file: "index.html" });
    expect(sitePageForPath("/mcp-compatibility")).toMatchObject({ locale: "en" });
    expect(sitePageForPath("/zh-cn/")).toMatchObject({ locale: "zh-CN", file: "index.html" });
    expect(sitePageForPath("/pt-br/privacy")).toMatchObject({ locale: "pt-BR" });
    expect(sitePageForPath("/es/login")).toBeUndefined();
    expect(sitePageForPath("/login")).toBeUndefined();
  });
});

describe("markers", () => {
  it("translate content, attributes and the title, and report what is missing", () => {
    const document = parse(
      '<title data-i18n="t">Hi</title><p data-i18n="p">Hello <code>x</code></p><img alt="A cat" data-i18n-alt="a"><a aria-label="Go" data-i18n-aria-label="missing">x</a>',
    );
    const missing = localizeDocument(document, {
      t: "Hola",
      p: "Hola <code>x</code>",
      a: "Un gato",
    });
    expect(document.title).toBe("Hola");
    expect(document.querySelector("p")?.innerHTML).toBe("Hola <code>x</code>");
    expect(document.querySelector("img")?.getAttribute("alt")).toBe("Un gato");
    expect(document.querySelector("a")?.getAttribute("aria-label")).toBe("Go");
    expect(missing).toEqual(["missing"]);
    stripMarkers(document);
    expect(document.documentElement.outerHTML).not.toContain("data-i18n");
  });

  it("refuse one key with two different English texts", () => {
    const document = parse('<p data-i18n="k">One</p><p data-i18n="k">Two</p>');
    expect(() => collectMessages(document)).toThrow('"k"');
    const same = parse('<p data-i18n="k">One</p><span data-i18n="k">One</span>');
    expect(collectMessages(same).get("k")).toBe("One");
  });

  it("ignore keys inherited from the object prototype", () => {
    const document = parse('<p data-i18n="toString">Keep</p>');
    expect(localizeDocument(document, {})).toEqual(["toString"]);
    expect(document.querySelector("p")?.textContent).toBe("Keep");
  });
});
