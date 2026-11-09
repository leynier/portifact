// Stands in for @portifact/render/diagrams-bundle in these tests: the real module (about 3.7 MB)
// is too large for the Workers test pool to send to workerd. The e2e suite serves the real one.
// The body is `STUB_SCRIPT` compressed with brotli.
export const STUB_SCRIPT = 'globalThis["mermaid"] = {}; /* runner: pre.pf-mermaid */\n';
export const DIAGRAM_BROTLI =
  "GzgA+OVt+50lTqH8nd2LRpCRQwmjJkSUhSqSHMTQDqodfR1NwqYuHPcGE8R3l6hwQ8rdOYE4AQ==";
export const DIAGRAM_BYTES = 57;
