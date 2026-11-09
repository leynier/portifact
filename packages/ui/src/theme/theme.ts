// The theme preference at runtime: System follows the operating system through the tokens' media
// query, Light and Dark set `data-theme` on the root. The inline script (`THEME_SCRIPT` in
// `@portifact/contracts/theme`) applies the stored choice before the first paint; this module
// reads and changes it afterwards, for the landing's vanilla script and the dashboard's React.
import { THEME_STORAGE_KEY } from "@portifact/contracts/theme";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

/** `<picture>` sources written for a dark system theme, as authored or after a rewrite. */
const DARK_SOURCES = 'source[data-theme-media], source[media="(prefers-color-scheme: dark)"]';
const SYSTEM_DARK = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * The `media` of a `<picture>` source meant for the dark theme: the system query under System,
 * and a query that always or never matches when the person chose a theme.
 */
export function darkSourceMedia(preference: ThemePreference): string {
  if (preference === "dark") return "all";
  if (preference === "light") return "not all";
  return SYSTEM_DARK;
}

/** The choice the page shows now, from the root's `data-theme`. */
export function currentThemePreference(doc: Document = document): ThemePreference {
  const theme = doc.documentElement.getAttribute("data-theme");
  return theme === "light" || theme === "dark" ? theme : "system";
}

/** The stored choice, or System when there is none or storage is blocked. */
export function storedThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Shows `preference` on the page: the root's `data-theme` and every dark picture source. */
export function applyTheme(preference: ThemePreference, doc: Document = document): void {
  const root = doc.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
  const media = darkSourceMedia(preference);
  for (const source of doc.querySelectorAll<HTMLSourceElement>(DARK_SOURCES)) {
    source.setAttribute("data-theme-media", "");
    source.setAttribute("media", media);
  }
}

type Listener = (preference: ThemePreference) => void;
const listeners = new Set<Listener>();
let watchingOtherTabs = false;

function notify(preference: ThemePreference): void {
  for (const listener of listeners) listener(preference);
}

// A choice made in another tab of the same origin arrives as a `storage` event.
function onStorage(event: StorageEvent): void {
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
  const preference = storedThemePreference();
  applyTheme(preference);
  notify(preference);
}

/**
 * Applies, remembers and announces a choice. When storage is blocked the choice still holds for
 * this page and the next load starts from System; returns whether it was stored.
 */
export function setThemePreference(preference: ThemePreference): boolean {
  applyTheme(preference);
  notify(preference);
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

/** Calls `listener` whenever the choice changes, here or in another tab; returns the unsubscribe. */
export function subscribeThemePreference(listener: Listener): () => void {
  listeners.add(listener);
  if (!watchingOtherTabs) {
    window.addEventListener("storage", onStorage);
    watchingOtherTabs = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && watchingOtherTabs) {
      window.removeEventListener("storage", onStorage);
      watchingOtherTabs = false;
    }
  };
}

/**
 * Wires static theme switchers: every `[data-theme-switcher]` fieldset of radios valued
 * `system`, `light` and `dark`, as the landing page writes them. Returns how many it wired.
 */
export function setupThemeSwitchers(root: ParentNode, doc: Document = document): number {
  const switchers = root.querySelectorAll<HTMLFieldSetElement>("[data-theme-switcher]");
  const check = (preference: ThemePreference) => {
    for (const radio of root.querySelectorAll<HTMLInputElement>(
      "[data-theme-switcher] input[type=radio]",
    )) {
      radio.checked = radio.value === preference;
    }
  };
  for (const switcher of switchers) {
    switcher.addEventListener("change", (event) => {
      const value = (event.target as HTMLInputElement).value;
      if (isThemePreference(value)) setThemePreference(value);
    });
  }
  if (switchers.length > 0) {
    check(currentThemePreference(doc));
    subscribeThemePreference(check);
  }
  return switchers.length;
}
