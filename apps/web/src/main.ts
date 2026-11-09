import "./main.css";
import { setupCopyButtons } from "./copy.ts";
import { browserStorage } from "./i18n/preference.ts";
import { landingMessages } from "./landing-messages.ts";
import { setupLanguageMenus, setupLocaleSuggestion } from "./locale-suggestion.ts";
import { setupTabs } from "./tabs.ts";
import { setupTypewriter } from "./typewriter.ts";

setupCopyButtons(document, navigator.clipboard, landingMessages(document));
setupTabs(document);
setupLanguageMenus(document);
setupLocaleSuggestion(document, { storage: browserStorage, languages: navigator.languages });
void setupTypewriter(document, {
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
});
