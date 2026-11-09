import { describe, expect, it } from "vitest";
import {
  isThemeChoice,
  LOCALE_COOKIE,
  localeFromCookies,
  PREFERENCE_MAX_AGE,
  preferenceCookie,
  preferenceDomain,
  THEME_COOKIE,
  themeFromCookies,
} from "./preferences.ts";

describe("preference cookie names", () => {
  it("are Secure-prefixed, so only HTTPS pages of the site can set them", () => {
    expect(THEME_COOKIE).toBe("__Secure-pf_theme");
    expect(LOCALE_COOKIE).toBe("__Secure-pf_lang");
    expect(PREFERENCE_MAX_AGE).toBe(365 * 24 * 60 * 60);
  });
});

describe("preferenceDomain", () => {
  it("shares the cookie between the site and the app", () => {
    expect(preferenceDomain("portifact.com")).toBe("portifact.com");
    expect(preferenceDomain("app.portifact.com")).toBe("portifact.com");
    expect(preferenceDomain("APP.Portifact.com")).toBe("portifact.com");
    expect(preferenceDomain("app.portifact.test")).toBe("portifact.test");
    expect(preferenceDomain("portifact.test")).toBe("portifact.test");
  });

  it("never shares it with user content or look-alike hosts", () => {
    expect(preferenceDomain("portifact.dev")).toBeUndefined();
    expect(preferenceDomain("abc.portifact.dev")).toBeUndefined();
    expect(preferenceDomain("evilportifact.com")).toBeUndefined();
    expect(preferenceDomain("portifact.com.evil.example")).toBeUndefined();
    expect(preferenceDomain("abc.portifact-content.test")).toBeUndefined();
    expect(preferenceDomain("localhost")).toBeUndefined();
  });
});

describe("reading the cookies", () => {
  it("finds each value by its exact name among others", () => {
    const header = `a=1; ${THEME_COOKIE}=dark; x${LOCALE_COOKIE}=fr; ${LOCALE_COOKIE}=es`;
    expect(themeFromCookies(header)).toBe("dark");
    expect(localeFromCookies(header)).toBe("es");
    expect(themeFromCookies(`${THEME_COOKIE}=system`)).toBe("system");
    expect(localeFromCookies(`${LOCALE_COOKIE}=pt-BR;${THEME_COOKIE}=light`)).toBe("pt-BR");
    expect(themeFromCookies(`${LOCALE_COOKIE}=pt-BR;${THEME_COOKIE}=light`)).toBe("light");
  });

  it("takes the first cookie of a name, as the browser sends the most specific first", () => {
    expect(themeFromCookies(`${THEME_COOKIE}=light; ${THEME_COOKIE}=dark`)).toBe("light");
  });

  it("ignores missing, unknown and malformed values", () => {
    expect(themeFromCookies(undefined)).toBeUndefined();
    expect(themeFromCookies(null)).toBeUndefined();
    expect(themeFromCookies("")).toBeUndefined();
    expect(themeFromCookies(`${THEME_COOKIE}=sepia`)).toBeUndefined();
    expect(themeFromCookies(`${THEME_COOKIE}`)).toBeUndefined();
    expect(themeFromCookies(`junk; ${THEME_COOKIE}=dark%00`)).toBeUndefined();
    expect(localeFromCookies(undefined)).toBeUndefined();
    expect(localeFromCookies(null)).toBeUndefined();
    expect(localeFromCookies(`${LOCALE_COOKIE}=xx`)).toBeUndefined();
    expect(localeFromCookies(`${LOCALE_COOKIE}=pt-br`)).toBeUndefined();
    expect(localeFromCookies(`${LOCALE_COOKIE}=`)).toBeUndefined();
  });

  it("accepts only the three themes", () => {
    expect(["system", "light", "dark"].every(isThemeChoice)).toBe(true);
    expect(isThemeChoice("auto")).toBe(false);
    expect(isThemeChoice(undefined)).toBe(false);
  });
});

describe("preferenceCookie", () => {
  it("shares a choice across the site's hosts for a year", () => {
    expect(preferenceCookie(THEME_COOKIE, "dark", "app.portifact.com")).toBe(
      `${THEME_COOKIE}=dark; Domain=portifact.com; Path=/; Max-Age=31536000; Secure; SameSite=Lax`,
    );
    expect(preferenceCookie(LOCALE_COOKIE, "es", "portifact.com")).toBe(
      `${LOCALE_COOKIE}=es; Domain=portifact.com; Path=/; Max-Age=31536000; Secure; SameSite=Lax`,
    );
  });

  it("keeps a host-only cookie anywhere else", () => {
    expect(preferenceCookie(LOCALE_COOKIE, "fr", "localhost")).toBe(
      `${LOCALE_COOKIE}=fr; Path=/; Max-Age=31536000; Secure; SameSite=Lax`,
    );
  });
});
