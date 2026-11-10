// The owner's brand on the viewer's bar (premium plan P9): the rules for its four values. Pure:
// packages/services stores them, the viewer draws them as text, a link and an image.
//
// - The name is plain text: normalized, at most `BRAND_LIMITS.nameMaxLength` code points, no
//   control or invisible formatting characters (which could reorder or hide text), and nothing
//   that reads as "Portifact", so a brand cannot pose as the platform it sits on.
// - The link is an `https` URL to somebody else's site: no credentials, no IP literals, no
//   single-label or local hosts, no other port and no Portifact host.
// - The logo is a PNG, JPEG or WebP file judged by its bytes alone: its signature, a walk of its
//   whole structure (so a truncated file or bytes after its end are refused), its dimensions read
//   from its header, no animation and no markup anywhere in it, so it is never also an HTML or SVG
//   document whatever a browser might sniff.
import { BRAND_LIMITS, type BrandLogoType } from "@portifact/contracts";
import { type Entitlements, hasFeature } from "./plans.ts";
import { fail, ok, type Result } from "./result.ts";

/** Hosts a brand link may never point at, whatever the deployment's own domains are. */
export const PORTIFACT_HOSTS = ["portifact.com", "portifact.dev"] as const;

// Control characters, format characters (bidi overrides, zero-width joiners, the BOM), line and
// paragraph separators, private use and unassigned code points.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;

// Digits people use for letters in look-alike names.
const LOOK_ALIKES: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "7": "t" };

/** The name reduced to lowercase letters, with look-alike digits read as letters. */
function skeleton(name: string): string {
  return [...name.normalize("NFKD").toLowerCase()]
    .map((c) => LOOK_ALIKES[c] ?? c)
    .filter((c) => /[a-z]/.test(c))
    .join("");
}

/** The name to store: trimmed, spaces collapsed, checked against the rules above. */
export function normalizeBrandName(raw: string): Result<string> {
  const name = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (name === "") return fail("invalid_input", "name: Enter the name to show.");
  if ([...name].length > BRAND_LIMITS.nameMaxLength) {
    return fail("invalid_input", `name: Use at most ${BRAND_LIMITS.nameMaxLength} characters.`);
  }
  if (HIDDEN.test(name)) {
    return fail("invalid_input", "name: Remove control and invisible characters.");
  }
  if (skeleton(name).includes("portifact")) {
    return fail("invalid_input", "name: The name cannot read as Portifact.");
  }
  return ok(name);
}

