// Builds the manifest of what the browser publishes (plan sections 6 and 9): the files picked
// one by one, a folder, a ZIP or pasted text become normalized paths with sizes, SHA-256 and
// content types. The same exclusions and path rules as the CLI apply (@portifact/domain), and
// the API validates everything again. It runs in a Web Worker (./worker.ts), hashing and
// expanding incrementally so the page stays responsive and large files never sit whole in a
// single buffer.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type ArtifactType, LIMITS } from "@portifact/contracts";
import {
  contentTypeFor,
  DEFAULT_ENTRY,
  type ExclusionReason,
  excludedPrefix,
  validateManifestPaths,
} from "@portifact/domain";
import { expandZipEntry, readZipEntries, ZipError, type ZipErrorReason } from "./zip.ts";

export type ManifestSource =
  /** Files picked one by one, or a folder (paths start with the folder's own name). */
  | { kind: "files"; files: readonly { path: string; blob: Blob }[]; folder: boolean }
  | { kind: "zip"; blob: Blob }
  /** A document typed or pasted in the page, with the file name it is published under. */
  | { kind: "text"; text: string; fileName: string };

export interface ManifestOptions {
  type: ArtifactType;
  /** The page a site opens at; `index.html` by default. */
  entry?: string | undefined;
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  blob: Blob;
}

export interface BrowserManifest {
  type: ArtifactType;
  entrypoint: string;
  files: ManifestFile[];
  /** Entries left out; a folder is listed once, not its contents. */
  excluded: { path: string; reason: ExclusionReason }[];
  totalBytes: number;
}

export type ManifestErrorReason =
  | ZipErrorReason
  | "empty"
  | "too_many_files"
  | "too_large"
  | "invalid_path"
  | "missing_entry"
  | "document_files"
  | "document_too_large"
  | "not_text";

export class ManifestError extends Error {
  constructor(
    readonly reason: ManifestErrorReason,
    /** The path, limit or rule the problem is about, shown to the user as data. */
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "ManifestError";
  }
}

export interface ManifestProgress {
  /** Bytes read and hashed so far, and in total. */
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
}

interface Candidate {
  path: string;
  size: number;
  /** The bytes, when they are already a file; expanded ZIP entries are collected instead. */
  blob?: Blob;
  /** Reads the bytes in order, chunk by chunk. */
  read(onChunk: (chunk: Uint8Array) => void): Promise<void>;
}

