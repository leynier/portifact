// Brazilian Portuguese catalog of the static pages, with "você": the text the build draws around
// them and the messages of the landing's and the documents' markers.
import { documents } from "./pt-br/documents.ts";
import { landing } from "./pt-br/landing.ts";
import type { SiteCatalog } from "./types.ts";

export const ptBR: SiteCatalog = {
  chrome: {
    languageLabel: "Idioma",
    suggestion: "Esta página está disponível em português.",
    suggestionAction: "Ler em português",
    suggestionDismiss: "Fechar",
    legalNote: "Este documento é publicado apenas em inglês, e o texto em inglês é o que vale.",
  },
  pages: { ...landing, ...documents },
};
