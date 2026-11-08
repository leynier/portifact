// The text normalization contract (plan section 8, "Anclas"). Anchors store quotes and positions
// against normalized text, so the bridge, the viewers and the server agree on them however the
// page spells its whitespace or composes its characters:
//
// - Every run of whitespace or control characters becomes one U+0020 space, and the text has no
//   leading or trailing space. Line breaks are whitespace, so CRLF, CR and LF are equal.
// - Each base character and the combining marks after it is normalized to NFC. Lone surrogates
//   become U+FFFD.
// - Offsets count Unicode code points of the normalized text. DOM offsets are UTF-16 units of the
//   raw text; the mapping kept here converts between the two.

/**
 * One cluster per match: a run of whitespace or control characters, or a base character with
 * the combining marks and Hangul vowel and trailing jamo that NFC may compose into it.
 */
const CLUSTER = /[\s\p{Cc}]+|[^\s\p{Cc}][\p{M}\u1160-\u11ff]*/gu;
const SPACE_OR_CONTROL = /^[\s\p{Cc}]/u;

/** Normalized text with a code point index, so code point offsets and slices are cheap. */
export class NormalizedText {
  /** The normalized string. */
  readonly value: string;
  /** Length in code points. */
  readonly length: number;
  /** UTF-16 offset of each code point; `units[length]` is `value.length`. */
  private readonly units: Uint32Array;

  constructor(value: string, units: Uint32Array, length: number) {
    this.value = value;
    this.units = units;
    this.length = length;
  }

  /** Normalizes raw text. */
  static from(raw: string): NormalizedText {
    return normalizeWithMap(raw).text;
  }

  /** UTF-16 offset in `value` of a code point offset, clamped to the text. */
  unitOffset(codePoint: number): number {
    return this.units[clamp(codePoint, 0, this.length)] as number;
  }

  /** Code point offset of a UTF-16 offset in `value`, rounding down inside a surrogate pair. */
  codePointOffset(unit: number): number {
    return lastAtMost(this.units, this.length + 1, unit);
  }

  /** The text between two code point offsets. */
  slice(start: number, end: number): string {
    return this.value.slice(this.unitOffset(start), this.unitOffset(end));
  }

  /**
   * Code point offsets where `needle` occurs, at most `limit` of them; `undefined` when there
   * are more, so a caller never decides on a partial list.
   */
  occurrences(needle: string, limit: number): number[] | undefined {
    const found: number[] = [];
    let unit = this.value.indexOf(needle);
    while (unit >= 0) {
      if (found.length === limit) return undefined;
      found.push(this.codePointOffset(unit));
      unit = this.value.indexOf(needle, unit + 1);
    }
    return found;
  }
}

/** Normalized text plus, for each of its code points, the raw UTF-16 range it came from. */
export interface NormalizedMap {
  readonly text: NormalizedText;
  readonly rawStart: Uint32Array;
  readonly rawEnd: Uint32Array;
}

export function normalizeText(raw: string): string {
  return normalizeWithMap(raw).text.value;
}

export function normalizeWithMap(raw: string): NormalizedMap {
  // NFC can expand one UTF-16 unit into up to three code points (U+FB2C), so the buffers grow.
  let capacity = raw.length + 1;
  let units = new Uint32Array(capacity);
  let rawStart = new Uint32Array(capacity);
  let rawEnd = new Uint32Array(capacity);
  const parts: string[] = [];
  let count = 0;
  let unit = 0;
  let spaceStart = -1;
  let spaceEnd = 0;

  const emit = (codePoint: string, start: number, end: number) => {
    // Growing on every code point doubles the typed arrays until the test runner runs out of
    // memory. The tests catch it (the runner crashes), but each such mutant costs gigabytes.
    // Stryker disable next-line ConditionalExpression,EqualityOperator: memory bomb, see above
    if (count + 1 === capacity) {
      capacity *= 2;
      units = grow(units, capacity);
      rawStart = grow(rawStart, capacity);
      rawEnd = grow(rawEnd, capacity);
    }
    parts.push(codePoint);
    units[count] = unit;
    rawStart[count] = start;
    rawEnd[count] = end;
    count++;
    unit += codePoint.length;
  };

  for (const match of raw.matchAll(CLUSTER)) {
    const cluster = match[0];
    const start = match.index;
    const end = start + cluster.length;
    if (SPACE_OR_CONTROL.test(cluster)) {
      if (spaceStart < 0) spaceStart = start;
      spaceEnd = end;
      continue;
    }
    if (spaceStart >= 0) {
      if (count > 0) emit(" ", spaceStart, spaceEnd);
      spaceStart = -1;
    }
    for (const codePoint of cluster.toWellFormed().normalize("NFC")) emit(codePoint, start, end);
  }
  units[count] = unit;

  return {
    text: new NormalizedText(parts.join(""), units.subarray(0, count + 1), count),
    rawStart: rawStart.subarray(0, count),
    rawEnd: rawEnd.subarray(0, count),
  };
}

function grow(array: Uint32Array, capacity: number): Uint32Array<ArrayBuffer> {
  const grown = new Uint32Array(capacity);
  grown.set(array);
  return grown;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Index of the last element of a non-decreasing array that is at most `value`, or 0. */
export function lastAtMost(array: Uint32Array, length: number, value: number): number {
  let low = 0;
  let high = length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((array[middle] as number) <= value) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Number of leading elements of a non-decreasing array that are below `value`. */
export function countBelow(array: Uint32Array, value: number): number {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((array[middle] as number) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Number of leading elements of a non-decreasing array that are at most `value`. */
export function countAtMost(array: Uint32Array, value: number): number {
  return countBelow(array, value + 1);
}
