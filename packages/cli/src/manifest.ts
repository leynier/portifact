// Builds the manifest of a local file or folder (plan section 9, "Preparación"): which files to
// publish, their normalized paths, sizes, SHA-256 and content types. Links and special files are
// refused, and version control data, dependencies, caches and secret files are left out.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { type ArtifactType, LIMITS } from "@portifact/contracts";
import { validateManifestPaths } from "@portifact/domain";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";

export interface LocalFile {
  /** Normalized path inside the artifact. */
  path: string;
  /** Where the bytes are on this machine. */
  source: string;
  size: number;
  sha256: string;
  contentType: string;
}

export type ExclusionReason = "default" | "secret";

export interface LocalManifest {
  type: ArtifactType;
  entrypoint: string;
  files: LocalFile[];
  /** Entries left out, relative to the folder; a folder is listed once, not its contents. */
  excluded: { path: string; reason: ExclusionReason }[];
  totalBytes: number;
}

export interface ManifestOptions {
  type?: ArtifactType | undefined;
  entry?: string | undefined;
}

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

export function exclusionOf(name: string): ExclusionReason | undefined {
  const lower = name.toLowerCase();
  if (DEFAULT_EXCLUDED.has(lower)) return "default";
  if (SECRET_NAMES.has(lower) || SECRET_EXTENSIONS.has(extname(lower))) return "secret";
  if (lower.endsWith(".tfstate.backup")) return "secret";
  for (const prefix of [".env.", ".dev.vars."]) {
    if (lower.startsWith(prefix) && !ENV_TEMPLATES.has(lower.slice(prefix.length))) {
      return "secret";
    }
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
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
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
  return isFolder ? "site" : TYPE_BY_EXTENSION[extname(path).toLowerCase()];
}

/** The site page served at the root of the artifact. */
export const DEFAULT_ENTRY = "index.html";

export async function buildManifest(
  input: string,
  options: ManifestOptions,
): Promise<LocalManifest> {
  const root = resolve(input);
  const info = await lstatOrFail(root, input);
  if (info.isSymbolicLink()) throw new CliError("invalid_input", messages.errors.symlink(input));
  if (!info.isFile() && !info.isDirectory()) {
    throw new CliError("invalid_input", messages.errors.specialFile(input));
  }
  const isFolder = info.isDirectory();
  const type = options.type ?? inferType(root, isFolder);
  if (!type) throw new CliError("invalid_input", messages.errors.unknownType(input));
  if (isFolder && type !== "site") {
    throw new CliError("invalid_input", messages.errors.folderNeedsSite(type));
  }

  // Naming an excluded entry directly does not bypass the exclusions.
  const reason = exclusionOf(basename(root));
  if (reason) throw new CliError("invalid_input", messages.errors.excludedFile(input, reason));

  const excluded: LocalManifest["excluded"] = [];
  let found: { path: string; source: string }[];
  if (isFolder) {
    found = [];
    await walk(root, "", found, excluded);
    if (found.length === 0) throw new CliError("invalid_input", messages.errors.emptyFolder(input));
  } else {
    // A single page is served at the root of the artifact, so it is stored as the entry page.
    const path = type === "site" ? (options.entry ?? DEFAULT_ENTRY) : basename(root);
    found = [{ path, source: root }];
  }

  const paths = validateManifestPaths(found.map((file) => file.path));
  if (!paths.ok) throw new CliError(paths.code, paths.message);
  // A single file is its own entry; a folder's entry must be one of its files.
  const entry = validateManifestPaths([
    isFolder ? (options.entry ?? DEFAULT_ENTRY) : (found[0]?.path ?? ""),
  ]);
  if (!entry.ok) throw new CliError("invalid_input", entry.message);
  const entryPath = entry.value[0] as string;
  if (!paths.value.includes(entryPath)) {
    throw new CliError("invalid_input", messages.errors.missingEntry(entryPath));
  }

  // Sizes first, so an artifact over the limit fails before hours of hashing.
  let statedBytes = 0;
  for (const file of found) statedBytes += (await lstatOrFail(file.source, file.path)).size;
  if (statedBytes > LIMITS.artifactBytes) {
    throw new CliError("quota_exceeded", messages.errors.tooLarge(LIMITS.artifactBytes));
  }

  const files: LocalFile[] = [];
  let totalBytes = 0;
  for (const [index, file] of found.entries()) {
    const path = paths.value[index] as string;
    const { sha256, size } = await hashFile(file.source);
    totalBytes += size;
    files.push({
      path,
      source: file.source,
      size,
      sha256,
      contentType: contentTypeFor(type, path),
    });
  }
  return { type, entrypoint: entryPath, files, excluded, totalBytes };
}

function contentTypeFor(type: ArtifactType, path: string): string {
  if (type === "markdown") return "text/markdown; charset=utf-8";
  if (type === "text") return "text/plain; charset=utf-8";
  return contentTypeOf(path);
}

async function walk(
  directory: string,
  prefix: string,
  found: { path: string; source: string }[],
  excluded: LocalManifest["excluded"],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  // Sorted by code point, so the same folder always gives the same manifest.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const reason = exclusionOf(entry.name);
    if (reason) {
      excluded.push({ path, reason });
      continue;
    }
    const source = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new CliError("invalid_input", messages.errors.symlink(path));
    if (entry.isDirectory()) {
      await walk(source, path, found, excluded);
    } else if (entry.isFile()) {
      found.push({ path, source });
      if (found.length > LIMITS.filesPerVersion) {
        throw new CliError("quota_exceeded", messages.errors.tooManyFiles(LIMITS.filesPerVersion));
      }
    } else {
      throw new CliError("invalid_input", messages.errors.specialFile(path));
    }
  }
}

/** Hashes a file while reading it, so its bytes are never all in memory. */
export function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    let size = 0;
    createReadStream(path)
      .on("data", (chunk) => {
        size += chunk.length;
        hash.update(chunk);
      })
      .on("error", () => reject(new CliError("invalid_input", messages.errors.unreadable(path))))
      .on("end", () => resolvePromise({ sha256: hash.digest("hex"), size }));
  });
}

async function lstatOrFail(path: string, shown: string) {
  try {
    return await lstat(path);
  } catch {
    throw new CliError("invalid_input", messages.errors.notFoundPath(shown));
  }
}
