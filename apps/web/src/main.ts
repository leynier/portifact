import "./main.css";
import { setupThemeSwitchers } from "@portifact/ui/theme";
import { setupCopyButtons } from "./copy.ts";
import { setupTabs } from "./tabs.ts";
import { setupTypewriter } from "./typewriter.ts";

setupCopyButtons(document, navigator.clipboard);
setupTabs(document);
setupThemeSwitchers(document);
void setupTypewriter(document, {
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
});
