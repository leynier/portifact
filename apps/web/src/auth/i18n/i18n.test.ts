// @vitest-environment happy-dom
import { LOCALE_CODES } from "@portifact/contracts/locales";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY, type StorageSource } from "../../i18n/preference.ts";
import { messages } from "../messages.ts";
import { describeScopes } from "../scopes.ts";
import { loadPage, ORIGIN } from "../test-page.ts";
import { en } from "./en.ts";
import { es } from "./es.ts";
import { type AuthCatalogLoaders, authCatalogLoaders, localizeAuthPage } from "./i18n.ts";

let stored: Map<string, string>;
let storage: StorageSource;
let replaced: unknown[][];

const h1 = () => document.querySelector("h1")?.textContent?.trim();
const switcherLinks = () =>
  [...document.querySelectorAll<HTMLAnchorElement>("[data-language-switcher] a")].map((link) => ({
    code: link.dataset.localeLink,
    href: link.getAttribute("href"),
    current: link.getAttribute("aria-current"),
  }));

beforeEach(() => {
  stored = new Map();
  storage = () => ({
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  replaced = [];
  vi.spyOn(window.history, "replaceState").mockImplementation((...args: unknown[]) => {
    replaced.push(args);
  });
  document.documentElement.lang = "en";
  loadPage("login");
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(messages, en);
});

describe("localizeAuthPage", () => {
  it("translates the page and its messages into the language the link asks for", async () => {
    const shown = await localizeAuthPage(document, {
      url: `${ORIGIN}/login?next=%2Fartifacts&lang=es`,
      storage,
      languages: ["en-US"],
    });
    expect(shown).toBe("es");
    expect(document.documentElement.lang).toBe("es");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.title).toBe("Iniciar sesión en Portifact");
    expect(h1()).toBe("Iniciar sesión en Portifact");
    expect(document.querySelector("a[href='#main']")?.textContent).toBe("Saltar al contenido");
    expect(document.querySelector("header a")?.getAttribute("aria-label")).toBe(
      "Inicio de Portifact",
    );
    // The svg of a button survives: only its text is marked.
    const google = document.querySelector('button[data-provider="google"]');
    expect(google?.querySelector("svg")).not.toBeNull();
    expect(google?.textContent?.trim()).toBe("Continuar con Google");
    expect(messages.signedInAs("ada@example.test")).toBe("Sesión iniciada como ada@example.test");
    expect(describeScopes("artifacts:read nope")).toEqual([
      es.messages.scopes["artifacts:read"],
      'Usar el permiso "nope"',
    ]);
    // The choice is kept and the parameter leaves the address bar, with the others kept.
    expect(stored.get(LOCALE_STORAGE_KEY)).toBe("es");
    expect(replaced).toEqual([[null, "", "/login?next=%2Fartifacts"]]);
  });

  it("follows the browser's languages when storage throws on every access", async () => {
    const throwing: StorageSource = () => ({
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    const shown = await localizeAuthPage(document, {
      url: `${ORIGIN}/login`,
      storage: throwing,
      languages: ["es-MX", "en"],
    });
    expect(shown).toBe("es");
    expect(h1()).toBe("Iniciar sesión en Portifact");
    expect(replaced).toEqual([]);

    loadPage("login");
    const fromNothing = await localizeAuthPage(document, {
      url: `${ORIGIN}/login?lang=es`,
      storage: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      languages: [],
    });
    expect(fromNothing).toBe("es");
  });

  it("uses the kept choice over the browser's languages", async () => {
    stored.set(LOCALE_STORAGE_KEY, "es");
    expect(
      await localizeAuthPage(document, { url: `${ORIGIN}/login`, storage, languages: ["en"] }),
    ).toBe("es");
  });

  it("still translates when the history refuses to drop the parameter", async () => {
    vi.mocked(window.history.replaceState).mockImplementation(() => {
      throw new DOMException("refused", "SecurityError");
    });
    expect(
      await localizeAuthPage(document, { url: `${ORIGIN}/login?lang=es`, storage, languages: [] }),
    ).toBe("es");
    expect(h1()).toBe("Iniciar sesión en Portifact");
  });

  it("stays in English for a language it does not have", async () => {
    const shown = await localizeAuthPage(document, {
      url: `${ORIGIN}/login?lang=it`,
      storage,
      languages: ["it-IT", "zh-TW"],
    });
    expect(shown).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(h1()).toBe("Sign in to Portifact");
    expect(messages.signedInAs("a")).toBe("Signed in as a");
    expect(stored.has(LOCALE_STORAGE_KEY)).toBe(false);
    // An unknown `lang` still leaves the address bar.
    expect(replaced).toEqual([[null, "", "/login"]]);
  });

  it("keeps English when the catalog cannot load", async () => {
    const loaders: AuthCatalogLoaders = {
      ...authCatalogLoaders,
      es: () => Promise.reject(new TypeError("offline")),
    };
    const shown = await localizeAuthPage(document, {
      url: `${ORIGIN}/login?lang=es`,
      storage,
      languages: ["es"],
      loaders,
    });
    expect(shown).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(h1()).toBe("Sign in to Portifact");
    expect(messages.network).toBe(en.network);
    expect(switcherLinks().find((link) => link.current === "true")?.code).toBe("en");
  });

  it("draws the footer switcher with links that keep the page's parameters", async () => {
    loadPage("device");
    await localizeAuthPage(document, {
      url: `${ORIGIN}/device?user_code=ABCD-EFGH&lang=es`,
      storage,
      languages: [],
    });
    const nav = document.querySelector("[data-language-switcher] nav");
    expect(nav?.getAttribute("aria-label")).toBe("Idioma");
    expect(switcherLinks()).toEqual(
      LOCALE_CODES.map((code) => ({
        code,
        href: `/device?user_code=ABCD-EFGH&lang=${code}`,
        current: code === "es" ? "true" : null,
      })),
    );
    expect(document.querySelector('[data-locale-link="es"]')?.textContent).toBe("Español");
  });

  it("renders the switcher on every auth page", async () => {
    for (const name of ["login", "device", "consent", "report", "unsubscribe"] as const) {
      loadPage(name);
      await localizeAuthPage(document, { url: `${ORIGIN}/${name}`, storage, languages: [] });
      expect(switcherLinks().map((link) => link.code)).toEqual([...LOCALE_CODES]);
      expect(
        document.querySelector("[data-language-switcher] nav")?.getAttribute("aria-label"),
      ).toBe("Language");
    }
  });
});
