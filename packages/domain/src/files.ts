// Client-side rules for building a manifest (plan section 9, "Preparación"), shared by the CLI
// and the dashboard so both leave out the same files and declare the same types: version
// control data, dependencies, caches and files that may hold secrets stay out, and content
// types follow the extension. These are conveniences for the user; the server still validates
// every path, size and type.
import type { ArtifactType } from "@portifact/contracts";

export type ExclusionReason = "default" | "secret";

/** Version control data, dependencies, caches and OS clutter. `.git` is matched in any case. */
const DEFAULT_EXCLUDED = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".parcel-cache",
  ".turbo",
  ".wrangler",
  ".eslintcache",
  ".sass-cache",
  ".ds_store",
  "thumbs.db",
  "__macosx",
]);

/** Names that hold credentials or keys. Matched in any case. */
const SECRET_NAMES = new Set([
  ".env",
  ".dev.vars",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".htpasswd",
  ".ssh",
  ".aws",
  ".gnupg",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const SECRET_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".kdbx",
  ".ppk",
  ".tfstate",
]);
/** Example files that document variables without values. */
const ENV_TEMPLATES = new Set(["example", "sample", "template", "dist"]);

/** The last segment of a path, with either separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** The extension of a path's last segment, lowercased, like `node:path`'s `extname`. */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** Why a file or folder with this name is left out of a manifest, if it is. */
export function exclusionOf(name: string): ExclusionReason | undefined {
  const lower = name.toLowerCase();
  if (DEFAULT_EXCLUDED.has(lower)) return "default";
  if (SECRET_NAMES.has(lower) || SECRET_EXTENSIONS.has(extensionOf(lower))) return "secret";
  if (lower.endsWith(".tfstate.backup")) return "secret";
  for (const prefix of [".env.", ".dev.vars."]) {
    if (lower.startsWith(prefix) && !ENV_TEMPLATES.has(lower.slice(prefix.length))) {
      return "secret";
    }
  }
  return undefined;
}

/**
 * The excluded folder or file a relative path falls under, such as `site/.git` for
 * `site/.git/config`, with the reason; undefined when no segment is excluded.
 */
export function excludedPrefix(
  path: string,
): { path: string; reason: ExclusionReason } | undefined {
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    const reason = exclusionOf(segments[i] ?? "");
    if (reason) return { path: segments.slice(0, i + 1).join("/"), reason };
  }
  return undefined;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extensionOf(path)] ?? "application/octet-stream";
}

/** The content type a file of an artifact is declared with: documents keep their own type. */
export function contentTypeFor(type: ArtifactType, path: string): string {
  if (type === "markdown") return "text/markdown; charset=utf-8";
  if (type === "text") return "text/plain; charset=utf-8";
  return contentTypeOf(path);
}

const TYPE_BY_EXTENSION: Record<string, ArtifactType> = {
  ".html": "site",
  ".htm": "site",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
};

/** The artifact type a path implies: a folder is a site, a file goes by its extension. */
export function inferType(path: string, isFolder: boolean): ArtifactType | undefined {
  return isFolder ? "site" : TYPE_BY_EXTENSION[extensionOf(path)];
}

/** The site page served at the root of the artifact. */
export const DEFAULT_ENTRY = "index.html";
