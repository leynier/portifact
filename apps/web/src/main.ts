import "./main.css";
import { setupCopyButtons } from "./copy.ts";
import { setupTabs } from "./tabs.ts";

setupCopyButtons(document, navigator.clipboard);
setupTabs(document);
