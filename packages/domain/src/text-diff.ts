// Line diff of one text file between two versions (premium plan P3). Myers' O((N+M)D) algorithm
// on interned lines, after trimming the common start and end, with hard bounds so its worst case
// is bounded in time and memory wherever it runs (the app Worker): each side at most
// `VERSION_DIFF.lines` lines, and the search stops once more than `VERSION_DIFF.changedLines`
// lines would differ. Past a bound the answer is that the file changed, with sizes only.
import { VERSION_DIFF } from "@portifact/contracts";
import { isTextContentType } from "./text-read.ts";

export interface DiffLine {
  type: "context" | "added" | "removed";
  text: string;
  /** Line number in the earlier version (from 1); null for an added line. */
  before: number | null;
  /** Line number in the later version (from 1); null for a removed line. */
  after: number | null;
  /** The line is the last one of its file and has no line break after it. */
  noNewline: boolean;
}

export interface DiffHunk {
  beforeStart: number;
  beforeLines: number;
  afterStart: number;
  afterLines: number;
  lines: DiffLine[];
}

export type TextDiff =
  | { status: "text"; added: number; removed: number; hunks: DiffHunk[] }
  | { status: "too_many_lines" }
  | { status: "too_many_changes" };

export interface DiffLimits {
  lines: number;
  changedLines: number;
  contextLines: number;
}

interface Line {
  text: string;
  noNewline: boolean;
}

/** The lines of a text: split at `\n`, with the last one marked when no line break ends it. */
export function splitLines(text: string): Line[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const endsWithBreak = parts.at(-1) === "";
  if (endsWithBreak) parts.pop();
  return parts.map((part, index) => ({
    text: part,
    noNewline: !endsWithBreak && index === parts.length - 1,
  }));
}

/** Strict UTF-8 decoding: null when the bytes are not valid UTF-8, so the file counts as binary. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Whether a file can get a text diff from its content type and size, before reading it. */
export function textDiffEligibility(
  file: { contentType: string; size: number } | null,
  maxBytes: number = VERSION_DIFF.fileBytes,
): "text" | "binary" | "too_large" {
  if (file === null) return "text";
  if (!isTextContentType(file.contentType)) return "binary";
  return file.size > maxBytes ? "too_large" : "text";
}

const EQUAL = 0;
const REMOVED = 1;
const ADDED = 2;

/**
 * Myers' shortest edit script between `a` and `b` (interned lines), as one operation per line in
 * order, or null when it needs more than `maxEdits` insertions and deletions. Memory is the
 * search's history, at most (maxEdits + 1)² integers.
 */
function editScript(a: Int32Array, b: Int32Array, maxEdits: number): Uint8Array | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  search: for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number));
      let x = down ? (v[offset + k + 1] as number) : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        found = d;
        break search;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (found < 0) return null;
  const ops: number[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const previous = trace[d - 1] as Int32Array;
    const at = (k: number) => previous[k + d - 1] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const startX = down ? prevX : prevX + 1;
    while (x > startX) {
      ops.push(EQUAL);
      x--;
      y--;
    }
    ops.push(down ? ADDED : REMOVED);
    x = prevX;
    y = prevY;
  }
  for (; x > 0; x--) ops.push(EQUAL);
  return Uint8Array.from(ops.reverse());
}

function intern(lines: Line[], ids: Map<string, number>): Int32Array {
  const out = new Int32Array(lines.length);
  lines.forEach((line, index) => {
    const key = line.noNewline ? `${line.text}\n` : line.text;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    out[index] = id;
  });
  return out;
}

