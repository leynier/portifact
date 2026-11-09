// @vitest-environment happy-dom
import { preferenceCookie } from "@portifact/contracts/preferences";
import { THEME_COOKIE, THEME_SCRIPT, THEME_STORAGE_KEY } from "@portifact/contracts/theme";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  currentThemePreference,
  darkSourceMedia,
  isThemePreference,
  setThemePreference,
  setupThemeSwitchers,
  storedThemePreference,
  subscribeThemePreference,
} from "./theme.ts";

const DARK = "(prefers-color-scheme: dark)";

function picture(): HTMLSourceElement {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<picture><source media="${DARK}" srcset="dark.svg" /><img src="light.svg" alt="logo" /></picture>`,
  );
  const sources = document.querySelectorAll("source");
  const source = sources[sources.length - 1];
  if (!source) throw new Error("no source");
  return source;
}

/** Runs the inline head script the pages carry, exactly as written. */
function runHeadScript(): void {
  new Function(THEME_SCRIPT)();
}

function blockStorage() {
  return vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
}

/** `document.cookie` as the page has it, put back after every test. */
const COOKIE = (() => {
  for (let target: object | null = document; target; target = Object.getPrototypeOf(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "cookie");
    if (descriptor) return descriptor;
  }
  throw new Error("no document.cookie");
})();

function overrideCookies(get: () => string, set: (value: string) => void): void {
  Object.defineProperty(document, "cookie", { configurable: true, get, set });
}

/** Cookies a browser refuses: reading and writing `document.cookie` throw. */
function blockCookies() {
  const refuse = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  overrideCookies(refuse, refuse);
}

/** Records every cookie the page writes, still writing it. */
function recordCookieWrites(): string[] {
  const writes: string[] = [];
  overrideCookies(
    () => COOKIE.get?.call(document),
    (value) => {
      writes.push(value);
      COOKIE.set?.call(document, value);
    },
  );
  return writes;
}

/** The shared cookie as the other host (the landing or the app) leaves it. */
function sharedCookie(value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: the test plays the browser's own cookie jar
  document.cookie = `${THEME_COOKIE}=${value}; Path=/; Secure`;
}

beforeEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: the test plays the browser's own cookie jar
  document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0; Secure`;
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(document, "cookie", COOKIE);
});

describe("theme preference", () => {
  it("maps each choice to the media of dark picture sources", () => {
    expect(darkSourceMedia("system")).toBe(DARK);
    expect(darkSourceMedia("dark")).toBe("all");
    expect(darkSourceMedia("light")).toBe("not all");
  });

  it("recognizes only the three choices", () => {
    expect(["system", "light", "dark"].every(isThemePreference)).toBe(true);
    expect(isThemePreference("auto")).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });

  it("sets the root's data-theme and points dark sources at the choice", () => {
    const source = picture();
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(source.media).toBe("all");
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(source.media).toBe("not all");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(source.media).toBe(DARK);
    expect(currentThemePreference()).toBe("system");
  });

  it("remembers Light and Dark, and forgets the choice for System", () => {
    expect(setThemePreference("dark")).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(storedThemePreference()).toBe("dark");
    expect(setThemePreference("system")).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(storedThemePreference()).toBe("system");
  });

  it("shares every choice, System included, in the preference cookie", () => {
    const writes = recordCookieWrites();
    setThemePreference("dark");
    expect(writes).toEqual([preferenceCookie(THEME_COOKIE, "dark", window.location.hostname)]);
    expect(document.cookie).toContain(`${THEME_COOKIE}=dark`);
    setThemePreference("system");
    expect(document.cookie).toContain(`${THEME_COOKIE}=system`);
  });

  it("prefers the shared cookie over this origin's storage, an explicit System too", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    sharedCookie("light");
    expect(storedThemePreference()).toBe("light");
    sharedCookie("system");
    expect(storedThemePreference()).toBe("system");
    sharedCookie("sepia");
    expect(storedThemePreference()).toBe("dark");
  });

  it("keeps the choice in storage when cookies are blocked", () => {
    blockCookies();
    expect(setThemePreference("dark")).toBe(true);
    expect(storedThemePreference()).toBe("dark");
  });

  it("keeps the choice in the cookie when storage is blocked", () => {
    blockStorage();
    expect(setThemePreference("dark")).toBe(true);
    expect(storedThemePreference()).toBe("dark");
  });

  it("still applies a choice for this page when cookies and storage are blocked", () => {
    blockStorage();
    blockCookies();
    expect(setThemePreference("dark")).toBe(false);
    expect(currentThemePreference()).toBe("dark");
    expect(storedThemePreference()).toBe("system");
  });

  it("tells subscribers about changes here and in other tabs", () => {
    const seen: string[] = [];
    const stop = subscribeThemePreference((preference) => seen.push(preference));
    setThemePreference("light");
    // Another tab of this origin writes the same cookie and storage.
    sharedCookie("dark");
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    window.dispatchEvent(new StorageEvent("storage", { key: "something.else" }));
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(seen).toEqual(["light", "dark"]);
    expect(currentThemePreference()).toBe("dark");
    stop();
    sharedCookie("light");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(seen).toHaveLength(2);
  });

  it("catches up with a choice made on the other host when the tab is shown again", () => {
    const seen: string[] = [];
    const stop = subscribeThemePreference((preference) => seen.push(preference));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    sharedCookie("dark");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(seen).toEqual([]);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(seen).toEqual(["dark"]);
    expect(currentThemePreference()).toBe("dark");
    sharedCookie("light");
    window.dispatchEvent(new Event("pageshow"));
    expect(seen).toEqual(["dark", "light"]);
    stop();
    sharedCookie("system");
    window.dispatchEvent(new Event("pageshow"));
    expect(seen).toHaveLength(2);
  });
});

