// @vitest-environment happy-dom
import { LOCALE_COOKIE, preferenceCookie } from "@portifact/contracts/preferences";
import { describe, expect, it } from "vitest";
import {
  applyDocumentLocale,
  browserCookies,
  type CookieSource,
  LOCALE_STORAGE_KEY,
  localeParam,
  pageLocale,
  readStoredLocale,
  type StorageSource,
  storeLocale,
  withLocaleParam,
  withoutLocaleParam,
} from "./preference.ts";

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  return { values, source: (() => storage) satisfies StorageSource };
}

/** Storage a browser refuses: private windows and blocked site data throw on every access. */
const blocked: StorageSource = () => ({
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
});
const throwing: StorageSource = () => {
  throw new DOMException("blocked", "SecurityError");
};

/** A page's cookies: what it writes, and what it reads back (the last value of each name). */
function cookieJar(initial = "", hostname = "app.portifact.com") {
  const writes: string[] = [];
  const values = new Map<string, string>();
  for (const pair of initial.split("; ").filter(Boolean)) {
    const [name = "", value = ""] = pair.split("=");
    values.set(name, value);
  }
  const source: CookieSource = () => ({
    hostname,
    read: () => [...values].map(([name, value]) => `${name}=${value}`).join("; "),
    write: (cookie) => {
      writes.push(cookie);
      const [name = "", value = ""] = (cookie.split("; ")[0] ?? "").split("=");
      values.set(name, value);
    },
  });
  return { writes, source };
}

const refusedCookies: CookieSource = () => ({
  hostname: "app.portifact.com",
  read: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  write: () => {
    throw new DOMException("blocked", "SecurityError");
  },
});

const PAGE = "https://app.portifact.com/login?next=%2F";

describe("pageLocale", () => {
  it("follows the browser's languages without a choice", () => {
    expect(pageLocale({ url: PAGE, storage: memory().source, languages: ["es-AR", "en"] })).toBe(
      "es",
    );
    expect(pageLocale({ url: PAGE, storage: memory().source, languages: ["de-CH"] })).toBe("de");
    expect(pageLocale({ url: PAGE, storage: memory().source, languages: ["zh-Hans-CN"] })).toBe(
      "zh-CN",
    );
    expect(pageLocale({ url: PAGE, storage: memory().source, languages: ["zh-TW", "ja"] })).toBe(
      "ja",
    );
    expect(pageLocale({ url: PAGE, storage: memory().source, languages: ["it"] })).toBe("en");
  });

  it("prefers the choice kept in this browser over the browser's languages", () => {
    const kept = memory({ [LOCALE_STORAGE_KEY]: "en" });
    expect(pageLocale({ url: PAGE, storage: kept.source, languages: ["es"] })).toBe("en");
  });

  it("takes ?lang= over everything and keeps it as the new choice", () => {
    const kept = memory({ [LOCALE_STORAGE_KEY]: "en" });
    const url = `${PAGE}&lang=es`;
    expect(pageLocale({ url, storage: kept.source, languages: ["en"] })).toBe("es");
    expect(kept.values.get(LOCALE_STORAGE_KEY)).toBe("es");
  });

  it("ignores an unknown ?lang= and an unknown kept value", () => {
    const kept = memory({ [LOCALE_STORAGE_KEY]: "xx" });
    const url = `${PAGE}&lang=klingon`;
    expect(pageLocale({ url, storage: kept.source, languages: ["es"] })).toBe("es");
    expect(kept.values.get(LOCALE_STORAGE_KEY)).toBe("xx");
  });

  it("orders ?lang=, the shared cookie, this origin's storage, then the browser", () => {
    const kept = memory({ [LOCALE_STORAGE_KEY]: "fr" });
    const cookies = cookieJar(`${LOCALE_COOKIE}=de`);
    const sources = { storage: kept.source, cookies: cookies.source, languages: ["ja"] };
    expect(pageLocale({ ...sources, url: PAGE })).toBe("de");
    expect(pageLocale({ ...sources, url: `${PAGE}&lang=es` })).toBe("es");
    // The parameter is the new choice, shared with the landing.
    expect(cookies.writes).toEqual([preferenceCookie(LOCALE_COOKIE, "es", "app.portifact.com")]);
    expect(pageLocale({ ...sources, url: PAGE })).toBe("es");
    expect(pageLocale({ ...sources, cookies: () => null, url: PAGE })).toBe("es");
    expect(
      pageLocale({ url: PAGE, storage: () => null, cookies: () => null, languages: ["ja"] }),
    ).toBe("ja");
  });

  it("still resolves a language when storage is blocked", () => {
    for (const storage of [blocked, throwing, () => null]) {
      expect(pageLocale({ url: `${PAGE}&lang=es`, storage, languages: ["en"] })).toBe("es");
      expect(pageLocale({ url: PAGE, storage, languages: ["es-MX"] })).toBe("es");
    }
  });
});

