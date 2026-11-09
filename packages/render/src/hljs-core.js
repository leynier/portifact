// highlight.js's core, behind local types (hljs-core.d.ts): its own types reference the DOM
// library, which would leak browser globals into every Worker that bundles the renderer.
export { default } from "highlight.js/lib/core";
