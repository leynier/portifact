// The reader's language on the app host's pages (the dashboard, the viewer and the auth pages):
// an explicit choice wins, then the browser's languages, then English. A choice arrives as the
// `lang` query parameter (the landing's links and the auth pages' switcher) or from the
// switchers, and is kept in this browser's storage. Storage may be blocked, so every access is
// guarded and only loses the memory.
import { isLocale, type LocaleCode, localeInfo } from "@portifact/contracts/locales";
import { resolveLocale } from "@portifact/domain/locale";

export const LOCALE_STORAGE_KEY = "portifact.locale";
export const LOCALE_PARAM = "lang";

/** Storage that may be missing or throw (private windows, blocked site data). */
export type StorageSource = () => Pick<Storage, "getItem" | "setItem"> | null | undefined;

export function readStoredLocale(storage: StorageSource): LocaleCode | undefined {
  try {
    const value = storage()?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the choice; false when the browser refused it. */
export function storeLocale(storage: StorageSource, locale: LocaleCode): boolean {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(LOCALE_STORAGE_KEY, locale);
    return true;
  } catch {
    return false;
  }
}

/** The supported language a URL asks for with `?lang=`, if any. */
export function localeParam(url: string): LocaleCode | undefined {
  try {
    const value = new URL(url).searchParams.get(LOCALE_PARAM);
    return isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The URL without its `lang` parameter, to put back in the address bar once it is kept. */
export function withoutLocaleParam(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete(LOCALE_PARAM);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** The same URL asking for a language, for links that switch it. */
export function withLocaleParam(url: string, locale: LocaleCode): string {
  const parsed = new URL(url);
  parsed.searchParams.set(LOCALE_PARAM, locale);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export interface PageLocaleSources {
  /** The page's URL, for `?lang=`. */
  url: string;
  storage: StorageSource;
  /** `navigator.languages`. */
  languages: readonly string[];
}

/**
 * The language of a page as it loads: `?lang=` (kept as the new choice), then the kept choice,
 * then the browser's languages, then English.
 */
export function pageLocale(sources: PageLocaleSources): LocaleCode {
  const asked = localeParam(sources.url);
  if (asked) storeLocale(sources.storage, asked);
  return resolveLocale({
    chosen: [asked, readStoredLocale(sources.storage)],
    browser: sources.languages,
  });
}

/** Sets the document's `lang` and `dir` for a language. */
export function applyDocumentLocale(document: Document, locale: LocaleCode): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = localeInfo(locale).dir;
}

/** The browser's storage, or nothing when reading it throws. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
