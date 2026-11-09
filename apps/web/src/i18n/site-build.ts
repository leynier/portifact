// Prerenders the static pages of portifact.com in every language at build time (Node, through
// the Vite plugin in vite.config.ts), and the same in the dev server. The rules are in site.ts;
// this file only parses and prints HTML.
import { DEFAULT_LOCALE, LOCALE_CODES, type LocaleCode } from "@portifact/contracts/locales";
import { Window } from "happy-dom";
import type { Plugin } from "vite";
import { localePrefix, localizedFile, renderSitePage, SITE_PAGES, type SitePage } from "./site.ts";

/** Renders an English page's HTML in a language; fails on any marker the catalog lacks. */
export function renderSiteHtml(html: string, page: SitePage, locale: LocaleCode): string {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      navigation: { disableMainFrameNavigation: true },
    },
  });
  try {
    const document = new window.DOMParser().parseFromString(html, "text/html");
    const missing = renderSitePage(document as unknown as Document, page, locale);
    if (missing.length > 0) {
      throw new Error(
        `${page.file} in ${locale} has no message for: ${missing.slice(0, 10).join(", ")}`,
      );
    }
    return `<!doctype html>\n${document.documentElement.outerHTML}\n`;
  } finally {
    void window.happyDOM.close();
  }
}

/** The page and language a dev-server path asks for, such as `/es/terms`. */
export function sitePageForPath(
  path: string,
): { page: SitePage; locale: LocaleCode; file: string } | undefined {
  const clean = path.split(/[?#]/)[0] ?? "";
  for (const locale of LOCALE_CODES) {
    const prefix = localePrefix(locale);
    if (prefix && !clean.startsWith(`${prefix}/`)) continue;
    const rest = clean.slice(prefix.length).replace(/\.html$/, "");
    const page = SITE_PAGES.find(
      (candidate) =>
        candidate.path === rest ||
        (candidate.path === "/" && (rest === "/index" || rest === "")) ||
        `/${candidate.file}` === `${rest}.html`,
    );
    if (page) return { page, locale, file: page.file };
  }
  return undefined;
}

/**
 * The Vite plugin: after the build, each site page is rendered in English in place and in every
 * other language under its prefix. In the dev server, `/es/...` serves the same rendering.
 */
export function sitePages(): Plugin {
  return {
    name: "portifact-site-pages",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const found = sitePageForPath(req.url ?? "");
        if (found && found.locale !== DEFAULT_LOCALE) req.url = `/${found.file}`;
        next();
      });
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        // Only the dev server renders here; the build renders the finished pages below.
        if (!context.server) return html;
        const found = sitePageForPath(context.path);
        if (!found) return html;
        const locale = context.originalUrl
          ? (sitePageForPath(context.originalUrl)?.locale ?? DEFAULT_LOCALE)
          : DEFAULT_LOCALE;
        return renderSiteHtml(html, found.page, locale);
      },
    },
    // After Vite's own HTML plugin, which emits the pages with their hashed asset links.
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        renderBundle(this, bundle);
      },
    },
  };
}

/** The part of the output bundle this plugin reads and changes: the emitted pages. */
type Bundle = Record<string, { type: string; source?: string | Uint8Array }>;
type EmitContext = { emitFile(file: { type: "asset"; fileName: string; source: string }): string };

function renderBundle(context: EmitContext, bundle: Bundle): void {
  for (const page of SITE_PAGES) {
    const asset = bundle[page.file];
    if (asset?.type !== "asset") continue;
    const english = String(asset.source);
    for (const locale of LOCALE_CODES) {
      if (locale === DEFAULT_LOCALE) continue;
      context.emitFile({
        type: "asset",
        fileName: localizedFile(page, locale),
        source: renderSiteHtml(english, page, locale),
      });
    }
    asset.source = renderSiteHtml(english, page, DEFAULT_LOCALE);
  }
}
