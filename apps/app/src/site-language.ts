// The language of the site's pages on portifact.com. Every page exists once per language, English
// at its own path and the others under a prefix (`/es/`, `/es/terms`), and nobody is sent
// elsewhere by their browser's languages: crawlers and first visits get the page they asked for.
// Only a visitor who chose a language (the shared `LOCALE_COOKIE`, also set by the app) is sent
// to the same page in it. A switcher link asks for its language with `?lang=`, which keeps the
// choice from the server, so the scriptless legal pages switch too and no switch can loop.
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_CODES,
  type LocaleCode,
} from "@portifact/contracts/locales";
import {
  LOCALE_COOKIE,
  localeFromCookies,
  preferenceCookie,
} from "@portifact/contracts/preferences";

/** The query parameter of the switchers' links (apps/web, src/i18n/preference.ts). */
const LOCALE_PARAM = "lang";

/** The site's pages in English; each exists under every other language's prefix too. */
export const SITE_PAGE_PATHS = [
  "/",
  "/terms",
  "/privacy",
  "/acceptable-use",
  "/mcp-compatibility",
] as const;

export interface SitePageLocale {
  locale: LocaleCode;
  /** The page's English path. */
  page: string;
}

const pages = new Set<string>(SITE_PAGE_PATHS);
const byPrefix = new Map(
  LOCALE_CODES.filter((code) => code !== DEFAULT_LOCALE).map((code) => [code.toLowerCase(), code]),
);

/** The page and language a path serves, or undefined when it is not one of the site's pages. */
export function sitePageLocale(pathname: string): SitePageLocale | undefined {
  if (pages.has(pathname)) return { locale: DEFAULT_LOCALE, page: pathname };
  const match = /^\/([a-z-]+)(\/.*)$/.exec(pathname);
  const locale = match ? byPrefix.get(match[1] ?? "") : undefined;
  const page = match?.[2] ?? "";
  // The landing in a language is `/es/`; `/es` is the static asset's redirect to it.
  if (!locale || !pages.has(page)) return undefined;
  return { locale, page };
}

/** A page's path in a language: `/` is `/es/`, `/terms` is `/es/terms`. */
export function sitePagePath(page: string, locale: LocaleCode): string {
  return locale === DEFAULT_LOCALE ? page : `/${locale.toLowerCase()}${page}`;
}

function redirect(url: URL, path: string, headers: Record<string, string>): Response {
  const target = new URL(url);
  target.pathname = path;
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${target.pathname}${target.search}`,
      // The answer depends on the cookie, so no shared cache may keep it.
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
      ...headers,
    },
  });
}

/**
 * The redirect a site page request gets, if any: `?lang=` keeps that language and goes to the
 * page in it without the parameter; otherwise a kept choice other than the page's language goes
 * to the same page in it. Requests without either are served as they are.
 */
export function languageRedirect(request: Request): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  const current = sitePageLocale(url.pathname);
  if (!current) return undefined;
  const asked = url.searchParams.get(LOCALE_PARAM);
  if (isLocale(asked)) {
    url.searchParams.delete(LOCALE_PARAM);
    return redirect(url, sitePagePath(current.page, asked), {
      "Set-Cookie": preferenceCookie(LOCALE_COOKIE, asked, url.hostname),
    });
  }
  const chosen = localeFromCookies(request.headers.get("Cookie"));
  if (!chosen || chosen === current.locale) return undefined;
  return redirect(url, sitePagePath(current.page, chosen), {});
}
