// The reader's language on the app host's pages (the dashboard, the viewer and the auth pages)
// and the landing's remembered choice: an explicit choice wins, then the browser's languages,
// then English. A choice arrives as the `lang` query parameter (the landing's links and the
// switchers' links) or from the switchers, and is kept in the preference cookie shared by
// portifact.com and app.portifact.com (`LOCALE_COOKIE`), with this origin's storage as the
// fallback where cookies are blocked. Either may be blocked, so every access is guarded and only
// loses the memory.
import { isLocale, type LocaleCode, localeInfo } from "@portifact/contracts/locales";
import {
  LOCALE_COOKIE,
  localeFromCookies,
  preferenceCookie,
} from "@portifact/contracts/preferences";
import { resolveLocale } from "@portifact/domain/locale";

export const LOCALE_STORAGE_KEY = "portifact.locale";
export const LOCALE_PARAM = "lang";

/** Storage that may be missing or throw (private windows, blocked site data). */
export type StorageSource = () => Pick<Storage, "getItem" | "setItem"> | null | undefined;

/** The page's cookies (`document.cookie` and its host), which may be missing or throw. */
export interface CookieJar {
  readonly hostname: string;
  read(): string;
  write(cookie: string): void;
}
export type CookieSource = () => CookieJar | null | undefined;

/** The browser's cookies for this page. */
export const browserCookies: CookieSource = () => ({
  hostname: window.location.hostname,
  read: () => document.cookie,
  write: (cookie) => {
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is async and missing in some browsers, and the pre-paint theme script must read the same cookie synchronously; the value comes from preferenceCookie
    document.cookie = cookie;
  },
});

function cookieLocale(cookies: CookieSource): LocaleCode | undefined {
  try {
    return localeFromCookies(cookies()?.read());
  } catch {
    return undefined;
  }
}

function storageLocale(storage: StorageSource): LocaleCode | undefined {
  try {
    const value = storage()?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The kept choice: the shared cookie, then this origin's storage. */
export function readStoredLocale(
  storage: StorageSource,
  cookies: CookieSource = browserCookies,
): LocaleCode | undefined {
  return cookieLocale(cookies) ?? storageLocale(storage);
}

/** Keeps the choice in the shared cookie and this origin's storage; false when both refused. */
export function storeLocale(
  storage: StorageSource,
  locale: LocaleCode,
  cookies: CookieSource = browserCookies,
): boolean {
  let kept = false;
  try {
    const jar = cookies();
    if (jar) {
      jar.write(preferenceCookie(LOCALE_COOKIE, locale, jar.hostname));
      kept = true;
    }
  } catch {
    // Blocked cookies leave the choice to storage, for this origin only.
  }
  try {
    const target = storage();
    if (target) {
      target.setItem(LOCALE_STORAGE_KEY, locale);
      kept = true;
    }
  } catch {
    // Blocked storage only loses the fallback.
  }
  return kept;
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
  /** The shared preference cookie; the browser's by default. */
  cookies?: CookieSource;
  /** `navigator.languages`. */
  languages: readonly string[];
}

/**
 * The language of a page as it loads: `?lang=` (kept as the new choice), then the kept choice,
 * then the browser's languages, then English.
 */
export function pageLocale(sources: PageLocaleSources): LocaleCode {
  const cookies = sources.cookies ?? browserCookies;
  const asked = localeParam(sources.url);
  if (asked) storeLocale(sources.storage, asked, cookies);
  return resolveLocale({
    chosen: [asked, readStoredLocale(sources.storage, cookies)],
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
