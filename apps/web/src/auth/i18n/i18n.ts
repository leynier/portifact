// The language of the auth and report pages. Each page is written in English, with markers on
// every text (src/i18n/markers.ts); before a page sets up, this picks the reader's language
// (`?lang=`, then the kept choice, then the browser's languages), loads that language's catalog
// as its own chunk and translates the markers and the scripts' messages. A catalog that fails to
// load (offline) leaves the page in English. The footer gets a switcher whose links keep the
// page's other parameters (`next`, `user_code`, the signed OAuth request).
import { LOCALES, type LocaleCode } from "@portifact/contracts/locales";
import { languageLinksHtml } from "@portifact/ui/language-links";
import { localizeDocument } from "../../i18n/markers.ts";
import {
  applyDocumentLocale,
  LOCALE_PARAM,
  type PageLocaleSources,
  pageLocale,
  withLocaleParam,
  withoutLocaleParam,
} from "../../i18n/preference.ts";
import { messages } from "../messages.ts";
import { en } from "./en.ts";
import type { AuthCatalog } from "./types.ts";

export type AuthCatalogLoaders = {
  readonly [code in Exclude<LocaleCode, "en">]: () => Promise<AuthCatalog>;
};

/** One loader per language besides English, so adding a locale fails the typecheck until it has one. */
export const authCatalogLoaders: AuthCatalogLoaders = {
  es: () => import("./es.ts").then((module) => module.es),
  "pt-BR": () => import("./pt-br.ts").then((module) => module.ptBR),
  fr: () => import("./fr.ts").then((module) => module.fr),
  de: () => import("./de.ts").then((module) => module.de),
  ru: () => import("./ru.ts").then((module) => module.ru),
  ja: () => import("./ja.ts").then((module) => module.ja),
  "zh-CN": () => import("./zh-cn.ts").then((module) => module.zhCN),
};

export interface AuthPageLocaleSources extends PageLocaleSources {
  /** The catalogs to load; tests pass their own. */
  loaders?: AuthCatalogLoaders;
}

/** Translates the page into the reader's language and returns the language it shows. */
export async function localizeAuthPage(
  document: Document,
  sources: AuthPageLocaleSources,
): Promise<LocaleCode> {
  const wanted = pageLocale(sources);
  forgetLocaleParam(document, sources.url);
  const shown = await applyCatalog(document, wanted, sources.loaders ?? authCatalogLoaders);
  applyDocumentLocale(document, shown);
  renderSwitchers(document, sources.url, shown);
  return shown;
}

async function applyCatalog(
  document: Document,
  locale: LocaleCode,
  loaders: AuthCatalogLoaders,
): Promise<LocaleCode> {
  if (locale === "en") {
    Object.assign(messages, en);
    return "en";
  }
  let catalog: AuthCatalog;
  try {
    catalog = await loaders[locale]();
  } catch {
    Object.assign(messages, en);
    return "en";
  }
  localizeDocument(document, catalog.page);
  Object.assign(messages, catalog.messages);
  return locale;
}

/** Once the choice is kept, `?lang=` leaves the address bar, so a shared link carries no language. */
function forgetLocaleParam(document: Document, url: string): void {
  if (!new URL(url).searchParams.has(LOCALE_PARAM)) return;
  try {
    document.defaultView?.history.replaceState(null, "", withoutLocaleParam(url));
  } catch {
    // A page whose history refuses the change still works; the parameter only stays visible.
  }
}

function renderSwitchers(document: Document, url: string, current: LocaleCode): void {
  const html = languageLinksHtml({
    variant: "list",
    label: messages.languageLabel,
    links: LOCALES.map((locale) => ({
      code: locale.code,
      name: locale.name,
      href: withLocaleParam(url, locale.code),
      current: locale.code === current,
    })),
  });
  for (const slot of document.querySelectorAll("[data-language-switcher]")) slot.innerHTML = html;
}
