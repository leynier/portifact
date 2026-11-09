// Russian catalog of the static pages ("вы" in lowercase): the text the build draws around them
// and the messages of the landing's and the documents' markers.
import { documents } from "./ru/documents.ts";
import { landing } from "./ru/landing.ts";
import type { SiteCatalog } from "./types.ts";

export const ru: SiteCatalog = {
  chrome: {
    languageLabel: "Язык",
    suggestion: "Эта страница доступна на русском языке.",
    suggestionAction: "Читать на русском",
    suggestionDismiss: "Закрыть",
    legalNote:
      "Этот документ опубликован только на английском языке, и действует именно английский текст.",
  },
  pages: { ...landing, ...documents },
};
