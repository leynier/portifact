// Stands in for @portifact/render/diagrams-bundle in these tests: the real script (about 5.5 MB)
// is larger than the Workers test pool can send to workerd. The e2e suite serves the real one.
export const DIAGRAM_SCRIPT = 'globalThis["mermaid"] = {}; /* runner: pre.pf-mermaid */';
export const DIAGRAM_VERSION = "0123456789abcdef";
export const MERMAID_VERSION = "0.0.0";
