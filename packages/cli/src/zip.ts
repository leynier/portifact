// Expands a ZIP file for publishing (plan section 9, "Preparación"). The reader is minimal on
// purpose: it trusts nothing in the archive. It reads the central directory, refuses links,
// special files, unsafe or colliding paths, encryption, overlapping entries and anything over the
// limits before writing a byte, then inflates each file as a stream, never past its declared size,
// and checks its CRC-32 while hashing it. Files land in a private temporary folder under numbered
// names, so no name from the archive ever becomes a path on disk.
//
// Why not a dependency: streaming readers that follow local headers (fflate's Unzip) cannot see
// the central directory, where Unix modes mark symbolic links, and the whole-archive readers keep
// everything in memory. node:zlib inflates; this module only parses the directory.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { normalizePath } from "@portifact/domain";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";

export const ZIP_LIMITS = {
  /** Central directory entries, folders and left-out files included. */
  entries: 10_000,
  /** Expanded bytes per compressed byte, checked on entries above `ratioFloorBytes`. */
  ratio: 200,
  ratioFloorBytes: 1_000_000,
  /** Bytes of the central directory itself. */
  directoryBytes: 16_000_000,
} as const;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const END_MIN = 22;
const MAX_COMMENT = 0xffff;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const DOS_DIRECTORY = 0x10;
const WINDOWS_REPARSE_POINT = 0x400;
/** Hosts whose external attributes carry a Unix mode in the high 16 bits (Unix, macOS). */
const UNIX_HOSTS = new Set([3, 19]);

export interface ZipEntry {
  /** Normalized path inside the archive. */
  path: string;
  directory: boolean;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
  /** Where the compressed bytes start, from the local header. */
  dataOffset: number;
}

export interface ExtractedFile {
  path: string;
  /** The expanded bytes on this machine. */
  source: string;
  size: number;
  sha256: string;
}

export interface ExtractOptions {
  /** The largest the expanded files may add up to. */
  maxBytes: number;
  /** Whether to leave a path out; the reason is reported, and its bytes are never written. */
  exclude: (path: string) => { path: string; reason: string } | undefined;
}

export interface ExtractedZip {
  files: ExtractedFile[];
  excluded: { path: string; reason: string }[];
  /** Temporary folder holding the files; remove it with `removeExtracted` when done. */
  directory: string;
}

/** Whether a path names a ZIP file by its extension. */
export function isZipPath(path: string): boolean {
  return path.toLowerCase().endsWith(".zip");
}

/** Reads and checks the whole directory of a ZIP file, without expanding anything. */
export async function readZip(zipPath: string, shown: string): Promise<ZipEntry[]> {
  const refuse = (detail: string): never => {
    throw new CliError("invalid_input", messages.errors.zipRefused(shown, detail));
  };
  let handle: FileHandle;
  try {
    handle = await open(zipPath, "r");
  } catch {
    throw new CliError("invalid_input", messages.errors.notFoundPath(shown));
  }
  try {
    const { size: fileSize } = await handle.stat();
    const end = await findEnd(handle, fileSize, refuse);
    if (end.entries > ZIP_LIMITS.entries) {
      throw new CliError(
        "quota_exceeded",
        messages.errors.zipTooManyEntries(shown, ZIP_LIMITS.entries),
      );
    }
    if (end.directorySize > ZIP_LIMITS.directoryBytes) refuse("its directory is too large");
    if (end.directoryOffset + end.directorySize > end.position) {
      refuse("its directory points outside the file");
    }
    const directory = await readAt(handle, end.directoryOffset, end.directorySize, refuse);
    const entries = parseDirectory(directory, end.entries, refuse);
    await locateData(handle, entries, end.directoryOffset, refuse);
    checkCollisions(entries, refuse);
    return entries.map(({ name: _name, ...entry }) => entry);
  } finally {
    await handle.close();
  }
}

/**
 * Expands the files of a ZIP into a new private temporary folder, after `readZip` accepted its
 * directory. Throws, and removes the folder, on anything over the limits or that does not match
 * the directory.
 */
export async function extractZip(
  zipPath: string,
  shown: string,
  options: ExtractOptions,
): Promise<ExtractedZip> {
  const entries = await readZip(zipPath, shown);
  const excluded = new Map<string, string>();
  const included: ZipEntry[] = [];
  let declared = 0;
  for (const entry of entries) {
    if (entry.directory) continue;
    const exclusion = options.exclude(entry.path);
    if (exclusion) {
      excluded.set(exclusion.path, exclusion.reason);
      continue;
    }
    if (
      entry.size > ZIP_LIMITS.ratioFloorBytes &&
      entry.size / Math.max(entry.compressedSize, 1) > ZIP_LIMITS.ratio
    ) {
      throw new CliError(
        "invalid_input",
        messages.errors.zipRefused(
          shown,
          `${entry.path} expands more than ${ZIP_LIMITS.ratio} times`,
        ),
      );
    }
    declared += entry.size;
    if (declared > options.maxBytes) {
      throw new CliError("quota_exceeded", messages.errors.tooLarge(options.maxBytes));
    }
    included.push(entry);
  }

  const directory = await mkdtemp(join(tmpdir(), "portifact-zip-"));
  try {
    const files: ExtractedFile[] = [];
    for (const [index, entry] of included.entries()) {
      const source = join(directory, String(index));
      const { sha256 } = await inflateEntry(zipPath, shown, entry, source);
      files.push({ path: entry.path, source, size: entry.size, sha256 });
    }
    return {
      files,
      excluded: [...excluded].map(([path, reason]) => ({ path, reason })),
      directory,
    };
  } catch (error) {
    await removeExtracted(directory);
    throw error;
  }
}

