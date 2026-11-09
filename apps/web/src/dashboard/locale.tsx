// The dashboard's language: which one is active, and switching it. A switch loads the catalog,
// sets the document's `lang` and `dir` and keeps the choice in this browser; the account keeps
// it too (`locale` in the account settings), so other devices and the emails follow it.
import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { isLocale, LOCALES, type LocaleCode } from "@portifact/contracts/locales";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import {
  applyDocumentLocale,
  browserStorage,
  type StorageSource,
  storeLocale,
} from "../i18n/preference.ts";
import { activateLocale, CATALOG_LOADERS, type CatalogLoaders } from "./i18n/i18n.ts";

export interface LocaleOptions {
  /** Where the choice is kept; the browser's local storage by default. */
  storage?: StorageSource;
  /** The catalog loaders; the bundled ones by default. */
  loaders?: CatalogLoaders;
}

interface LocaleControl {
  locale: LocaleCode;
  /** Switches the language; rejects, keeping the current one, when the catalog cannot load. */
  setLocale(locale: LocaleCode): Promise<void>;
}

const LocaleContext = createContext<LocaleControl | null>(null);

export function LocaleProvider({
  i18n,
  options,
  children,
}: {
  i18n: I18n;
  options?: LocaleOptions | undefined;
  children: ReactNode;
}) {
  // Re-renders when the active language changes.
  const { i18n: active } = useLingui();
  const locale = isLocale(active.locale) ? active.locale : "en";
  const storage = options?.storage ?? browserStorage;
  const loaders = options?.loaders ?? CATALOG_LOADERS;
  const setLocale = useCallback(
    async (next: LocaleCode) => {
      if (next !== i18n.locale) await activateLocale(i18n, next, loaders);
      applyDocumentLocale(document, next);
      storeLocale(storage, next);
    },
    [i18n, loaders, storage],
  );
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleControl {
  const control = useContext(LocaleContext);
  if (!control) throw new Error("useLocale needs a LocaleProvider");
  return control;
}

/** The languages the switchers offer, each by its own name. */
export const LANGUAGES = LOCALES.map((locale) => ({ code: locale.code, name: locale.name }));
