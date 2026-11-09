// Japanese catalog of the static pages (polite です・ます): the text the build draws around them
// and the messages of the landing's and the documents' markers.
import { documents } from "./ja/documents.ts";
import { landing } from "./ja/landing.ts";
import type { SiteCatalog } from "./types.ts";

export const ja: SiteCatalog = {
  chrome: {
    languageLabel: "言語",
    suggestion: "このページは日本語でもご覧いただけます。",
    suggestionAction: "日本語で読む",
    suggestionDismiss: "閉じる",
    legalNote: "この文書は英語でのみ公開されており、適用されるのは英語の本文です。",
  },
  pages: { ...landing, ...documents },
};
