// Validates document sources before rendering (plan section 2: valid UTF-8, at most 5 MB).
import { LIMITS } from "@portifact/contracts";
import { RenderError } from "./errors.ts";

/** Largest document source, in UTF-8 bytes. */
export const MAX_SOURCE_BYTES = LIMITS.documentBytes;

/** UTF-8 length of a string without encoding it. Lone surrogates count as U+FFFD (3 bytes). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(index + 1))) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Throws `too_large` when a source exceeds the document limit. */
export function assertSourceSize(text: string): void {
  // A UTF-16 unit never encodes to more than 3 bytes, so short strings skip the exact count.
  if (text.length * 3 <= MAX_SOURCE_BYTES) return;
  if (utf8ByteLength(text) > MAX_SOURCE_BYTES) {
    throw new RenderError("too_large", `Documents are limited to ${MAX_SOURCE_BYTES} bytes`);
  }
}

/**
 * Decodes an uploaded document. Rejects sources over the limit, invalid UTF-8 and binary data
 * (any NUL byte). A leading byte order mark is dropped; every other character is kept.
 */
export function decodeSource(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new RenderError("too_large", `Documents are limited to ${MAX_SOURCE_BYTES} bytes`);
  }
  if (bytes.includes(0)) throw new RenderError("binary", "Documents must be text, not binary");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new RenderError("invalid_utf8", "Documents must be valid UTF-8");
  }
}
