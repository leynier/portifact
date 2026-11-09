// The languages Portifact is translated into. Kept free of imports so the landing and the auth
// pages can use it without bundling the schemas (`@portifact/contracts/locales`).
//
// Adding a language: add its entry here, then a catalog for every surface (the dashboard, the auth
// pages, the site and the emails). The catalogs are typed against this list, so the typecheck
// and the catalog tests fail until each one exists (docs/design.md, "Languages").

export interface LocaleInfo {
  /** BCP 47 tag, also the `lang` attribute of pages in this language. */
  readonly code: string;
  /** The language's name in itself, as the language switchers show it. */
  readonly name: string;
  /** Text direction, the `dir` attribute of pages in this language. */
  readonly dir: "ltr" | "rtl";
}

export const LOCALES = [
  { code: "en", name: "English", dir: "ltr" },
  { code: "es", name: "Español", dir: "ltr" },
  { code: "pt-BR", name: "Português (Brasil)", dir: "ltr" },
  { code: "fr", name: "Français", dir: "ltr" },
  { code: "de", name: "Deutsch", dir: "ltr" },
  { code: "ru", name: "Русский", dir: "ltr" },
  { code: "ja", name: "日本語", dir: "ltr" },
  { code: "zh-CN", name: "简体中文", dir: "ltr" },
] as const satisfies readonly LocaleInfo[];

export type LocaleCode = (typeof LOCALES)[number]["code"];

/** The language of pages and emails when nothing says otherwise, and the source of every text. */
export const DEFAULT_LOCALE: LocaleCode = "en";

export const LOCALE_CODES: readonly [LocaleCode, ...LocaleCode[]] = [
  LOCALES[0].code,
  ...LOCALES.slice(1).map((locale) => locale.code),
];

export function isLocale(value: unknown): value is LocaleCode {
  return typeof value === "string" && (LOCALE_CODES as readonly string[]).includes(value);
}

export function localeInfo(code: LocaleCode): LocaleInfo {
  return LOCALES.find((locale) => locale.code === code) ?? LOCALES[0];
}
