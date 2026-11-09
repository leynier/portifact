// @vitest-environment happy-dom
import { LOCALE_COOKIE } from "@portifact/contracts/preferences";
import { beforeEach, describe, expect, it } from "vitest";
import { LOCALE_STORAGE_KEY, type StorageSource } from "./i18n/preference.ts";
import {
  SUGGESTION_DISMISSED_KEY,
  setupLanguageMenus,
  setupLocaleSuggestion,
} from "./locale-suggestion.ts";

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

const blocked: StorageSource = () => {
  throw new DOMException("blocked", "SecurityError");
};

/** The landing in English as the build renders it: switcher links and one hidden note. */
function englishPage() {
  document.documentElement.lang = "en";
  document.body.innerHTML = `
    <details data-language-menu><summary>Language</summary>
      <a href="/" data-locale-link="en" aria-current="true">English</a>
      <a href="/es/" data-locale-link="es">Español</a>
    </details>
    <div data-locale-suggestion="es" lang="es" hidden>
      <p>Esta página está disponible en español. <a href="/es/" data-locale-link="es">Leerla en español</a></p>
      <button type="button" data-locale-dismiss>Cerrar</button>
    </div>
    <main id="main"></main>`;
}

const note = () => document.querySelector<HTMLElement>("[data-locale-suggestion]") as HTMLElement;

beforeEach(englishPage);

describe("setupLocaleSuggestion", () => {
  it("suggests the page in the visitor's language without leaving this one", () => {
    const storage = memory();
    expect(setupLocaleSuggestion(document, { storage: storage.source, languages: ["es-MX"] })).toBe(
      "es",
    );
    expect(note().hidden).toBe(false);
    expect(window.location.pathname).not.toContain("/es/");
  });

  it("says nothing when the page is already in the visitor's language", () => {
    expect(
      setupLocaleSuggestion(document, { storage: memory().source, languages: ["en-GB", "es"] }),
    ).toBeUndefined();
    expect(note().hidden).toBe(true);
  });

  it("follows a language picked before over the browser's", () => {
    const storage = memory({ [LOCALE_STORAGE_KEY]: "en" });
    expect(
      setupLocaleSuggestion(document, { storage: storage.source, languages: ["es"] }),
    ).toBeUndefined();
    expect(note().hidden).toBe(true);
  });

  it("remembers a language picked from the switcher", () => {
    const storage = memory();
    setupLocaleSuggestion(document, { storage: storage.source, languages: ["en"] });
    const link = document.querySelector<HTMLAnchorElement>('a[data-locale-link="es"]');
    link?.addEventListener("click", (event) => event.preventDefault());
    link?.click();
    expect(storage.values.get(LOCALE_STORAGE_KEY)).toBe("es");
    // In the cookie the app reads too.
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=es`);
  });

  it("follows a language chosen in the app, through the shared cookie", () => {
    // biome-ignore lint/suspicious/noDocumentCookie: the test plays the browser's own cookie jar
    document.cookie = `${LOCALE_COOKIE}=en; Path=/; Secure`;
    expect(
      setupLocaleSuggestion(document, { storage: memory().source, languages: ["es"] }),
    ).toBeUndefined();
    expect(note().hidden).toBe(true);
  });

  it("hides the note for good once dismissed, moving focus to the content", () => {
    const storage = memory();
    setupLocaleSuggestion(document, { storage: storage.source, languages: ["es"] });
    document.querySelector<HTMLButtonElement>("[data-locale-dismiss]")?.click();
    expect(note().hidden).toBe(true);
    expect(storage.values.get(SUGGESTION_DISMISSED_KEY)).toBe("dismissed");
    expect(document.activeElement?.id).toBe("main");
    englishPage();
    expect(
      setupLocaleSuggestion(document, { storage: storage.source, languages: ["es"] }),
    ).toBeUndefined();
    expect(note().hidden).toBe(true);
  });

  it("still suggests, and dismisses, when storage is blocked", () => {
    expect(setupLocaleSuggestion(document, { storage: blocked, languages: ["es"] })).toBe("es");
    document.querySelector<HTMLButtonElement>("[data-locale-dismiss]")?.click();
    expect(note().hidden).toBe(true);
  });

  it("does nothing for a language without a note on the page", () => {
    document.querySelector("[data-locale-suggestion]")?.remove();
    expect(
      setupLocaleSuggestion(document, { storage: memory().source, languages: ["es"] }),
    ).toBeUndefined();
  });
});

describe("setupLanguageMenus", () => {
  it("closes an open menu with Escape and returns focus to its button", () => {
    setupLanguageMenus(document);
    const menu = document.querySelector("details") as HTMLDetailsElement;
    menu.open = true;
    menu
      .querySelector("a")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.open).toBe(false);
    expect(document.activeElement?.tagName).toBe("SUMMARY");
  });

  it("leaves a closed menu and other keys alone", () => {
    setupLanguageMenus(document);
    const menu = document.querySelector("details") as HTMLDetailsElement;
    menu.open = true;
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(menu.open).toBe(true);
  });
});
