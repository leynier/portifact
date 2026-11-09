// English text the build draws around the static pages. The pages themselves are the English
// source, so there are no page messages here.
import type { SiteCatalog } from "./types.ts";

export const en: SiteCatalog = {
  chrome: {
    languageLabel: "Language",
    suggestion: "This page is available in English.",
    suggestionAction: "Read it in English",
    suggestionDismiss: "Dismiss",
    legalNote:
      "This document is published in English only, and the English text is the one that applies.",
  },
  pages: {},
};
