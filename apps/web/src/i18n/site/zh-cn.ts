// Simplified Chinese catalog of the static pages (mainland China, "你"): the text the build draws
// around them and the messages of the landing's and the documents' markers.
import type { SiteCatalog } from "./types.ts";
import { documents } from "./zh-cn/documents.ts";
import { landing } from "./zh-cn/landing.ts";

export const zhCN: SiteCatalog = {
  chrome: {
    languageLabel: "语言",
    suggestion: "此页面提供简体中文版本。",
    suggestionAction: "阅读简体中文版",
    suggestionDismiss: "关闭",
    legalNote: "本文档仅以英文发布，以英文文本为准。",
  },
  pages: { ...landing, ...documents },
};