describe("inline head script", () => {
  it("applies a stored Dark choice and rewrites sources added later while the page loads", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const early = picture();
    runHeadScript();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(early.media).toBe("all");
    const late = picture();
    await Promise.resolve();
    expect(late.media).toBe("all");
    expect(late.hasAttribute("data-theme-media")).toBe(true);
    // After loading, the runtime takes over from the marked sources.
    applyTheme("system");
    expect(late.media).toBe(DARK);
  });

  it("applies a stored Light choice", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const source = picture();
    runHeadScript();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(source.media).toBe("not all");
  });

  it("applies the shared cookie first, where System beats this origin's storage", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    sharedCookie("dark");
    const source = picture();
    runHeadScript();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(source.media).toBe("all");
    document.documentElement.removeAttribute("data-theme");
    sharedCookie("system");
    runHeadScript();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    // biome-ignore lint/suspicious/noDocumentCookie: the test plays the browser's own cookie jar
    document.cookie = `other=1; Path=/`;
    sharedCookie("sepia");
    runHeadScript();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to this origin's storage when cookies are blocked", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    blockCookies();
    expect(runHeadScript).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("leaves the System theme for no choice, an unknown one or blocked storage", () => {
    const source = picture();
    runHeadScript();
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    runHeadScript();
    blockStorage();
    expect(runHeadScript).not.toThrow();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(source.media).toBe(DARK);
  });
});

describe("static theme switchers", () => {
  const markup = (name: string) =>
    `<fieldset data-theme-switcher><legend>Theme</legend>${["system", "light", "dark"]
      .map(
        (value) => `<label><input type="radio" name="${name}" value="${value}" />${value}</label>`,
      )
      .join("")}</fieldset>`;

  it("checks the current choice and applies a new one", () => {
    document.documentElement.setAttribute("data-theme", "light");
    document.body.innerHTML = `${markup("a")}${markup("b")}`;
    expect(setupThemeSwitchers(document)).toBe(2);
    const radios = [...document.querySelectorAll<HTMLInputElement>("input")];
    expect(radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual([
      "light",
      "light",
    ]);
    const dark = radios.find((radio) => radio.name === "a" && radio.value === "dark");
    if (!dark) throw new Error("no dark radio");
    dark.click();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    // The other switcher on the page follows.
    expect(radios.filter((radio) => radio.checked).map((radio) => radio.name)).toEqual(["a", "b"]);
  });

  it("ignores values that are not a choice and pages without a switcher", () => {
    document.body.innerHTML =
      '<fieldset data-theme-switcher><input type="radio" name="x" value="sepia" /></fieldset>';
    setupThemeSwitchers(document);
    document.querySelector<HTMLInputElement>("input")?.click();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    document.body.innerHTML = "";
    expect(setupThemeSwitchers(document)).toBe(0);
  });
});
