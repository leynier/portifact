// Writes ZIP files for tests, including hostile ones: any name, Unix mode, flags, method, sizes,
// CRC or offsets can be forced, so each refusal of src/zip.ts can be reproduced exactly.
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../zip.ts";

export interface ZipFixtureEntry {
  name: string;
  data?: Buffer | string;
  /** 0 stored, 8 deflate (the default), anything else as given. */
  method?: number;
  /** Unix mode in the external attributes (regular file 0o100644 by default). */
  mode?: number;
  /** Host in "version made by" (3 Unix by default, 0 MS-DOS). */
  host?: number;
  /** Raw external attributes, replacing the mode. */
  external?: number;
  flags?: number;
  /** Lies the directory tells. */
  declaredSize?: number;
  declaredCompressedSize?: number;
  crc?: number;
  /** Name in the local header, when it should differ from the directory's. */
  localName?: string;
  /** Raw name bytes, for names that are not UTF-8. */
  rawName?: Buffer;
  /** Point the directory entry at another entry's local header. */
  offsetOf?: number;
}

export interface ZipFixtureOptions {
  /** Entry count the end record declares. */
  declaredEntries?: number;
  /** Disk number in the end record. */
  disk?: number;
  /** Write ZIP64 records and sizes. */
  zip64?: boolean;
}

export function buildZip(entries: ZipFixtureEntry[], options: ZipFixtureOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const name = entry.rawName ?? Buffer.from(entry.name, "utf8");
    const localName = entry.localName === undefined ? name : Buffer.from(entry.localName, "utf8");
    const crc = entry.crc ?? crc32(data);
    const size = entry.declaredSize ?? data.length;
    const compressedSize = entry.declaredCompressedSize ?? compressed.length;
    const flags = entry.flags ?? 0x800;
    const zip64 = options.zip64 === true;

    const localExtra = zip64 ? zip64Extra([size, compressedSize]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : compressedSize, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : size, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    offsets.push(offset);
    const block = Buffer.concat([local, localName, localExtra, compressed]);
    locals.push(block);

    const entryOffset = entry.offsetOf === undefined ? offset : (offsets[entry.offsetOf] as number);
    const centralExtra = zip64 ? zip64Extra([size, compressedSize, entryOffset]) : Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.host ?? 3) << 8) | 45, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : compressedSize, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    const directory = entry.name.endsWith("/");
    const mode = entry.mode ?? (directory ? 0o040755 : 0o100644);
    central.writeUInt32LE(entry.external ?? ((mode << 16) | (directory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(zip64 ? 0xffffffff : entryOffset, 42);
    centrals.push(Buffer.concat([central, name, centralExtra]));
    offset += block.length;
  }

  const directory = Buffer.concat(centrals);
  const count = options.declaredEntries ?? entries.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.disk ?? 0, 4);
  end.writeUInt16LE(options.zip64 ? 0xffff : count, 8);
  end.writeUInt16LE(options.zip64 ? 0xffff : count, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16);
  if (!options.zip64) return Buffer.concat([...locals, directory, end]);

  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0);
  end64.writeBigUInt64LE(44n, 4);
  end64.writeUInt16LE(45, 12);
  end64.writeUInt16LE(45, 14);
  end64.writeBigUInt64LE(BigInt(count), 24);
  end64.writeBigUInt64LE(BigInt(count), 32);
  end64.writeBigUInt64LE(BigInt(directory.length), 40);
  end64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([...locals, directory, end64, locator, end]);
}

function zip64Extra(values: number[]): Buffer {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => {
    extra.writeBigUInt64LE(BigInt(value), 4 + index * 8);
  });
  return extra;
}
