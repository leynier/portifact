// Catalogs of the static pages on portifact.com. The English pages are the source; a catalog
// holds the text the build draws around them (`chrome`) and, for every other language, the
// message of each marker on the pages (`pages`, see ../markers.ts).
import type { PageMessages } from "../markers.ts";

/** Text the build adds to every page, in the page's language. */
export interface SiteChrome {
  /** The language switcher's accessible name, such as "Language". */
  languageLabel: string;
  /** The suggestion shown to a visitor whose languages prefer this one: "This page is in ...". */
  suggestion: string;
  /** Its link to the page in this language. */
  suggestionAction: string;
  /** Its dismiss button. */
  suggestionDismiss: string;
  /**
   * On a legal page in this language: the English text is the only one that applies, and it is
   * shown untranslated.
   */
  legalNote: string;
}

export interface SiteCatalog {
  chrome: SiteChrome;
  /** Messages of the page markers. English pages are their own source, so English has none. */
  pages: PageMessages;
}
