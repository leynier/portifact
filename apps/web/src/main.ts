import "./main.css";
import { setupCopyButtons } from "./copy.ts";
import { setupTabs } from "./tabs.ts";
import { setupTypewriter } from "./typewriter.ts";

setupCopyButtons(document, navigator.clipboard);
setupTabs(document);
void setupTypewriter(document, {
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
});
