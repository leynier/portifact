// French catalog of the static pages (France, "vous"): the text the build draws around them and
// the messages of the landing's and the documents' markers.
import { documents } from "./fr/documents.ts";
import { landing } from "./fr/landing.ts";
import type { SiteCatalog } from "./types.ts";

export const fr: SiteCatalog = {
  chrome: {
    languageLabel: "Langue",
    suggestion: "Cette page est disponible en français.",
    suggestionAction: "La lire en français",
    suggestionDismiss: "Fermer",
    legalNote:
      "Ce document est publié uniquement en anglais, et c’est le texte anglais qui fait foi.",
  },
  pages: { ...landing, ...documents },
};
