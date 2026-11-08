// The Content-Security-Policy of rendered documents. Kept apart from the renderer so the content
// Worker can send it as a header without bundling markdown-it.

/**
 * Defense in depth if the renderer ever lets markup through: no scripts, frames, plugins, forms
 * or base URL changes. Styles are the inline stylesheet of the document, and images load only from the
 * artifact unless remote images are enabled.
 */
export function documentPolicy(remoteImages: boolean): string {
  return [
    "default-src 'none'",
    `img-src 'self'${remoteImages ? " https:" : ""}`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
