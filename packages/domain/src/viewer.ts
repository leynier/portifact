// The viewer with the Portifact bar (plan section 8, "Flujo", decision of 2026-11-08): a top-level
// visit to a page of `<id>.portifact.dev` opens `app.portifact.com/view/<id>?path=<path>`, which
// frames that page. The content Worker builds the `path` and the viewer reads it back from its
// own address, where anyone can write it, so both sides apply these rules.

/** Longest `path` (path and query) a viewer link carries; longer ones open the artifact's root. */
export const VIEWER_PATH_MAX = 2048;

/** Longest fragment the viewer passes on to the frame. */
export const VIEWER_HASH_MAX = 1024;

/** Stands in for the artifact origin while a path is parsed; never contacted. */
const BASE = "https://artifact.invalid";

/**
 * The page of the artifact a viewer link opens, as a path and query on the artifact origin
 * (`/docs/a.html?x=1`), or null when `raw` is not one. Parsing it as the browser would, against
 * a stand-in origin, catches `//host`, `/\host`, tabs and newlines, which all leave the origin
 * or change the path. Paths under the reserved `/__portifact/` are refused, so a link cannot
 * point the frame at a sign-in callback or a review exchange.
 */
export function viewerPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.length > VIEWER_PATH_MAX) {
    return null;
  }
  if (raw.includes("\\") || hasControl(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const firstSegment = url.pathname.split("/")[1] ?? "";
  if (decodeSafely(firstSegment).toLowerCase() === "__portifact") return null;
  const path = `${url.pathname}${url.search}`;
  return path.length > VIEWER_PATH_MAX ? null : path;
}

/** The fragment the viewer passes on to the frame (`#section`), or an empty string. */
export function viewerHash(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !raw.startsWith("#") || raw.length < 2) return "";
  if (raw.length > VIEWER_HASH_MAX || hasControl(raw)) return "";
  return raw;
}

/** Whether `value` holds a C0 control character or DEL, which URLs never carry as is. */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
