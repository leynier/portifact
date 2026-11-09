// The display preferences shared by portifact.com and app.portifact.com: the theme and the
// language a visitor chose. Each is a first-party cookie scoped to the site's registrable domain,
// so the landing and the app read the same choice. They carry no identifier, only a validated
// value, and nothing reads them for authorization. portifact.dev (user content) never gets them:
// a page only shares the cookie under one of `PREFERENCE_DOMAINS`. Free of schema imports so the
// static pages, the design system and the Worker can all use it (`@portifact/contracts/preferences`).
import { isLocale, type LocaleCode } from "./locales.ts";
import { THEME_COOKIE } from "./theme.ts";

export { THEME_COOKIE };

/** The language chosen in a switcher, a note or through `?lang=`. */
export const LOCALE_COOKIE = "__Secure-pf_lang";

export type ThemeChoice = "system" | "light" | "dark";
export type PreferenceName = typeof THEME_COOKIE | typeof LOCALE_COOKIE;

/** About one year: a choice outlives a session but not forever. */
export const PREFERENCE_MAX_AGE = 31_536_000;

/**
 * The domains whose hosts share the preferences. `portifact.test` is the e2e stack's stand-in
 * for portifact.com: `.test` is reserved (RFC 6761), so no one can register it. Any other host,
 * such as `localhost` in development, keeps a host-only cookie.
 */
export const PREFERENCE_DOMAINS = ["portifact.com", "portifact.test"] as const;

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/** The `Domain` a host shares the preferences under, or undefined for a host-only cookie. */
export function preferenceDomain(hostname: string): string | undefined {
  const host = hostname.toLowerCase();
  return PREFERENCE_DOMAINS.find((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The raw value of a cookie in a `Cookie` header or `document.cookie`, the first one sent. */
function cookieValue(cookies: string, name: string): string | undefined {
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** The theme a `Cookie` header or `document.cookie` carries, if it is a valid choice. */
export function themeFromCookies(cookies: string | null | undefined): ThemeChoice | undefined {
  const value = cookies ? cookieValue(cookies, THEME_COOKIE) : undefined;
  return isThemeChoice(value) ? value : undefined;
}

/** The language a `Cookie` header or `document.cookie` carries, if it is a supported one. */
export function localeFromCookies(cookies: string | null | undefined): LocaleCode | undefined {
  const value = cookies ? cookieValue(cookies, LOCALE_COOKIE) : undefined;
  return isLocale(value) ? value : undefined;
}

/**
 * The `document.cookie` assignment that keeps a choice for a host: Secure, `SameSite=Lax`,
 * `Path=/`, a year, and the shared `Domain` when the host has one.
 */
export function preferenceCookie(
  name: PreferenceName,
  value: ThemeChoice | LocaleCode,
  hostname: string,
): string {
  const domain = preferenceDomain(hostname);
  return [
    `${name}=${value}`,
    ...(domain ? [`Domain=${domain}`] : []),
    "Path=/",
    `Max-Age=${PREFERENCE_MAX_AGE}`,
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}
