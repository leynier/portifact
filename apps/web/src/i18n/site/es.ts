// Spanish catalog of the static pages: the text the build draws around them and the messages of
// the landing's and the documents' markers.
import { documents } from "./es/documents.ts";
import { landing } from "./es/landing.ts";
import type { SiteCatalog } from "./types.ts";

export const es: SiteCatalog = {
  chrome: {
    languageLabel: "Idioma",
    suggestion: "Esta página está disponible en español.",
    suggestionAction: "Leerla en español",
    suggestionDismiss: "Cerrar",
    legalNote:
      "Este documento se publica solo en inglés, y el texto en inglés es el que se aplica.",
  },
  pages: { ...landing, ...documents },
};
