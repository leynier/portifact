// Builds the manifest of a local file, folder or ZIP file (plan section 9, "Preparación"): which
// files to publish, their normalized paths, sizes, SHA-256 and content types. Links and special
// files are refused, and version control data, dependencies, caches and secret files are left out.
// A Markdown document may bring a folder of assets (plan section 6, `--assets`).
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ArtifactType, LIMITS, PLANS } from "@portifact/contracts";
import {
  contentTypeOf,
  DEFAULT_ENTRY,
  type ExclusionReason as DomainExclusionReason,
  exclusionOf,
  inferType,
  validateManifestPaths,
} from "@portifact/domain";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import { extractZip, isZipPath, removeExtracted } from "./zip.ts";

export interface LocalFile {
  /** Normalized path inside the artifact. */
  path: string;
  /** Where the bytes are on this machine. */
  source: string;
  size: number;
  sha256: string;
  contentType: string;
}

export { contentTypeOf, DEFAULT_ENTRY, exclusionOf, inferType } from "@portifact/domain";

/** Why a file was left out: the shared rules, or a git submodule (CLI only). */
export type ExclusionReason = DomainExclusionReason | "submodule";

export interface Excluded {
  path: string;
  reason: ExclusionReason;
}

export interface LocalManifest {
  type: ArtifactType;
  entrypoint: string;
  files: LocalFile[];
  /** Entries left out, relative to the folder; a folder is listed once, not its contents. */
  excluded: Excluded[];
  totalBytes: number;
  /** Temporary folder of an expanded ZIP; `discardManifest` removes it. */
  temporary?: string | undefined;
}

export interface ManifestOptions {
  type?: ArtifactType | undefined;
  entry?: string | undefined;
  /** Folder of assets a Markdown document links to, published next to it. */
  assets?: string | undefined;
  /**
   * The largest version the owner's plan allows (`plan.limits.artifactBytes` of the usage
   * endpoint); the free plan's when not given. The API checks the plan again.
   */
  maxBytes?: number | undefined;
}

/** A file found for a manifest; ZIP entries arrive already hashed. */
export interface Candidate {
  path: string;
  source: string;
  size?: number;
  sha256?: string;
}

export async function buildManifest(
  input: string,
  options: ManifestOptions,
): Promise<LocalManifest> {
  const root = resolve(input);
  const maxBytes = options.maxBytes ?? PLANS.free.limits.artifactBytes;
  const info = await lstatOrFail(root, input);
  if (info.isSymbolicLink()) throw new CliError("invalid_input", messages.errors.symlink(input));
  if (!info.isFile() && !info.isDirectory()) {
    throw new CliError("invalid_input", messages.errors.specialFile(input));
  }
  const isFolder = info.isDirectory();
  const isZip = !isFolder && isZipPath(root);
  const type = options.type ?? (isZip ? "site" : inferType(root, isFolder));
  if (!type) throw new CliError("invalid_input", messages.errors.unknownType(input));
  if (isFolder && type !== "site") {
    throw new CliError("invalid_input", messages.errors.folderNeedsSite(type));
  }
  if (isZip && type !== "site")
    throw new CliError("invalid_input", messages.errors.zipNeedsSite(type));
  if (options.assets !== undefined && type !== "markdown") {
    throw new CliError("invalid_input", messages.errors.assetsNeedMarkdown);
  }

  // Naming an excluded entry directly does not bypass the exclusions.
  const reason = exclusionOf(basename(root));
  if (reason) throw new CliError("invalid_input", messages.errors.excludedFile(input, reason));

  const excluded: Excluded[] = [];
  let found: Candidate[];
  let temporary: string | undefined;
  if (isZip) {
    const zip = await extractZip(root, input, {
      maxBytes,
      exclude: (path) => excludedPrefix(path, "all"),
    });
    temporary = zip.directory;
    found = stripSharedFolder(zip.files);
    excluded.push(...(zip.excluded as Excluded[]));
    if (found.length === 0) {
      await removeExtracted(temporary);
      throw new CliError("invalid_input", messages.errors.emptyFolder(input));
    }
  } else if (isFolder) {
    found = [];
    await walk(root, "", found, excluded);
    if (found.length === 0) throw new CliError("invalid_input", messages.errors.emptyFolder(input));
  } else {
    // A single page is served at the root of the artifact, so it is stored as the entry page.
    const path = type === "site" ? (options.entry ?? DEFAULT_ENTRY) : basename(root);
    found = [{ path, source: root }];
    if (options.assets !== undefined) {
      found.push(...(await assetFiles(root, options.assets, excluded)));
    }
  }

  try {
    // A single file is its own entry; a folder's entry must be one of its files.
    const entry = validateManifestPaths([
      isFolder || isZip ? (options.entry ?? DEFAULT_ENTRY) : (found[0]?.path ?? ""),
    ]);
    if (!entry.ok) throw new CliError("invalid_input", entry.message);
    const entryPath = entry.value[0] as string;
    const hashed = await hashCandidates(found, maxBytes, (path) =>
      contentTypeFor(type, path, entryPath),
    );
    if (!hashed.files.some((file) => file.path === entryPath)) {
      throw new CliError("invalid_input", messages.errors.missingEntry(entryPath));
    }
    return { type, entrypoint: entryPath, ...hashed, excluded, temporary };
  } catch (error) {
    if (temporary) await removeExtracted(temporary);
    throw error;
  }
}

