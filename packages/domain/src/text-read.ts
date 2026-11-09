// Reading a stored file as text in bounded pages (plan section 6: inline content up to 256 KiB per
// operation, larger reads paginated). Pages are cut by bytes, never inside a UTF-8 character, so
// each page decodes on its own and the next one starts where it ended.

const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/x-javascript",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "image/svg+xml",
]);

/** Whether a file of this content type is text a reader can get inline. */
export function isTextContentType(contentType: string): boolean {
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (TEXT_APPLICATION_TYPES.has(mime)) return true;
  return /^application\/[a-z0-9.+-]+\+(?:json|xml)$/.test(mime);
}

/**
 * How many leading bytes of `chunk` end on a UTF-8 character boundary. A page that is not the
 * last one drops the incomplete character at its end; the next page starts with it.
 */
export function utf8BoundaryEnd(chunk: Uint8Array): number {
  const length = chunk.length;
  // A character is at most four bytes, so only the last three can start an incomplete one.
  for (let back = 1; back <= Math.min(3, length); back++) {
    const byte = chunk[length - back] as number;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue;
    const needed = byte >= 0b1111_0000 ? 4 : byte >= 0b1110_0000 ? 3 : byte >= 0b1100_0000 ? 2 : 1;
    return needed > back ? length - back : length;
  }
  return length;
}
