// German catalog of the static pages (Germany, informal "du"): the text the build draws around
// them and the messages of the landing's and the documents' markers.
import { documents } from "./de/documents.ts";
import { landing } from "./de/landing.ts";
import type { SiteCatalog } from "./types.ts";

export const de: SiteCatalog = {
  chrome: {
    languageLabel: "Sprache",
    suggestion: "Diese Seite ist auf Deutsch verfügbar.",
    suggestionAction: "Auf Deutsch lesen",
    suggestionDismiss: "Schließen",
    legalNote:
      "Dieses Dokument wird nur auf Englisch veröffentlicht, und der englische Text ist der maßgebliche.",
  },
  pages: { ...landing, ...documents },
};
