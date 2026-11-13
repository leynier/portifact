// The URL a planned page is served at on its artifact's `.dev` origin (decision 0027, "What the
// person is shown"): link destinations resolve against it, so every plan of one file must use the
// same one or its digest changes. An HTML page is served at its path; a Markdown or text document
// is served as the rendered page at the origin's root.
import type { FileKind } from "@portifact/contracts";

export function planPageUrl(
  kind: FileKind,
  artifactId: string,
  contentDomain: string,
  path: string,
): string {
  const origin = `https://${artifactId}.${contentDomain}`;
  if (kind !== "html") return `${origin}/`;
  return new URL(path.split("/").map(encodeURIComponent).join("/"), `${origin}/`).toString();
}
