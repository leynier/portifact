// URL policy for rendered Markdown. Only http, https and mailto links survive; everything else,
// including javascript:, data: and vbscript:, is dropped (docs/security.md, "Untrusted content").

/** Where a URL points once a browser resolves it against the artifact. */
export type UrlTarget = "local" | "remote";

// A stand-in for the artifact origin. `.invalid` never resolves, so nothing here can reach it.
const BASE = "https://artifact.invalid/";
const BASE_ORIGIN = new URL(BASE).origin;

/**
 * Resolves a URL the way the browser will (WHATWG URL parsing, so tricks such as `//host`,
 * `/\host` or embedded tabs resolve to the host they really reach) and classifies it. Returns
 * undefined when the scheme is not allowed.
 */
export function classifyUrl(url: string): UrlTarget | undefined {
  let resolved: URL;
  try {
    resolved = new URL(url, BASE);
  } catch {
    return undefined;
  }
  if (resolved.protocol === "mailto:") return "remote";
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return undefined;
  return resolved.origin === BASE_ORIGIN ? "local" : "remote";
}
