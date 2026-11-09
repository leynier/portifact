// The landing's language helpers. Nobody is redirected by language (crawlers and people get the
// page they asked for); a visitor whose languages prefer another one sees a quiet note linking
// to it, written in that language, until they dismiss it or pick a language. The notes and the
// switcher are drawn at build time (src/i18n/site.ts); this only shows, hides and remembers.
import { isLocale, type LocaleCode } from "@portifact/contracts/locales";
import { resolveLocale } from "@portifact/domain/locale";
import { readStoredLocale, type StorageSource, storeLocale } from "./i18n/preference.ts";

/** Kept once the visitor dismissed the note, so it never comes back in this browser. */
export const SUGGESTION_DISMISSED_KEY = "portifact.locale.suggestion";

export interface SuggestionSources {
  storage: StorageSource;
  /** `navigator.languages`. */
  languages: readonly string[];
}

function dismissed(storage: StorageSource): boolean {
  try {
    return storage()?.getItem(SUGGESTION_DISMISSED_KEY) === "dismissed";
  } catch {
    return false;
  }
}

function dismiss(storage: StorageSource): void {
  try {
    storage()?.setItem(SUGGESTION_DISMISSED_KEY, "dismissed");
  } catch {
    // Blocked storage only means the note may show again on the next visit.
  }
}

/**
 * Remembers a language picked from a switcher or a note, and shows the note of the language the
 * visitor prefers when it is not the page's. Returns the language suggested, if any.
 */
export function setupLocaleSuggestion(
  document: Document,
  sources: SuggestionSources,
): LocaleCode | undefined {
  for (const link of document.querySelectorAll<HTMLElement>("[data-locale-link]")) {
    link.addEventListener("click", () => {
      const code = link.dataset.localeLink;
      if (isLocale(code)) storeLocale(sources.storage, code);
    });
  }
  const page = document.documentElement.lang;
  const preferred = resolveLocale({
    chosen: [readStoredLocale(sources.storage)],
    browser: sources.languages,
  });
  if (preferred === page || dismissed(sources.storage)) return undefined;
  const note = document.querySelector<HTMLElement>(`[data-locale-suggestion="${preferred}"]`);
  if (!note) return undefined;
  note.hidden = false;
  note.querySelector("[data-locale-dismiss]")?.addEventListener("click", () => {
    note.hidden = true;
    dismiss(sources.storage);
    // The button is gone, so focus moves on to the page's content instead of being lost.
    const main = document.getElementById("main");
    if (main && !main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    main?.focus();
  });
  return preferred;
}

/** Escape closes an open language menu and returns focus to its button, like a menu does. */
export function setupLanguageMenus(document: Document): void {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>("details[data-language-menu]")) {
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !menu.open) return;
      menu.open = false;
      menu.querySelector("summary")?.focus();
    });
  }
}
