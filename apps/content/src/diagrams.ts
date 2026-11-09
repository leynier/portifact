// The diagram script (the pinned Mermaid build and Portifact's runner, packages/render) that
// rendered documents with Mermaid blocks load from their own origin. It is the same file on every
// artifact origin and holds no user content, so like the bridge it is served before any artifact
// lookup, without authorization, and charges no owner's traffic ("Diagrams and highlighted code"
// in docs/security.md).
//
// Documents load the stable `DIAGRAM_PATH`, which redirects to the current build's
// content-hashed file. That file never changes, so browsers keep it for a year without asking
// again, and a new build is a new URL. The body is compressed with brotli at build time and sent
// as is; a client without brotli gets the plain script, which Cloudflare's edge compresses with
// gzip as it does any JavaScript a Worker answers.
import { brotliDecompressSync } from "node:zlib";
import { DIAGRAM_VERSION } from "@portifact/render/diagrams-version";
import { DIAGRAM_PATH, diagramFilePath, diagramFileVersion } from "@portifact/render/policy";

export { DIAGRAM_VERSION };

/** Whether `pathname` is the loader's stable path or any build's file. */
export function isDiagramPath(pathname: string): boolean {
  return pathname === DIAGRAM_PATH || diagramFileVersion(pathname) !== undefined;
}

const COMMON_HEADERS = {
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
} as const;

export async function diagramScript(request: Request): Promise<Response> {
  const version = diagramFileVersion(new URL(request.url).pathname);
  if (version !== DIAGRAM_VERSION) {
    // The stable path, or a build that is gone (a browser's cached redirect can outlive a
    // deploy): send it to the current file. The stable path's redirect is cached for an hour, so
    // a page load usually costs no request for it; a stale build's is never cached.
    return new Response(null, {
      status: 302,
      headers: {
        ...COMMON_HEADERS,
        Location: diagramFilePath(DIAGRAM_VERSION),
        "Cache-Control": version === undefined ? "public, max-age=3600" : "no-store",
      },
    });
  }
  const brotli = acceptsBrotli(request.headers.get("Accept-Encoding"));
  const body = brotli ? await brotliBody() : await plainBody();
  const headers = new Headers({
    ...COMMON_HEADERS,
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(body.byteLength),
    Vary: "Accept-Encoding",
  });
  if (brotli) headers.set("Content-Encoding", "br");
  return new Response(request.method === "HEAD" ? null : body, {
    headers,
    // The brotli body is already compressed: the runtime must not compress it again.
    ...(brotli && { encodeBody: "manual" as const }),
  });
}

/** Whether the client accepts brotli (a zero weight refuses it). */
export function acceptsBrotli(acceptEncoding: string | null): boolean {
  for (const part of (acceptEncoding ?? "").split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    if (name.trim() !== "br") continue;
    const weight = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return weight === undefined || Number(weight.slice(2)) > 0;
  }
  return false;
}

let brotliBytes: Uint8Array | undefined;
let plainBytes: Uint8Array | undefined;

/** The build's brotli body, imported and decoded on first use in an isolate. */
async function brotliBody(): Promise<Uint8Array> {
  if (!brotliBytes) {
    const { DIAGRAM_BROTLI } = await import("@portifact/render/diagrams-bundle");
    brotliBytes = fromBase64(DIAGRAM_BROTLI);
  }
  return brotliBytes;
}

/** The plain script, decompressed once per isolate, only for clients without brotli. */
async function plainBody(): Promise<Uint8Array> {
  plainBytes ??= new Uint8Array(brotliDecompressSync(await brotliBody()));
  return plainBytes;
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