export async function removeExtracted(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

interface EndRecord {
  /** Offset of the end of central directory record. */
  position: number;
  entries: number;
  directorySize: number;
  directoryOffset: number;
}

async function findEnd(
  handle: FileHandle,
  fileSize: number,
  refuse: (detail: string) => never,
): Promise<EndRecord> {
  if (fileSize < END_MIN) refuse("it is not a ZIP file");
  const tailLength = Math.min(fileSize, END_MIN + MAX_COMMENT);
  const tailStart = fileSize - tailLength;
  const tail = await readAt(handle, tailStart, tailLength, refuse);
  let at = -1;
  for (let i = tail.length - END_MIN; i >= 0; i--) {
    if (
      tail.readUInt32LE(i) === SIG_END &&
      i + END_MIN + tail.readUInt16LE(i + 20) === tail.length
    ) {
      at = i;
      break;
    }
  }
  if (at < 0) refuse("it is not a ZIP file");
  const position = tailStart + at;
  const disk = tail.readUInt16LE(at + 4);
  const directoryDisk = tail.readUInt16LE(at + 6);
  const onDisk = tail.readUInt16LE(at + 8);
  let entries = tail.readUInt16LE(at + 10);
  let directorySize = tail.readUInt32LE(at + 12);
  let directoryOffset = tail.readUInt32LE(at + 16);
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== entries) refuse("it spans several disks");

  if (entries === MAX16 || directorySize === MAX32 || directoryOffset === MAX32) {
    if (position < 20) refuse("its ZIP64 records are missing");
    const locator = await readAt(handle, position - 20, 20, refuse);
    if (locator.readUInt32LE(0) !== SIG_LOCATOR64) refuse("its ZIP64 records are missing");
    const end64Offset = safeNumber(locator.readBigUInt64LE(8), refuse);
    if (end64Offset + 56 > position - 20) refuse("its ZIP64 records are invalid");
    const end64 = await readAt(handle, end64Offset, 56, refuse);
    if (end64.readUInt32LE(0) !== SIG_END64) refuse("its ZIP64 records are invalid");
    entries = safeNumber(end64.readBigUInt64LE(32), refuse);
    directorySize = safeNumber(end64.readBigUInt64LE(40), refuse);
    directoryOffset = safeNumber(end64.readBigUInt64LE(48), refuse);
    return { position: end64Offset, entries, directorySize, directoryOffset };
  }
  return { position, entries, directorySize, directoryOffset };
}

type ParsedEntry = ZipEntry & { name: Buffer };

function parseDirectory(
  directory: Buffer,
  count: number,
  refuse: (detail: string) => never,
): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== SIG_CENTRAL) {
      refuse("its directory is damaged");
    }
    const madeBy = directory.readUInt16LE(at + 4);
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const crc32 = directory.readUInt32LE(at + 16);
    let compressedSize = directory.readUInt32LE(at + 20);
    let size = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const external = directory.readUInt32LE(at + 38);
    let offset = directory.readUInt32LE(at + 42);
    const nameStart = at + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > directory.length) refuse("its directory is damaged");
    const name = directory.subarray(nameStart, extraStart);

    let raw: string;
    try {
      raw = decoder.decode(name);
    } catch {
      refuse(
        `an entry name is not UTF-8${flags & FLAG_UTF8 ? "" : " (rename the files or zip them again)"}`,
      );
    }
    const shown = JSON.stringify(raw);
    if (flags & FLAG_ENCRYPTED) refuse(`${shown} is encrypted`);

    // ZIP64 sizes and offset, in this order, for the fields saturated in the record.
    if (size === MAX32 || compressedSize === MAX32 || offset === MAX32) {
      const extra = zip64Extra(directory.subarray(extraStart, extraStart + extraLength));
      if (!extra) refuse(`${shown} has invalid ZIP64 sizes`);
      let field = 0;
      const take = () => {
        if (field + 8 > extra.length) refuse(`${shown} has invalid ZIP64 sizes`);
        const value = safeNumber(extra.readBigUInt64LE(field), refuse);
        field += 8;
        return value;
      };
      if (size === MAX32) size = take();
      if (compressedSize === MAX32) compressedSize = take();
      if (offset === MAX32) offset = take();
    }

    const directoryName = raw.endsWith("/");
    const host = madeBy >> 8;
    const mode = UNIX_HOSTS.has(host) ? external >>> 16 : 0;
    const type = mode & S_IFMT;
    if (type === S_IFLNK || external & WINDOWS_REPARSE_POINT) {
      refuse(`${shown} is a symbolic link`);
    }
    if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) refuse(`${shown} is a special file`);
    const directoryEntry = directoryName || type === S_IFDIR || (external & DOS_DIRECTORY) !== 0;
    if (directoryEntry && size !== 0) refuse(`${shown} is a folder with content`);
    if (!directoryEntry && method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      refuse(`${shown} uses a compression method Portifact does not read`);
    }
    if (!directoryEntry && method === METHOD_STORED && compressedSize !== size) {
      refuse(`${shown} has inconsistent sizes`);
    }

    const normalized = normalizePath(directoryName ? raw.slice(0, -1) : raw);
    if (!normalized.ok) refuse(`${shown} has an unsafe path (${normalized.message})`);
    entries.push({
      path: normalized.value,
      directory: directoryEntry,
      method,
      crc32,
      compressedSize,
      size,
      offset,
      dataOffset: 0,
      name,
    });
    at = next;
  }
  return entries;
}

