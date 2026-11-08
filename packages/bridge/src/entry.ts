// Entry of the bundle served at /__portifact/bridge.js. The content Worker injects it only into
// review-mode HTML, with the viewer's origin, the served file and the renderer as data
// attributes. In a top-level window (no viewer around it) it does nothing.
import { startBridge } from "./bridge.ts";
import { readConfig } from "./config.ts";

const script = document.currentScript;
const config = script instanceof HTMLScriptElement ? readConfig(script.dataset) : null;
if (config && window.parent !== window) startBridge(window, window.parent, config);
