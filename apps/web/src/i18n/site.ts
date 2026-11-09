// The static pages of portifact.com in every language. The English pages are the single source:
// the build (site-build.ts) renders each one once per language from them, English at its own
// path and every other language under a prefix (`/es/`, `/es/terms`). Legal pages keep their
// English text in every language (docs/legal.md): only the chrome around it is translated.
import {
  DEFAULT_LOCALE,
  LOCALE_CODES,
  type LocaleCode,
  localeInfo,
} from "@portifact/contracts/locales";
import { languageLinksHtml } from "@portifact/ui/language-links";
import { localizeDocument, stripMarkers } from "./markers.ts";
import { LOCALE_PARAM } from "./preference.ts";
import { SITE_CATALOGS } from "./site/catalogs.ts";
import type { SiteCatalog } from "./site/types.ts";

export const SITE_ORIGIN = "https://portifact.com";

export interface SitePage {
  /** The HTML entry Vite builds. */
  file: string;
  /** Its path in English. */
  path: string;
  /** `translated` pages are translated whole; `legal` pages only around the English text. */
  kind: "translated" | "legal";
}

export const SITE_PAGES: readonly SitePage[] = [
  { file: "index.html", path: "/", kind: "translated" },
  { file: "mcp-compatibility.html", path: "/mcp-compatibility", kind: "translated" },
  { file: "terms.html", path: "/terms", kind: "legal" },
  { file: "privacy.html", path: "/privacy", kind: "legal" },
  { file: "acceptable-use.html", path: "/acceptable-use", kind: "legal" },
];

/** The URL prefix of a language: none for English, `/es` for Spanish. */
export function localePrefix(locale: LocaleCode): string {
  return locale === DEFAULT_LOCALE ? "" : `/${locale.toLowerCase()}`;
}

/** A site path in a language: `/` is `/es/`, `/terms#x` is `/es/terms#x`. */
export function sitePath(path: string, locale: LocaleCode): string {
  return `${localePrefix(locale)}${path}`;
}