function isIpLiteral(hostname: string): boolean {
  // The URL parser already turned every IPv4 spelling (hex, octal, short forms) into dotted
  // decimal, and IPv6 literals keep their brackets.
  return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function isBlockedHost(hostname: string, blocked: readonly string[]): boolean {
  return blocked.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * The link to store, as the URL parser serializes it. `blockedHosts` adds the deployment's own
 * domains (its app and content domains) to `PORTIFACT_HOSTS`.
 */
export function normalizeBrandLink(raw: string, blockedHosts: readonly string[]): Result<string> {
  const text = raw.trim();
  if (text.length > BRAND_LIMITS.linkMaxLength) {
    return fail("invalid_input", `link: Use at most ${BRAND_LIMITS.linkMaxLength} characters.`);
  }
  // Whitespace inside is refused rather than stripped, as browsers would.
  if (/[\s\p{Cc}]/u.test(text) || !URL.canParse(text)) {
    return fail("invalid_input", "link: Enter a full address that starts with https://.");
  }
  const url = new URL(text);
  if (url.protocol !== "https:") {
    return fail("invalid_input", "link: Use an address that starts with https://.");
  }
  if (url.username !== "" || url.password !== "") {
    return fail("invalid_input", "link: Remove the user name and password from the address.");
  }
  if (url.port !== "") return fail("invalid_input", "link: Remove the port from the address.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIpLiteral(host))
    return fail("invalid_input", "link: Use a domain name, not an IP address.");
  const blocked = [...PORTIFACT_HOSTS, ...blockedHosts.map((h) => h.toLowerCase())];
  if (isBlockedHost(host, blocked)) {
    return fail("invalid_input", "link: Link to your own site, not to Portifact.");
  }
  if (!host.includes(".") || /\.(local|localhost|internal|test|invalid|example)$/.test(host)) {
    return fail("invalid_input", "link: Use a public domain name.");
  }
  if (url.href.length > BRAND_LIMITS.linkMaxLength) {
    return fail("invalid_input", `link: Use at most ${BRAND_LIMITS.linkMaxLength} characters.`);
  }
  return ok(url.href);
}

/** What the logo's bytes say it is. */
export interface LogoInfo {
  type: BrandLogoType;
  width: number;
  height: number;
}

const INVALID = "Use a PNG, JPEG or WebP image.";

function invalid(message = INVALID): Result<never> {
  return fail("invalid_input", `logo: ${message}`);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((b, i) => bytes[at + i] === b);
}

// Reads past the end give undefined, which bitwise operators read as 0; every parser checks its
// bounds before trusting what it read.
const at8 = (b: Uint8Array, i: number) => b[i] as number;
function u16be(b: Uint8Array, i: number): number {
  return (at8(b, i) << 8) | at8(b, i + 1);
}
function u32be(b: Uint8Array, i: number): number {
  return ((at8(b, i) << 24) | (at8(b, i + 1) << 16) | (at8(b, i + 2) << 8) | at8(b, i + 3)) >>> 0;
}
function u16le(b: Uint8Array, i: number): number {
  return at8(b, i) | (at8(b, i + 1) << 8);
}
function u24le(b: Uint8Array, i: number): number {
  return at8(b, i) | (at8(b, i + 1) << 8) | (at8(b, i + 2) << 16);
}
function u32le(b: Uint8Array, i: number): number {
  return (u24le(b, i) | (at8(b, i + 3) << 24)) >>> 0;
}
function ascii(b: Uint8Array, i: number, length: number): string {
  return String.fromCharCode(...b.subarray(i, i + length));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function inspectPng(b: Uint8Array): Result<LogoInfo> {
  let at = 8;
  let size: { width: number; height: number } | null = null;
  let sawData = false;
  while (at + 12 <= b.length) {
    const length = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + length;
    if (end > b.length) return invalid("The file is cut short.");
    if (crc32(b.subarray(at + 4, at + 8 + length)) !== u32be(b, at + 8 + length)) {
      return invalid("The file is damaged.");
    }
    if (size === null) {
      if (type !== "IHDR" || length !== 13) return invalid("The file is damaged.");
      size = { width: u32be(b, at + 8), height: u32be(b, at + 12) };
    } else if (type === "IHDR") {
      return invalid("The file is damaged.");
    }
    // APNG: an animation control chunk makes it animated.
    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      return invalid("Use an image without animation.");
    }
    if (type === "IDAT") sawData = true;
    at = end;
    if (type === "IEND") {
      if (at !== b.length) return invalid("Remove the data after the end of the image.");
      if (!sawData) return invalid("The file is damaged.");
      return ok({ type: "image/png", ...size });
    }
  }
  return invalid("The file is cut short.");
}

// Start of frame markers that carry the dimensions (baseline, progressive, lossless, arithmetic).
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function inspectJpeg(b: Uint8Array): Result<LogoInfo> {
  let at = 2;
  let size: { width: number; height: number } | null = null;
  while (at < b.length) {
    if (b[at] !== 0xff) return invalid("The file is damaged.");
    // Fill bytes before a marker.
    while (b[at] === 0xff && b[at + 1] === 0xff) at += 1;
    const marker = b[at + 1];
    if (marker === undefined) return invalid("The file is cut short.");
    at += 2;
    if (marker === 0xd9) {
      if (at !== b.length) return invalid("Remove the data after the end of the image.");
      if (size === null) return invalid("The file is damaged.");
      return ok({ type: "image/jpeg", ...size });
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > b.length) return invalid("The file is cut short.");
    const length = u16be(b, at);
    if (length < 2 || at + length > b.length) return invalid("The file is cut short.");
    if (SOF.has(marker)) {
      if (length < 7) return invalid("The file is damaged.");
      size = { height: u16be(b, at + 3), width: u16be(b, at + 5) };
    }
    at += length;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not a stuffed zero or a restart.
      while (at < b.length) {
        if (b[at] === 0xff) {
          const next = b[at + 1];
          if (next === undefined) return invalid("The file is cut short.");
          if (next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        at += 1;
      }
    }
  }
  return invalid("The file is cut short.");
}

function inspectWebp(b: Uint8Array): Result<LogoInfo> {
  // The RIFF size covers the rest of the file exactly: no truncation, nothing appended.
  if (u32le(b, 4) + 8 !== b.length) return invalid("The file is cut short or has extra data.");
  let at = 12;
  let size: { width: number; height: number } | null = null;
  let sawImage = false;
  while (at < b.length) {
    if (at + 8 > b.length) return invalid("The file is cut short.");
    const type = ascii(b, at, 4);
    const length = u32le(b, at + 4);
    const data = at + 8;
    const end = data + length + (length % 2);
    if (data + length > b.length || end > b.length) return invalid("The file is cut short.");
    if (type === "ANIM" || type === "ANMF") return invalid("Use an image without animation.");
    if (type === "VP8X") {
      if (at !== 12 || length < 10) return invalid("The file is damaged.");
      if ((at8(b, data) & 0x02) !== 0) return invalid("Use an image without animation.");
      size = { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 };
    } else if (type === "VP8 ") {
      if (sawImage || length < 10 || !startsWith(b, [0x9d, 0x01, 0x2a], data + 3)) {
        return invalid("The file is damaged.");
      }
      sawImage = true;
      const frame = { width: u16le(b, data + 6) & 0x3fff, height: u16le(b, data + 8) & 0x3fff };
      size ??= frame;
    } else if (type === "VP8L") {
      if (sawImage || length < 5 || b[data] !== 0x2f) return invalid("The file is damaged.");
      sawImage = true;
      const bits = u32le(b, data + 1);
      const frame = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      size ??= frame;
    }
    at = end;
  }
  if (!sawImage || size === null) return invalid("The file is damaged.");
  return ok({ type: "image/webp", ...size });
}

// Markup that would make the bytes an HTML, XML or SVG document if anything ever read them as
// one. Compressed image data matching one of these by chance is vanishingly unlikely; a file
// that does is refused rather than trusted.
const MARKUP = [
  "<!doctype",
  "<html",
  "<head",
  "<body",
  "<script",
  "<svg",
  "<?xml",
  "<iframe",
  "<object",
  "<embed",
  "<style",
  "<meta",
  "<a ",
  "<img",
  "<link",
  "<form",
  "<base",
  "javascript:",
];

function containsMarkup(b: Uint8Array): boolean {
  // Latin-1 keeps one character per byte, so offsets match and nothing fails to decode.
  const text = new TextDecoder("latin1").decode(b).toLowerCase();
  return MARKUP.some((needle) => text.includes(needle));
}

/**
 * What a logo file is, from its bytes alone, or why it is refused: not PNG, JPEG or WebP (SVG and
 * every other format included), too large in bytes or pixels, too small, cut short, followed by
 * extra data, animated, or carrying markup.
 */
export function inspectLogo(bytes: Uint8Array): Result<LogoInfo> {
  if (bytes.length > BRAND_LIMITS.logoMaxBytes) {
    return invalid(`Use an image of at most ${BRAND_LIMITS.logoMaxBytes / 1000} KB.`);
  }
  let info: Result<LogoInfo>;
  if (startsWith(bytes, PNG_SIGNATURE)) info = inspectPng(bytes);
  else if (startsWith(bytes, [0xff, 0xd8, 0xff])) info = inspectJpeg(bytes);
  else if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    info = inspectWebp(bytes);
  } else {
    return invalid();
  }
  if (!info.ok) return info;
  const { width, height } = info.value;
  if (width > BRAND_LIMITS.logoMaxWidth || height > BRAND_LIMITS.logoMaxHeight) {
    return invalid(
      `Use an image of at most ${BRAND_LIMITS.logoMaxWidth} by ${BRAND_LIMITS.logoMaxHeight} pixels.`,
    );
  }
  if (width < BRAND_LIMITS.logoMinSide || height < BRAND_LIMITS.logoMinSide) {
    return invalid(`Use an image of at least ${BRAND_LIMITS.logoMinSide} pixels on each side.`);
  }
  if (containsMarkup(bytes)) return invalid("Remove the text or markup stored in the image.");
  return info;
}

/** The parts of a stored brand that decide whether the bar shows it. */
export interface BrandRecord {
  suspendedAt: number | null;
}

/**
 * Whether the viewer shows the owner's brand: the owner's plan includes `branding` and the
 * operator has not suspended it. Otherwise the default bar shows, and the brand is kept.
 */
export function brandShown(brand: BrandRecord | null, owner: Entitlements): boolean {
  return brand !== null && brand.suspendedAt === null && hasFeature(owner, "branding");
}
