// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  applyDocumentLocale,
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

const PAGE = "https://app.portifact.com/login?next=%2F";

describe("pageLocale", () => {
  it("follows the browser's languages without a choice", () => {
    expect(pageLocale({ url: PAGE, storage: memory().source, languages: ["es-AR", "en"] })).toBe(
      "es",
    );
    expect(pageLocale({ url: PAGE, storage: memory().source, languages: ["de"] })).toBe("en");
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

  it("still resolves a language when storage is blocked", () => {
    for (const storage of [blocked, throwing, () => null]) {
      expect(pageLocale({ url: `${PAGE}&lang=es`, storage, languages: ["en"] })).toBe("es");
      expect(pageLocale({ url: PAGE, storage, languages: ["es-MX"] })).toBe("es");
    }
  });
});

describe("kept choice", () => {
  it("is written and read back", () => {
    const kept = memory();
    expect(storeLocale(kept.source, "es")).toBe(true);
    expect(readStoredLocale(kept.source)).toBe("es");
  });

  it("reports a refused write instead of throwing", () => {
    expect(storeLocale(blocked, "es")).toBe(false);
    expect(storeLocale(throwing, "es")).toBe(false);
    expect(storeLocale(() => null, "es")).toBe(false);
    expect(readStoredLocale(blocked)).toBeUndefined();
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