describe("kept choice", () => {
  it("is written to the shared cookie and storage, and read back", () => {
    const kept = memory();
    const cookies = cookieJar();
    expect(storeLocale(kept.source, "es", cookies.source)).toBe(true);
    expect(cookies.writes).toEqual([preferenceCookie(LOCALE_COOKIE, "es", "app.portifact.com")]);
    expect(kept.values.get(LOCALE_STORAGE_KEY)).toBe("es");
    expect(readStoredLocale(kept.source, cookies.source)).toBe("es");
  });

  it("prefers the shared cookie, set on the other host, over this origin's storage", () => {
    const kept = memory({ [LOCALE_STORAGE_KEY]: "fr" });
    expect(readStoredLocale(kept.source, cookieJar(`a=1; ${LOCALE_COOKIE}=de`).source)).toBe("de");
    expect(readStoredLocale(kept.source, cookieJar(`${LOCALE_COOKIE}=xx`).source)).toBe("fr");
    expect(readStoredLocale(kept.source, refusedCookies)).toBe("fr");
    expect(readStoredLocale(kept.source, () => null)).toBe("fr");
  });

  it("keeps the choice in whichever the browser allows", () => {
    const cookies = cookieJar();
    expect(storeLocale(blocked, "ja", cookies.source)).toBe(true);
    expect(readStoredLocale(blocked, cookies.source)).toBe("ja");
    const kept = memory();
    expect(storeLocale(kept.source, "ja", refusedCookies)).toBe(true);
    expect(readStoredLocale(kept.source, refusedCookies)).toBe("ja");
  });

  it("reports a refused write instead of throwing", () => {
    expect(storeLocale(blocked, "es", refusedCookies)).toBe(false);
    expect(storeLocale(throwing, "es", () => null)).toBe(false);
    expect(storeLocale(() => null, "es", refusedCookies)).toBe(false);
    expect(readStoredLocale(blocked, refusedCookies)).toBeUndefined();
  });

  it("uses this page's cookies by default", () => {
    const jar = browserCookies();
    expect(jar?.hostname).toBe(window.location.hostname);
    expect(storeLocale(() => null, "fr")).toBe(true);
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=fr`);
    expect(readStoredLocale(() => null)).toBe("fr");
  });
});

describe("the lang parameter", () => {
  it("is read only when it names a supported language", () => {
    expect(localeParam("https://app.portifact.com/?lang=es")).toBe("es");
    expect(localeParam("https://app.portifact.com/?lang=ES")).toBeUndefined();
    expect(localeParam("https://app.portifact.com/")).toBeUndefined();
    expect(localeParam("not a url")).toBeUndefined();
  });

  it("is added and removed without touching the rest of the URL", () => {
    const url = "https://app.portifact.com/device?user_code=ABCD-EFGH#top";
    expect(withLocaleParam(url, "es")).toBe("/device?user_code=ABCD-EFGH&lang=es#top");
    expect(withoutLocaleParam(`${url.replace("#top", "")}&lang=es#top`)).toBe(
      "/device?user_code=ABCD-EFGH#top",
    );
    expect(withoutLocaleParam("https://app.portifact.com/?lang=es")).toBe("/");
  });
});

describe("applyDocumentLocale", () => {
  it("sets the document's language and direction", () => {
    applyDocumentLocale(document, "es");
    expect(document.documentElement.lang).toBe("es");
    expect(document.documentElement.dir).toBe("ltr");
  });
});