/** The lines of both sides in order, each marked equal, removed or added. */
function diffOps(before: Line[], after: Line[], maxEdits: number): DiffLine[] | null {
  const ids = new Map<string, number>();
  const a = intern(before, ids);
  const b = intern(after, ids);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = editScript(a.subarray(start, endA), b.subarray(start, endB), maxEdits);
  if (middle === null) return null;
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  const equal = () => {
    const line = after[j] as Line;
    lines.push({
      type: "context",
      text: line.text,
      before: i + 1,
      after: j + 1,
      noNewline: line.noNewline,
    });
    i++;
    j++;
  };
  while (i < start) equal();
  for (const op of middle) {
    if (op === EQUAL) {
      equal();
    } else if (op === REMOVED) {
      const line = before[i] as Line;
      lines.push({
        type: "removed",
        text: line.text,
        before: i + 1,
        after: null,
        noNewline: line.noNewline,
      });
      i++;
    } else {
      const line = after[j] as Line;
      lines.push({
        type: "added",
        text: line.text,
        before: null,
        after: j + 1,
        noNewline: line.noNewline,
      });
      j++;
    }
  }
  while (i < before.length) equal();
  return lines;
}

/** Groups changed lines with `context` lines around them; hunks closer than that merge. */
function toHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && (lines[index] as DiffLine).type === "context") index++;
    if (index >= lines.length) break;
    const first = Math.max(0, index - context);
    let last = index;
    let scan = index;
    while (scan < lines.length) {
      if ((lines[scan] as DiffLine).type !== "context") {
        last = scan;
        scan++;
      } else if (scan - last > 2 * context) {
        break;
      } else {
        scan++;
      }
    }
    const end = Math.min(lines.length, last + context + 1);
    const slice = lines.slice(first, end);
    // Before and after positions of the line just before the hunk, for a side with no lines.
    let beforeAt = 0;
    let afterAt = 0;
    for (let k = first - 1; k >= 0; k--) {
      const line = lines[k] as DiffLine;
      if (beforeAt === 0 && line.before !== null) beforeAt = line.before;
      if (afterAt === 0 && line.after !== null) afterAt = line.after;
      if (beforeAt !== 0 && afterAt !== 0) break;
    }
    const beforeLines = slice.filter((line) => line.before !== null);
    const afterLines = slice.filter((line) => line.after !== null);
    hunks.push({
      beforeStart: beforeLines[0]?.before ?? beforeAt,
      beforeLines: beforeLines.length,
      afterStart: afterLines[0]?.after ?? afterAt,
      afterLines: afterLines.length,
      lines: slice,
    });
    index = end;
  }
  return hunks;
}

/** The line diff of two texts, or why it is not shown. */
export function diffText(
  before: string,
  after: string,
  limits: DiffLimits = VERSION_DIFF,
): TextDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > limits.lines || b.length > limits.lines) return { status: "too_many_lines" };
  const lines = diffOps(a, b, limits.changedLines);
  if (lines === null) return { status: "too_many_changes" };
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "added") added++;
    else if (line.type === "removed") removed++;
  }
  return { status: "text", added, removed, hunks: toHunks(lines, limits.contextLines) };
}

/**
 * One page of hunks starting at hunk `cursor`: whole hunks while their lines fit in `pageLines`,
 * always at least one, and the index of the next hunk or null after the last.
 */
export function pageHunks(
  hunks: DiffHunk[],
  cursor: number,
  pageLines: number = VERSION_DIFF.pageLines,
): { hunks: DiffHunk[]; nextCursor: number | null } {
  const page: DiffHunk[] = [];
  let lines = 0;
  let index = cursor;
  while (index < hunks.length) {
    const hunk = hunks[index] as DiffHunk;
    if (page.length > 0 && lines + hunk.lines.length > pageLines) break;
    page.push(hunk);
    lines += hunk.lines.length;
    index++;
  }
  return { hunks: page, nextCursor: index < hunks.length ? index : null };
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Hunks as a unified diff, the format `diff -u` and git print. */
export function unifiedDiff(hunks: DiffHunk[], labels: { before: string; after: string }): string {
  if (hunks.length === 0) return "";
  const out = [`--- ${labels.before}`, `+++ ${labels.after}`];
  const sign = { context: " ", added: "+", removed: "-" } as const;
  for (const hunk of hunks) {
    out.push(
      `@@ -${range(hunk.beforeStart, hunk.beforeLines)} +${range(hunk.afterStart, hunk.afterLines)} @@`,
    );
    for (const line of hunk.lines) {
      out.push(`${sign[line.type]}${line.text}`);
      if (line.noNewline) out.push("\\ No newline at end of file");
    }
  }
  return `${out.join("\n")}\n`;
}