/** Removes the temporary files a manifest was built from, if any. */
export async function discardManifest(manifest: { temporary?: string | undefined }): Promise<void> {
  if (manifest.temporary) await removeExtracted(manifest.temporary);
}

/**
 * Validates the paths of the candidates, checks the size limit before hashing, then hashes what
 * is not hashed yet. Returns the files with their normalized paths.
 */
export async function hashCandidates(
  found: readonly Candidate[],
  maxBytes: number,
  contentType: (path: string) => string,
): Promise<{ files: LocalFile[]; totalBytes: number }> {
  const paths = validateManifestPaths(found.map((file) => file.path));
  if (!paths.ok) throw new CliError(paths.code, paths.message);

  // Sizes first, so an artifact over the limit fails before hours of hashing.
  let statedBytes = 0;
  for (const file of found) {
    statedBytes += file.size ?? (await lstatOrFail(file.source, file.path)).size;
  }
  if (statedBytes > maxBytes) {
    throw new CliError("quota_exceeded", messages.errors.tooLarge(maxBytes));
  }

  const files: LocalFile[] = [];
  let totalBytes = 0;
  for (const [index, file] of found.entries()) {
    const path = paths.value[index] as string;
    const { sha256, size } =
      file.sha256 !== undefined && file.size !== undefined
        ? { sha256: file.sha256, size: file.size }
        : await hashFile(file.source);
    totalBytes += size;
    // Sizes again after hashing: a file may have grown since it was listed.
    if (size > LIMITS.fileBytesCap || totalBytes > maxBytes) {
      throw new CliError(
        "quota_exceeded",
        messages.errors.tooLarge(Math.min(maxBytes, LIMITS.fileBytesCap)),
      );
    }
    files.push({ path, source: file.source, size, sha256, contentType: contentType(path) });
  }
  return { files, totalBytes };
}

/**
 * The excluded entry a path falls under: its first segment that is excluded, as a path. `secret`
 * applies only the secret filter, for files git chose.
 */
export function excludedPrefix(
  path: string,
  which: "all" | "secret",
): { path: string; reason: ExclusionReason } | undefined {
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    const reason = exclusionOf(segments[i] as string);
    if (reason && (which === "all" || reason === "secret")) {
      return { path: segments.slice(0, i + 1).join("/"), reason };
    }
  }
  return undefined;
}

/**
 * Drops a folder every file shares, as ZIP tools add when compressing a folder, so
 * `site.zip` with `site/index.html` publishes `index.html`.
 */
export function stripSharedFolder<T extends { path: string }>(files: readonly T[]): T[] {
  const first = files[0]?.path.split("/")[0];
  if (first === undefined || !files.every((file) => file.path.startsWith(`${first}/`))) {
    return [...files];
  }
  return files.map((file) => ({ ...file, path: file.path.slice(first.length + 1) }));
}

/**
 * The files of a Markdown document's assets folder, at their path relative to the document's
 * folder, so the links in the document resolve to them. The folder must be inside the document's.
 */
async function assetFiles(
  document: string,
  assets: string,
  excluded: Excluded[],
): Promise<Candidate[]> {
  const folder = resolve(assets);
  const info = await lstatOrFail(folder, assets);
  if (info.isSymbolicLink()) throw new CliError("invalid_input", messages.errors.symlink(assets));
  if (!info.isDirectory())
    throw new CliError("invalid_input", messages.errors.assetsNotFolder(assets));
  const offset = relative(dirname(document), folder);
  if (offset.startsWith("..") || isAbsolute(offset)) {
    throw new CliError("invalid_input", messages.errors.assetsOutside(assets));
  }
  const prefix = offset.split(sep).join("/");
  const found: Candidate[] = [];
  const left: Excluded[] = [];
  await walk(folder, prefix, found, left);
  excluded.push(...left);
  // With the document's own folder as assets, the document is already in the manifest.
  return found.filter((file) => resolve(file.source) !== document);
}

function contentTypeFor(type: ArtifactType, path: string, entrypoint: string): string {
  // A document's assets keep their own types; the document itself is Markdown or text.
  if (path !== entrypoint) return contentTypeOf(path);
  if (type === "markdown") return "text/markdown; charset=utf-8";
  if (type === "text") return "text/plain; charset=utf-8";
  return contentTypeOf(path);
}

export async function walk(
  directory: string,
  prefix: string,
  found: Candidate[],
  excluded: Excluded[],
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

export async function lstatOrFail(path: string, shown: string) {
  try {
    return await lstat(path);
  } catch {
    throw new CliError("invalid_input", messages.errors.notFoundPath(shown));
  }
}
