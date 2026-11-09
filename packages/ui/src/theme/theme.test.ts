// @vitest-environment happy-dom
import { THEME_SCRIPT, THEME_STORAGE_KEY } from "@portifact/contracts/theme";
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

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = "";
});

afterEach(() => vi.restoreAllMocks());

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

  it("still applies a choice for this page when storage is blocked", () => {
    blockStorage();
    expect(setThemePreference("dark")).toBe(false);
    expect(currentThemePreference()).toBe("dark");
    expect(storedThemePreference()).toBe("system");
  });

  it("tells subscribers about changes here and in other tabs", () => {
    const seen: string[] = [];
    const stop = subscribeThemePreference((preference) => seen.push(preference));
    setThemePreference("light");
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    window.dispatchEvent(new StorageEvent("storage", { key: "something.else" }));
    expect(seen).toEqual(["light", "dark"]);
    expect(currentThemePreference()).toBe("dark");
    stop();
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
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
