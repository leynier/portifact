// The dashboard's i18n layer: Lingui with runtime-compiled ICU catalogs. English is bundled as
// the source and the fallback; every other language is its own chunk, loaded when it is chosen.
// Adding a language means adding its catalog (`xx.ts`, `satisfies Catalog`) and its loader below;
// the loaders are typed by the locale list, so a missing one fails the typecheck.
import { type I18n, setupI18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { type Catalog, en, type MessageId } from "./en.ts";

declare module "@lingui/core" {
  interface Register {
    messageIds: MessageId;
  }
}

export type CatalogLoaders = { readonly [code in LocaleCode]: () => Promise<Catalog> };

export const CATALOG_LOADERS: CatalogLoaders = {
  en: async () => en,
  es: () => import("./es.ts").then((module) => module.es),
  "pt-BR": () => import("./pt-br.ts").then((module) => module.ptBR),
  fr: () => import("./fr.ts").then((module) => module.fr),
  de: () => import("./de.ts").then((module) => module.de),
  ru: () => import("./ru.ts").then((module) => module.ru),
  ja: () => import("./ja.ts").then((module) => module.ja),
  "zh-CN": () => import("./zh-cn.ts").then((module) => module.zhCN),
};

/** An i18n instance with a catalog already loaded: English unless another is given. */
export function createI18n(locale: LocaleCode = DEFAULT_LOCALE, messages: Catalog = en): I18n {
  const i18n = setupI18n();
  i18n.setMessagesCompiler(compileMessage);
  i18n.loadAndActivate({ locale, messages });
  return i18n;
}

/**
 * Loads a language's catalog and switches to it. When the catalog cannot be loaded (offline, a
 * stale chunk after a deploy), the current language stays and the error is passed on.
 */
export async function activateLocale(
  i18n: I18n,
  locale: LocaleCode,
  loaders: CatalogLoaders = CATALOG_LOADERS,
): Promise<void> {
  const messages = await loaders[locale]();
  i18n.loadAndActivate({ locale, messages });
}
