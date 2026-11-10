// Image files built byte by byte for the brand logo's tests (packages/domain, services, the app,
// the content Worker and the end-to-end suite). `png` makes a real, decodable image (stored
// deflate blocks, correct CRCs); the options break it in the ways a hostile upload would.
// Test support only: excluded from coverage and mutation.

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}
function u24le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const CRC_TABLE = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(bytes: number[]): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: number[]): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream of stored (uncompressed) deflate blocks. */
function zlibStored(data: number[]): number[] {
  const out = [0x78, 0x01];
  for (let i = 0; i === 0 || i < data.length; i += 65535) {
    const block = data.slice(i, i + 65535);
    const last = i + 65535 >= data.length ? 1 : 0;
    out.push(
      last,
      block.length & 0xff,
      block.length >>> 8,
      ~block.length & 0xff,
      (~block.length >>> 8) & 0xff,
    );
    out.push(...block);
  }
  out.push(...u32be(adler32(data)));
  return out;
}

export interface Chunk {
  type: string;
  data: number[];
}

function pngChunk({ type, data }: Chunk): number[] {
  const body = [...ascii(type), ...data];
  return [...u32be(data.length), ...body, ...u32be(crc32(body))];
}

export interface PngOptions {
  width?: number;
  height?: number;
  /** Chunks placed right after IHDR, such as `acTL` (animation) or a `tEXt` holding markup. */
  extra?: Chunk[];
  /** Bytes appended after IEND. */
  trailing?: number[];
  /** Keep only this many bytes. */
  truncateTo?: number;
  /** Break the IHDR checksum. */
  badCrc?: boolean;
}

/** A real RGBA PNG filled with one gray, unless the options break it. */
export function png(options: PngOptions = {}): Uint8Array {
  const width = options.width ?? 64;
  const height = options.height ?? 32;
  const ihdr = [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0];
  const rows: number[] = [];
  // Pixels only for small images; large ones only need a valid header for the size checks.
  const pixels = width * height <= 256 * 256;
  if (pixels) {
    for (let y = 0; y < height; y += 1) {
      rows.push(0);
      for (let x = 0; x < width; x += 1) rows.push(0x5c, 0x5c, 0x5c, 0xff);
    }
  }
  const head = pngChunk({ type: "IHDR", data: ihdr });
  if (options.badCrc) head[head.length - 1] = ((head.at(-1) ?? 0) + 1) & 0xff;
  const bytes = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...head,
    ...(options.extra ?? []).flatMap(pngChunk),
    ...pngChunk({ type: "IDAT", data: zlibStored(rows) }),
    ...pngChunk({ type: "IEND", data: [] }),
    ...(options.trailing ?? []),
  ];
  return Uint8Array.from(bytes.slice(0, options.truncateTo ?? bytes.length));
}

export interface JpegOptions {
  width?: number;
  height?: number;
  /** A comment segment (COM), such as markup. */
  comment?: string;
  trailing?: number[];
  truncateTo?: number;
  /** Leave the frame header out. */
  noFrame?: boolean;
}

/** A JPEG's structure: SOI, APP0, an optional COM, SOF0 with the size, SOS with data, EOI. */
export function jpeg(options: JpegOptions = {}): Uint8Array {
  const width = options.width ?? 64;
  const height = options.height ?? 32;
  const segment = (marker: number, data: number[]) => [
    0xff,
    marker,
    (data.length + 2) >>> 8,
    (data.length + 2) & 0xff,
    ...data,
  ];
  const bytes = [
    0xff,
    0xd8,
    ...segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(options.comment === undefined ? [] : segment(0xfe, ascii(options.comment))),
    ...(options.noFrame
      ? []
      : segment(0xc0, [8, height >>> 8, height & 0xff, width >>> 8, width & 0xff, 1, 1, 0x11, 0])),
    ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
    // Entropy-coded data with a stuffed 0xff and a restart marker.
    0x12,
    0x34,
    0xff,
    0x00,
    0x56,
    0xff,
    0xd0,
    0x78,
    0xff,
    0xd9,
    ...(options.trailing ?? []),
  ];
  return Uint8Array.from(bytes.slice(0, options.truncateTo ?? bytes.length));
}

export interface WebpOptions {
  width?: number;
  height?: number;
  kind?: "lossless" | "lossy" | "extended";
  /** For `extended`: set the animation flag, or add an ANIM chunk. */
  animated?: "flag" | "chunk";
  trailing?: number[];
  truncateTo?: number;
  /** Write a RIFF size that does not match the file. */
  badSize?: boolean;
}

/** A WebP container with a VP8L, VP8 or VP8X image header. */
export function webp(options: WebpOptions = {}): Uint8Array {
  const width = options.width ?? 64;
  const height = options.height ?? 32;
  const chunk = (type: string, data: number[]) => [
    ...ascii(type),
    ...u32le(data.length),
    ...data,
    ...(data.length % 2 ? [0] : []),
  ];
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const lossless = chunk("VP8L", [0x2f, ...u32le(bits >>> 0), 0, 0, 0]);
  const lossy = chunk("VP8 ", [
    0x10,
    0x02,
    0x00,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    (width >>> 8) & 0x3f,
    height & 0xff,
    (height >>> 8) & 0x3f,
    0,
    0,
  ]);
  const body =
    options.kind === "lossy"
      ? lossy
      : options.kind === "extended"
        ? [
            ...chunk("VP8X", [
              options.animated === "flag" ? 0x02 : 0,
              0,
              0,
              0,
              ...u24le(width - 1),
              ...u24le(height - 1),
            ]),
            ...(options.animated === "chunk" ? chunk("ANIM", [0, 0, 0, 0, 0, 0]) : []),
            ...lossless,
          ]
        : lossless;
  const payload = [...ascii("WEBP"), ...body];
  const size = payload.length + (options.badSize ? 4 : 0);
  const bytes = [...ascii("RIFF"), ...u32le(size), ...payload, ...(options.trailing ?? [])];
  return Uint8Array.from(bytes.slice(0, options.truncateTo ?? bytes.length));
}

/** The bytes of a text, for files that are not images at all. */
export function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** A RIFF WebP container around chunks given as raw bytes, with a matching RIFF size. */
export function webpRaw(chunks: number[]): Uint8Array {
  const payload = [...ascii("WEBP"), ...chunks];
  return Uint8Array.from([...ascii("RIFF"), ...u32le(payload.length), ...payload]);
}

/** One WebP chunk: its type, size, data and padding. */
export function webpChunk(type: string, data: number[], declared = data.length): number[] {
  return [...ascii(type), ...u32le(declared), ...data, ...(data.length % 2 ? [0] : [])];
}