async function readBlob(blob: Blob, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function blobCandidate(path: string, blob: Blob): Candidate {
  return { path, size: blob.size, blob, read: (onChunk) => readBlob(blob, onChunk) };
}

/** Drops the first segment shared by every path, such as the picked folder's own name. */
function stripCommonFolder(paths: readonly string[]): (path: string) => string {
  const first = paths[0]?.split("/")[0];
  const shared =
    first !== undefined &&
    paths.every((path) => path.includes("/") && path.split("/")[0] === first);
  return shared ? (path) => path.slice((first as string).length + 1) : (path) => path;
}

async function candidatesOf(
  source: ManifestSource,
  options: ManifestOptions,
): Promise<Candidate[]> {
  if (source.kind === "text") {
    const blob = new Blob([source.text], { type: "text/plain" });
    return [blobCandidate(source.fileName, blob)];
  }
  if (source.kind === "files") {
    const strip = source.folder
      ? stripCommonFolder(source.files.map((file) => file.path))
      : (path: string) => path;
    // A single page of a site is served at the root, so it is stored as the entry page.
    if (!source.folder && source.files.length === 1 && options.type === "site") {
      const only = source.files[0] as { path: string; blob: Blob };
      return [blobCandidate(options.entry ?? DEFAULT_ENTRY, only.blob)];
    }
    return source.files.map((file) => blobCandidate(strip(file.path), file.blob));
  }
  let entries: Awaited<ReturnType<typeof readZipEntries>>;
  try {
    entries = await readZipEntries(source.blob);
  } catch (error) {
    throw asManifestError(error);
  }
  // A ZIP of a folder holds the folder itself; publish its contents, like a picked folder.
  const strip = stripCommonFolder(entries.map((entry) => entry.name));
  return entries.map((entry) => ({
    path: strip(entry.name),
    size: entry.size,
    read: (onChunk) => expandZipEntry(source.blob, entry, onChunk),
  }));
}

function asManifestError(error: unknown): unknown {
  return error instanceof ZipError ? new ManifestError(error.reason, error.entry) : error;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Builds the manifest, refusing what the API would refuse: no files, too many or too large,
 * invalid or colliding paths, a missing entry page and documents that are not a single UTF-8
 * text within the document limit. `onProgress` reports hashing as it goes.
 */
export async function buildManifest(
  source: ManifestSource,
  options: ManifestOptions,
  onProgress: (progress: ManifestProgress) => void = () => {},
): Promise<BrowserManifest> {
  const all = await candidatesOf(source, options);
  const excluded = new Map<string, ExclusionReason>();
  const kept: Candidate[] = [];
  for (const candidate of all) {
    const hit = excludedPrefix(candidate.path);
    if (hit) excluded.set(hit.path, hit.reason);
    else kept.push(candidate);
  }
  const excludedList = [...excluded].map(([path, reason]) => ({ path, reason }));
  if (kept.length === 0) throw new ManifestError("empty");
  if (kept.length > LIMITS.filesPerVersion) {
    throw new ManifestError("too_many_files", String(LIMITS.filesPerVersion));
  }
  // Sizes first, so a source over the limit fails before any hashing or expanding.
  const declared = kept.reduce((sum, candidate) => sum + candidate.size, 0);
  if (declared > LIMITS.artifactBytes) {
    throw new ManifestError("too_large", String(LIMITS.artifactBytes));
  }

  const paths = validateManifestPaths(kept.map((candidate) => candidate.path));
  if (!paths.ok) throw new ManifestError("invalid_path", paths.message);

  const type = options.type;
  let entrypoint: string;
  if (type === "site") {
    const entry = validateManifestPaths([options.entry?.trim() || DEFAULT_ENTRY]);
    if (!entry.ok) throw new ManifestError("invalid_path", entry.message);
    entrypoint = entry.value[0] as string;
    if (!paths.value.includes(entrypoint)) throw new ManifestError("missing_entry", entrypoint);
  } else {
    if (kept.length !== 1) throw new ManifestError("document_files");
    entrypoint = paths.value[0] as string;
    if (declared > LIMITS.documentBytes) {
      throw new ManifestError("document_too_large", String(LIMITS.documentBytes));
    }
  }

  const progress: ManifestProgress = {
    doneBytes: 0,
    totalBytes: declared,
    doneFiles: 0,
    totalFiles: kept.length,
  };
  onProgress({ ...progress });
  const files: ManifestFile[] = [];
  for (const [index, candidate] of kept.entries()) {
    const hash = sha256.create();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      await candidate.read((chunk) => {
        hash.update(chunk);
        if (!candidate.blob) chunks.push(chunk);
        size += chunk.byteLength;
        progress.doneBytes += chunk.byteLength;
        onProgress({ ...progress });
      });
    } catch (error) {
      throw asManifestError(error);
    }
    const path = paths.value[index] as string;
    const blob = candidate.blob ?? new Blob(chunks as BlobPart[]);
    if (type !== "site") checkDocument(blob, await blob.arrayBuffer());
    progress.doneFiles += 1;
    onProgress({ ...progress });
    files.push({
      path,
      size,
      sha256: bytesToHex(hash.digest()),
      contentType: contentTypeFor(type, path),
      blob,
    });
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return { type, entrypoint, files, excluded: excludedList, totalBytes };
}

/** A document must be UTF-8 text without NUL characters, like the commit requires. */
function checkDocument(blob: Blob, bytes: ArrayBuffer): void {
  if (blob.size > LIMITS.documentBytes) {
    throw new ManifestError("document_too_large", String(LIMITS.documentBytes));
  }
  const view = new Uint8Array(bytes);
  if (view.includes(0)) throw new ManifestError("not_text");
  try {
    utf8.decode(view);
  } catch {
    throw new ManifestError("not_text");
  }
}
