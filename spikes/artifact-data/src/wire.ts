// How SQL values leave the sandbox (decision 0026, "Results"): every type has one JSON form, and
// every value is measured in the bytes it takes on the wire before it is kept, so a large BLOB or
// string cannot slip past the result cap (finding 7).

export type WireValue =
  | null
  | number
  | string
  | { $int: string }
  | { $blob: string }
  | { $omitted: number };

/** Bytes one value may take; a larger one is replaced by `{ $omitted: <bytes> }`. */
export const VALUE_BYTES = 64 * 1024;
/** Bytes and rows one result may take; past either the result stops and says it was truncated. */
export const RESULT_BYTES = 1024 * 1024;
export const RESULT_ROWS = 1_000;

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** One value and the bytes it takes once serialized. */
export function encodeValue(value: unknown): { wire: WireValue; bytes: number } {
  if (value === null || value === undefined) return { wire: null, bytes: 4 };
  if (typeof value === "bigint") {
    const text = value.toString();
    return { wire: { $int: text }, bytes: text.length + 10 };
  }
  if (typeof value === "number") {
    const text = JSON.stringify(Number.isFinite(value) ? value : null);
    return { wire: Number.isFinite(value) ? value : null, bytes: text.length };
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    return bytes > VALUE_BYTES ? { wire: { $omitted: bytes }, bytes: 16 } : { wire: value, bytes };
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const view =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const bytes = Math.ceil(view.byteLength / 3) * 4 + 12;
    if (bytes > VALUE_BYTES) return { wire: { $omitted: view.byteLength }, bytes: 16 };
    return { wire: { $blob: base64(view) }, bytes };
  }
  throw new Error("unexpected SQL value");
}

export interface EncodedResult {
  columns: string[];
  rows: WireValue[][];
  truncated: boolean;
  bytes: number;
}

/** Reads rows one at a time and stops at the row or byte cap, before keeping what is past it. */
export function encodeRows(columns: string[], rows: Iterable<unknown[]>): EncodedResult {
  const kept: WireValue[][] = [];
  let bytes = 0;
  let truncated = false;
  for (const row of rows) {
    if (kept.length >= RESULT_ROWS) {
      truncated = true;
      break;
    }
    const encoded = row.map(encodeValue);
    const rowBytes = encoded.reduce((sum, value) => sum + value.bytes + 1, 2);
    if (bytes + rowBytes > RESULT_BYTES) {
      truncated = true;
      break;
    }
    bytes += rowBytes;
    const wire = encoded.map((value) => value.wire);
    if (
      encoded.some(
        (value) =>
          typeof value.wire === "object" && value.wire !== null && "$omitted" in value.wire,
      )
    ) {
      truncated = true;
    }
    kept.push(wire);
  }
  return { columns, rows: kept, truncated, bytes };
}
