// Reads ZIP archives in the browser (plan section 6: ZIP is the fallback when a folder cannot be
// picked). The central directory is parsed first, so links, special files, encryption and
// archives that declare more than the limits are refused before anything is expanded. Entries
// are then expanded one at a time from slices of the file, in chunks, and each must produce
// exactly the size and CRC-32 it declared, so a lying archive cannot expand without bound.
import { Inflate } from "fflate";

export type ZipErrorReason =
  | "not_zip"
  | "unsupported"
  | "encrypted"
  | "symlink"
  | "special_file"
  | "corrupt";

export class ZipError extends Error {
  constructor(
    readonly reason: ZipErrorReason,
    /** The entry the problem is in, when there is one. */
    readonly entry?: string,
  ) {
    super(entry ? `${reason}: ${entry}` : reason);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** The name as stored, with `/` separators. */
  name: string;
  /** Size once expanded, as the archive declares it. */
  size: number;
  compressedSize: number;
  method: number;
  crc32: number;
  /** Where the entry's local header starts. */
  offset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;
const UNIX_HOST = 3;
const FILE_TYPE_MASK = 0o170000;
const REGULAR_FILE = 0o100000;
const DIRECTORY = 0o040000;
const SYMLINK = 0o120000;

async function bytesOf(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder("utf-8").decode(bytes);
  // Many tools write UTF-8 without setting the flag; anything else is read as Latin-1.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

/**
 * Lists the files of an archive from its central directory. Folders are skipped; links, special
 * files, encrypted entries, ZIP64 and compression other than stored or deflate are refused.
 */
export async function readZipEntries(blob: Blob): Promise<ZipEntry[]> {
  if (blob.size < EOCD_SIZE) throw new ZipError("not_zip");
  const tailStart = Math.max(0, blob.size - EOCD_SIZE - MAX_COMMENT);
  const tail = await bytesOf(blob, tailStart, blob.size);
  let eocd = -1;
  for (let i = tail.byteLength - EOCD_SIZE; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not_zip");
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE) {
    throw new ZipError("unsupported");
  }
  const disk = tail.getUint16(eocd + 4, true);
  const centralDisk = tail.getUint16(eocd + 6, true);
  const count = tail.getUint16(eocd + 10, true);
  const centralSize = tail.getUint32(eocd + 12, true);
  const centralOffset = tail.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0) throw new ZipError("unsupported");
  if (centralOffset === ZIP64_MARKER || count === 0xffff) throw new ZipError("unsupported");
  if (centralOffset + centralSize > tailStart + eocd) throw new ZipError("corrupt");

  const central = await bytesOf(blob, centralOffset, centralOffset + centralSize);
  const raw = new Uint8Array(central.buffer);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > central.byteLength || central.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError("corrupt");
    }
    const madeBy = central.getUint16(at + 4, true);
    const flags = central.getUint16(at + 8, true);
    const method = central.getUint16(at + 10, true);
    const crc32 = central.getUint32(at + 16, true);
    const compressedSize = central.getUint32(at + 20, true);
    const size = central.getUint32(at + 24, true);
    const nameLength = central.getUint16(at + 28, true);
    const extraLength = central.getUint16(at + 30, true);
    const commentLength = central.getUint16(at + 32, true);
    const attributes = central.getUint32(at + 38, true);
    const offset = central.getUint32(at + 42, true);
    if (at + 46 + nameLength > central.byteLength) throw new ZipError("corrupt");
    const name = decodeName(raw.subarray(at + 46, at + 46 + nameLength), (flags & 0x800) !== 0);
    at += 46 + nameLength + extraLength + commentLength;

    const unixType = madeBy >> 8 === UNIX_HOST ? (attributes >>> 16) & FILE_TYPE_MASK : 0;
    if (unixType === SYMLINK) throw new ZipError("symlink", name);
    if (name.endsWith("/") || unixType === DIRECTORY) continue;
    if (unixType !== 0 && unixType !== REGULAR_FILE) throw new ZipError("special_file", name);
    if (flags & 0x1) throw new ZipError("encrypted", name);
    if (method !== 0 && method !== 8) throw new ZipError("unsupported", name);
    if ([compressedSize, size, offset].includes(ZIP64_MARKER)) {
      throw new ZipError("unsupported", name);
    }
    if (method === 0 && compressedSize !== size) throw new ZipError("corrupt", name);
    entries.push({ name, size, compressedSize, method, crc32, offset });
  }
  return entries;
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

/** Running CRC-32 (ZIP's checksum): start with 0 and pass the previous value back in. */
export function crc32(previous: number, chunk: Uint8Array): number {
  let crc = ~previous >>> 0;
  for (const byte of chunk) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return ~crc >>> 0;
}

/**
 * Expands one entry, passing its bytes to `onChunk` as they come. Fails as soon as the output
 * exceeds the declared size, and at the end if the size or CRC-32 differ from what was declared.
 */
export async function expandZipEntry(
  blob: Blob,
  entry: ZipEntry,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  const local = await bytesOf(blob, entry.offset, entry.offset + 30);
  if (local.byteLength < 30 || local.getUint32(0, true) !== LOCAL_SIGNATURE) {
    throw new ZipError("corrupt", entry.name);
  }
  const start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const end = start + entry.compressedSize;
  if (end > blob.size) throw new ZipError("corrupt", entry.name);

  let produced = 0;
  let crc = 0;
  const accept = (chunk: Uint8Array) => {
    produced += chunk.byteLength;
    if (produced > entry.size) throw new ZipError("corrupt", entry.name);
    crc = crc32(crc, chunk);
    onChunk(chunk);
  };
  let inflate: Inflate | undefined;
  if (entry.method === 8) {
    inflate = new Inflate();
    inflate.ondata = (chunk) => accept(chunk);
  }
  const reader = blob.slice(start, end).stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (inflate) inflate.push(value, false);
      else accept(value);
    }
    inflate?.push(new Uint8Array(0), true);
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError("corrupt", entry.name);
  } finally {
    reader.releaseLock();
  }
  if (produced !== entry.size || crc !== entry.crc32) throw new ZipError("corrupt", entry.name);
}