/** The built file of a page in a language: `es/index.html`, `es/terms.html`. */
export function localizedFile(page: SitePage, locale: LocaleCode): string {
  const prefix = localePrefix(locale);
  return prefix ? `${prefix.slice(1)}/${page.file}` : page.file;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

const pagePaths = new Set(SITE_PAGES.map((page) => page.path));

/** The app's origin: links to it ask for the page's language with `?lang=`. */
export const APP_ORIGIN = "https://app.portifact.com";

/**
 * A link of a translated page to another page of the site keeps the reader's language, and a
 * link to the app asks it for the same language (the app keeps it as the reader's choice).
 */
function localizedHref(href: string, locale: LocaleCode): string | undefined {
  if (href === APP_ORIGIN || href.startsWith(`${APP_ORIGIN}/`)) {
    const url = new URL(href);
    url.searchParams.set(LOCALE_PARAM, locale);
    return url.toString();
  }
  const match = /^([^?#]*)([?#].*)?$/.exec(href);
  const path = match?.[1] ?? "";
  if (!pagePaths.has(path)) return undefined;
  return sitePath(path, locale) + (match?.[2] ?? "");
}

function setLink(head: HTMLHeadElement, rel: string, href: string, hreflang?: string): void {
  const link = head.ownerDocument.createElement("link");
  link.setAttribute("rel", rel);
  if (hreflang) link.setAttribute("hreflang", hreflang);
  link.setAttribute("href", href);
  head.append(link);
}

function renderHead(document: Document, page: SitePage, locale: LocaleCode): void {
  const head = document.head;
  for (const old of head.querySelectorAll(
    'link[rel="canonical"], link[rel="alternate"][hreflang]',
  )) {
    old.remove();
  }
  const own = `${SITE_ORIGIN}${sitePath(page.path, locale)}`;
  // A legal page in another language shows the English text, so the English page is the one
  // to index; translated pages point at each other.
  setLink(head, "canonical", page.kind === "legal" ? `${SITE_ORIGIN}${page.path}` : own);
  if (page.kind === "translated") {
    for (const code of LOCALE_CODES) {
      setLink(head, "alternate", `${SITE_ORIGIN}${sitePath(page.path, code)}`, code);
    }
    setLink(head, "alternate", `${SITE_ORIGIN}${page.path}`, "x-default");
  }
  head.querySelector('meta[property="og:url"]')?.setAttribute("content", own);
  const ogLocale = head.querySelector('meta[property="og:locale"]');
  ogLocale?.setAttribute("content", locale.replace("-", "_"));
}

function renderSwitchers(
  document: Document,
  page: SitePage,
  locale: LocaleCode,
  chrome: SiteCatalog["chrome"],
): void {
  const links = LOCALE_CODES.map((code) => ({
    code,
    name: localeInfo(code).name,
    href: sitePath(page.path, code),
    current: code === locale,
  }));
  for (const slot of document.querySelectorAll("[data-language-switcher]")) {
    const variant = slot.getAttribute("data-language-switcher") === "list" ? "list" : "menu";
    slot.innerHTML = languageLinksHtml({ variant, label: chrome.languageLabel, links });
    slot.removeAttribute("data-language-switcher");
  }
}

/**
 * The suggestion for a visitor whose languages prefer another one: one hidden note per other
 * language, written in that language, which the page's script may show (src/locale-suggestion.ts).
 */
function renderSuggestions(document: Document, page: SitePage, locale: LocaleCode): void {
  for (const slot of document.querySelectorAll("[data-locale-suggestions]")) {
    slot.innerHTML = LOCALE_CODES.filter((code) => code !== locale)
      .map((code) => {
        const { chrome } = SITE_CATALOGS[code];
        const { dir } = localeInfo(code);
        const href = sitePath(page.path, code);
        return `<div data-locale-suggestion="${code}" lang="${code}" dir="${dir}" role="region" aria-label="${escapeAttribute(chrome.suggestion)}" class="border-b border-border bg-surface" hidden><div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2.5 text-sm sm:px-6"><p>${chrome.suggestion} <a href="${href}" hreflang="${code}" data-locale-link="${code}" class="font-medium text-text">${chrome.suggestionAction}</a></p><button type="button" data-locale-dismiss class="rounded-sm px-2 py-1 text-text-muted underline underline-offset-4 hover:text-text">${chrome.suggestionDismiss}</button></div></div>`;
      })
      .join("");
  }
}

function renderLegalNote(
  document: Document,
  locale: LocaleCode,
  chrome: SiteCatalog["chrome"],
): void {
  const main = document.querySelector("main");
  if (!main) return;
  // The legal text stays English, so assistive technology reads it as English.
  main.setAttribute("lang", DEFAULT_LOCALE);
  const note = document.createElement("p");
  note.setAttribute("lang", locale);
  note.setAttribute("data-legal-note", "");
  note.className =
    "mb-8 rounded-md border border-border-strong bg-surface p-4 text-sm leading-relaxed";
  note.textContent = chrome.legalNote;
  main.prepend(note);
}

/**
 * Renders one page in one language, in place: its text, `lang` and `dir`, canonical and
 * alternate links, links to the other pages in the same language, the language switchers and
 * the suggestion notes. Returns the marker keys the catalog lacks; the build fails on any.
 */
export function renderSitePage(
  document: Document,
  page: SitePage,
  locale: LocaleCode,
  catalogs: Readonly<Record<LocaleCode, SiteCatalog>> = SITE_CATALOGS,
): string[] {
  const catalog = catalogs[locale];
  const missing = locale === DEFAULT_LOCALE ? [] : localizeDocument(document, catalog.pages);
  const root = document.documentElement;
  root.setAttribute("lang", locale);
  root.setAttribute("dir", localeInfo(locale).dir);
  renderHead(document, page, locale);
  if (locale !== DEFAULT_LOCALE) {
    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = localizedHref(anchor.getAttribute("href") ?? "", locale);
      if (href) anchor.setAttribute("href", href);
    }
    if (page.kind === "legal") renderLegalNote(document, locale, catalog.chrome);
  }
  renderSwitchers(document, page, locale, catalog.chrome);
  renderSuggestions(document, page, locale);
  stripMarkers(document);
  return missing;
}
