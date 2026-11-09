// Text the landing page's scripts write at runtime, in every language. The page's own text is
// translated at build from its markers (src/i18n/site.ts); these messages are the ones its
// scripts announce, picked by the language the build gave the page.
import { DEFAULT_LOCALE, isLocale, type LocaleCode } from "@portifact/contracts/locales";

export interface LandingMessages {
  /** A copy button's label when it has no text of its own. */
  copy: string;
  /** A copy button's label right after copying. */
  copied: string;
  /** Announced after a successful copy. */
  copiedStatus: string;
  /** Announced when the browser offers no clipboard or the target is empty. */
  copyUnavailable: string;
  /** Announced when the clipboard refuses the text. */
  copyFailed: string;
}

export const LANDING_MESSAGES: Readonly<Record<LocaleCode, LandingMessages>> = {
  en: {
    copy: "Copy",
    copied: "Copied",
    copiedStatus: "Copied to the clipboard.",
    copyUnavailable: "Copy is not available. Select the text and copy it manually.",
    copyFailed: "Copy failed. Select the text and copy it manually.",
  },
  es: {
    copy: "Copiar",
    copied: "Copiado",
    copiedStatus: "Copiado al portapapeles.",
    copyUnavailable: "No se puede copiar. Selecciona el texto y cópialo manualmente.",
    copyFailed: "No se pudo copiar. Selecciona el texto y cópialo manualmente.",
  },
};

/** The messages in the page's language (`<html lang>`), or English when it is not one we have. */
export function landingMessages(document: Document): LandingMessages {
  const lang = document.documentElement.lang;
  return LANDING_MESSAGES[isLocale(lang) ? lang : DEFAULT_LOCALE];
}
