// The Content-Security-Policy of rendered documents and the diagram loader it allows. Kept apart
// from the renderer so the content Worker can send it as a header without bundling markdown-it.

/**
 * The stable path the diagram loader requests on every artifact origin. It answers a short-lived
 * redirect to the current build's content-hashed file (`diagramFilePath`), so documents never
 * carry a build's hash and keep working across builds, while the file itself is immutable.
 */
export const DIAGRAM_PATH = "/__portifact/diagrams.js";

/** The diagram script of one build: the pinned Mermaid build followed by Portifact's runner. */
export function diagramFilePath(version: string): string {
  return `/__portifact/diagrams.${version}.js`;
}

/** The build version in a content-hashed diagram script path, or undefined for any other path. */
export function diagramFileVersion(pathname: string): string | undefined {
  return /^\/__portifact\/diagrams\.([0-9a-f]{16})\.js$/.exec(pathname)?.[1];
}

/**
 * The only inline script a rendered document may carry, added at commit when the document has
 * Mermaid blocks: it loads the diagram script from the artifact's own origin. Its text never
 * changes, because published documents keep their rendering and are allowed it by this hash; a
 * new loader must keep the old hash in `documentPolicy` for the documents that carry it.
 */
export const DIAGRAM_LOADER = `(()=>{const s=document.createElement("script");s.src="${DIAGRAM_PATH}";document.head.append(s)})()`;

/** CSP hash source of `DIAGRAM_LOADER`; a test recomputes it. */
export const DIAGRAM_LOADER_HASH = "'sha256-nXqx4yWxkc7S1adEFuShoIBeby9DSXc8OjoBbHQmeGI='";

export interface PolicyOptions {
  /** Load images from any `https:` origin (the document opted in to remote images). */
  remoteImages?: boolean;
  /** Allow the diagram loader and the images the diagrams are drawn into (`blob:`). */
  diagrams?: boolean;
  /**
   * The artifact origin the policy is sent from, as a header: the diagram script is then allowed
   * only at its exact URLs there, the loader's stable path and the current build's file (after a
   * redirect browsers match the host only, so a stale cached redirect still loads). Without it
   * (the `<meta>` written at commit, which cannot know the origin) the loader's script is trusted
   * through `'strict-dynamic'` instead.
   */
  origin?: string;
  /** The current diagram script build, listed with `origin`. */
  diagramVersion?: string;
  /** Nonce of the review bridge's script tag. */
  nonce?: string;
}

/**
 * Defense in depth if the renderer ever lets markup through: no frames, plugins, forms or base
 * URL changes, and no scripts except the review bridge (by nonce) and, for documents with
 * diagrams, the diagram loader (by hash) and the diagram script it adds. Styles are the inline
 * stylesheet of the document (and the ones Mermaid writes into its drawings), and images load
 * only from the artifact unless remote images are enabled.
 */
export function documentPolicy(options: PolicyOptions = {}): string {
  const { remoteImages = false, diagrams = false, origin, diagramVersion, nonce } = options;
  const scripts: string[] = [];
  if (diagrams) {
    scripts.push(DIAGRAM_LOADER_HASH);
    if (origin === undefined) scripts.push("'strict-dynamic'");
    else {
      scripts.push(`${origin}${DIAGRAM_PATH}`);
      if (diagramVersion !== undefined) scripts.push(`${origin}${diagramFilePath(diagramVersion)}`);
    }
  }
  if (nonce !== undefined) scripts.push(`'nonce-${nonce}'`);
  return [
    "default-src 'none'",
    `img-src 'self'${diagrams ? " blob:" : ""}${remoteImages ? " https:" : ""}`,
    "style-src 'unsafe-inline'",
    ...(scripts.length > 0 ? [`script-src ${scripts.join(" ")}`] : []),
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
