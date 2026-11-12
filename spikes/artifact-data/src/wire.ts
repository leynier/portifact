// How SQL values leave the sandbox (decision 0026, "Results" and "Exports"). Two forms, never
// mixed (finding 9):
//
// - Interactive results: one JSON form per type, measured as the whole serialized response
//   (column names included) in UTF-8, cut at the row and byte caps with `truncated: true`. The SQL
//   API hands integers to the Worker as JavaScript numbers, so an integer past 2^53 has lost
//   precision before the Worker sees it: such a value is marked `{ $inexact }` and the result
//   says `inexact: true`, with the advice to `CAST(column AS TEXT)`.
// - Export rows: built by statements the server generates, which return each value's SQLite type
//   and an exact text form (`typeof`, `CAST(… AS TEXT)`, `hex`, `printf('%!.17g')`), so nothing is
//   lost and nothing is cut.

export type WireValue =
  | null
  | number
  | string
  | { $inexact: string }
  | { $blob: string }
  | { $omitted: number };

export const VALUE_BYTES = 64 * 1024;
export const RESULT_BYTES = 1024 * 1024;
export const RESULT_ROWS = 1_000;

function utf8(text: string): number {
  return new TextEncoder().encode(text).length;
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function encodeValue(value: unknown): { wire: WireValue; cut: boolean; inexact: boolean } {
  if (value === null || value === undefined) return { wire: null, cut: false, inexact: false };
  if (typeof value === "bigint")
    return { wire: { $inexact: value.toString() }, cut: false, inexact: false };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { wire: null, cut: false, inexact: false };
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return { wire: { $inexact: String(value) }, cut: false, inexact: true };
    }
    return { wire: value, cut: false, inexact: false };
  }
  if (typeof value === "string") {
    const bytes = utf8(value);
    return bytes > VALUE_BYTES
      ? { wire: { $omitted: bytes }, cut: true, inexact: false }
      : { wire: value, cut: false, inexact: false };
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const view =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Math.ceil(view.byteLength / 3) * 4 > VALUE_BYTES) {
      return { wire: { $omitted: view.byteLength }, cut: true, inexact: false };
    }
    return { wire: { $blob: base64(view) }, cut: false, inexact: false };
  }
  throw new Error("unexpected SQL value");
}

export interface EncodedResult {
  columns: string[];
  rows: WireValue[][];
  /** True whenever anything was left out: rows past a cap, or a value replaced by `$omitted`. */
  truncated: boolean;
  /** True when a value could not be handed over exactly; cast it to text to read it. */
  inexact: boolean;
  /** The serialized response's size in UTF-8 bytes, column names included. */
  bytes: number;
}

/** Reads rows one at a time and stops before keeping anything past the row or byte cap. */
export function encodeRows(columns: string[], rows: Iterable<unknown[]>): EncodedResult {
  const kept: WireValue[][] = [];
  let bytes = utf8(JSON.stringify({ columns, rows: [], truncated: false, inexact: false }));
  let truncated = false;
  let inexact = false;
  if (bytes > RESULT_BYTES)
    return { columns: [], rows: [], truncated: true, inexact: false, bytes: 0 };
  for (const row of rows) {
    if (kept.length >= RESULT_ROWS) {
      truncated = true;
      break;
    }
    const encoded = row.map(encodeValue);
    const wire = encoded.map((value) => value.wire);
    const rowBytes = utf8(JSON.stringify(wire)) + 1;
    if (bytes + rowBytes > RESULT_BYTES) {
      truncated = true;
      break;
    }
    bytes += rowBytes;
    if (encoded.some((value) => value.cut)) truncated = true;
    if (encoded.some((value) => value.inexact)) inexact = true;
    kept.push(wire);
  }
  return { columns, rows: kept, truncated, inexact, bytes };
}

/** One exported value: its SQLite type and an exact text form. */
export type ExportValue =
  | { t: "null" }
  | { t: "integer"; v: string }
  | { t: "real"; v: string }
  | { t: "text"; v: string }
  | { t: "blob"; v: string };

/** The SQL expression that exports a column exactly (the column name is quoted by the caller). */
export function exportExpression(quoted: string): string {
  return `typeof(${quoted}), case typeof(${quoted}) when 'integer' then cast(${quoted} as text) when 'real' then printf('%!.17g', ${quoted}) when 'blob' then hex(${quoted}) else ${quoted} end`;
}

/** Turns the pair the export expression returned into an exported value. */
export function exportValue(type: unknown, text: unknown): ExportValue {
  if (type === "null") return { t: "null" };
  if (type === "integer" || type === "real" || type === "text" || type === "blob")
    return { t: type, v: String(text) };
  throw new Error("unexpected SQLite type");
}
