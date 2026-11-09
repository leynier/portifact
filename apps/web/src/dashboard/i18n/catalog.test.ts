import { compileMessage } from "@lingui/message-utils/compileMessage";
import { LOCALE_CODES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { type Catalog, en } from "./en.ts";
import { activateLocale, CATALOG_LOADERS, createI18n } from "./i18n.ts";

const ids = Object.keys(en) as (keyof Catalog)[];

/**
 * The shape of a compiled message: each argument it reads and, for plurals and selects, their
 * cases (`count:plural:one`). The text between them is what a translation changes.
 */
function shapeOf(message: string): string[] {
  const found = new Set<string>();
  // A compiled message is a list of parts: text, `[name]` for an argument, or
  // `[name, kind, cases]` for a plural or select whose cases are lists of parts again.
  const parts = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const part of list) {
      if (!Array.isArray(part) || typeof part[0] !== "string") continue;
      const [name, kind, cases] = part as [string, unknown, unknown];
      if (typeof kind !== "string") {
        found.add(name);
        continue;
      }
      found.add(`${name}:${kind}`);
      for (const [key, branch] of Object.entries((cases ?? {}) as Record<string, unknown>)) {
        found.add(`${name}:${kind}:${key}`);
        parts(branch);
      }
    }
  };
  parts(compileMessage(message));
  return [...found].sort();
}

const catalogs = await Promise.all(
  LOCALE_CODES.map(async (code) => [code, await CATALOG_LOADERS[code]()] as const),
);

describe.each(catalogs.filter(([code]) => code !== "en"))("the %s catalog", (code, catalog) => {
  it("has exactly the English message IDs", () => {
    expect(Object.keys(catalog).sort()).toEqual([...ids].sort());
  });

  it("keeps every message's arguments and plural or select cases", () => {
    for (const id of ids) {
      // A language may need plural categories English does not (`few`, `many`), never fewer.
      const english = shapeOf(en[id]);
      expect(shapeOf(catalog[id]), id).toEqual(expect.arrayContaining(english));
      const extra = shapeOf(catalog[id]).filter(
        (part) => !shapeOf(en[id]).includes(part) && !/:plural:\w+$/.test(part),
      );
      expect(extra, id).toEqual([]);
    }
  });

  it("compiles every message as ICU", () => {
    for (const id of ids) {
      expect(() => compileMessage(catalog[id]), id).not.toThrow();
    }
  });

  it("is translated: no empty messages and no em or en dashes", () => {
    for (const id of ids) {
      expect(catalog[id].trim(), id).not.toBe("");
      expect(catalog[id], id).not.toMatch(/[–—]/);
    }
  });

  it("formats plurals with the language's rules", async () => {
    const i18n = createI18n();
    await activateLocale(i18n, code);
    expect(i18n.locale).toBe(code);
    expect(i18n._("list.count", { count: 1 })).not.toBe(i18n._("list.count", { count: 2 }));
  });
});

describe("the English catalog", () => {
  it("has no em or en dashes", () => {
    for (const id of ids) expect(en[id], id).not.toMatch(/[–—]/);
  });
});

describe("activateLocale", () => {
  it("switches the language and its formats", async () => {
    const i18n = createI18n();
    expect(i18n._("list.title")).toBe("Artifacts");
    await activateLocale(i18n, "es");
    expect(i18n._("language.title")).toBe("Idioma");
    expect(i18n.number(1234.5)).toBe(new Intl.NumberFormat("es").format(1234.5));
  });

  it("keeps the current language when a catalog cannot load", async () => {
    const i18n = createI18n();
    const offline = { ...CATALOG_LOADERS, es: () => Promise.reject(new Error("offline")) };
    await expect(activateLocale(i18n, "es", offline)).rejects.toThrow("offline");
    expect(i18n.locale).toBe("en");
    expect(i18n._("language.title")).toBe("Language");
  });
});