function zip64Extra(extra: Buffer): Buffer | undefined {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (at + 4 + length > extra.length) return undefined;
    if (id === 0x0001) return extra.subarray(at + 4, at + 4 + length);
    at += 4 + length;
  }
  return undefined;
}

/**
 * Reads every local header: it must name the same file with the same method, and the compressed
 * bytes of each entry must end before the next one starts, so no two entries share bytes (the
 * overlapping-entry bomb) and none reaches into the directory.
 */
async function locateData(
  handle: FileHandle,
  entries: ParsedEntry[],
  directoryOffset: number,
  refuse: (detail: string) => never,
): Promise<void> {
  const sorted = [...entries].sort((a, b) => a.offset - b.offset);
  let previousEnd = 0;
  for (const entry of sorted) {
    const shown = JSON.stringify(entry.path);
    if (entry.offset < previousEnd || entry.offset + 30 > directoryOffset) {
      refuse(`${shown} overlaps another entry`);
    }
    const header = await readAt(handle, entry.offset, 30, refuse);
    if (header.readUInt32LE(0) !== SIG_LOCAL) refuse(`${shown} has no local header`);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    if (header.readUInt16LE(8) !== entry.method)
      refuse(`${shown} does not match its directory entry`);
    const name = await readAt(handle, entry.offset + 30, nameLength, refuse);
    if (!name.equals(entry.name)) refuse(`${shown} does not match its directory entry`);
    entry.dataOffset = entry.offset + 30 + nameLength + extraLength;
    previousEnd = entry.dataOffset + entry.compressedSize;
    if (previousEnd > directoryOffset) refuse(`${shown} overlaps the directory`);
  }
}

/** Duplicates, names that differ only by case, and a file used as a folder all collide. */
function checkCollisions(entries: ParsedEntry[], refuse: (detail: string) => never): void {
  const files = new Set<string>();
  const folders = new Set<string>();
  for (const entry of entries) {
    const key = entry.path.toLowerCase();
    if (entry.directory) {
      folders.add(key);
      continue;
    }
    if (files.has(key)) refuse(`${JSON.stringify(entry.path)} appears more than once`);
    files.add(key);
  }
  for (const key of files) {
    if (folders.has(key)) refuse(`${JSON.stringify(key)} is both a file and a folder`);
    const segments = key.split("/");
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join("/");
      if (files.has(parent)) refuse(`${JSON.stringify(parent)} is both a file and a folder`);
    }
  }
}

async function inflateEntry(
  zipPath: string,
  shown: string,
  entry: ZipEntry,
  target: string,
): Promise<{ sha256: string }> {
  const hash = createHash("sha256");
  let crc = 0;
  let written = 0;
  const tooLong = () =>
    new CliError(
      "invalid_input",
      messages.errors.zipRefused(shown, `${entry.path} expands past its declared size`),
    );
  const check = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > entry.size) {
        callback(tooLong());
        return;
      }
      hash.update(chunk);
      crc = crc32(chunk, crc);
      callback(null, chunk);
    },
  });
  const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
  const input =
    entry.compressedSize === 0
      ? Readable.from([])
      : createReadStream(zipPath, {
          start: entry.dataOffset,
          end: entry.dataOffset + entry.compressedSize - 1,
        });
  try {
    if (entry.method === METHOD_DEFLATE) {
      await pipeline(input, createInflateRaw(), check, output);
    } else {
      await pipeline(input, check, output);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "invalid_input",
      messages.errors.zipRefused(shown, `${entry.path} is damaged`),
    );
  }
  if (written !== entry.size || crc !== entry.crc32) {
    throw new CliError(
      "invalid_input",
      messages.errors.zipRefused(shown, `${entry.path} is damaged`),
    );
  }
  return { sha256: hash.digest("hex") };
}

async function readAt(
  handle: FileHandle,
  position: number,
  length: number,
  refuse: (detail: string) => never,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) refuse("it ends early");
    read += bytesRead;
  }
  return buffer;
}

function safeNumber(value: bigint, refuse: (detail: string) => never): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) refuse("it declares impossible sizes");
  return Number(value);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
