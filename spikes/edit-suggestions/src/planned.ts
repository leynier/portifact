// What a planner returns for one file, whatever its kind: the operations applied (one combined
// patch in base coordinates) and the operations listed, with why, and for each located operation
// the proof data a change-list item or a carried suggestion keeps (decision 0027, rule 5 of the
// second round). Offsets are named by their unit: `utf16` offsets into the stored file's
// JavaScript string, never anchor code points or UTF-8 bytes.
import type { Destination } from "./display.ts";
import type { UncertainReason } from "./edit.ts";

export interface Proof {
  unit: "utf16";
  /** The changed range of the stored file and its bytes before and after. */
  start: number;
  end: number;
  before: string;
  after: string;
  /** The same change as the page shows it (decoded, unescaped). */
  shownBefore: string;
  shownAfter: string;
  /** Raw text of the same text node on each side of the change (at most 32 units each). */
  nodeLeft: string;
  nodeRight: string;
  /**
   * The target's identity: each element from the text node up to the body, with its attributes
   * (positional ones left out) and, for links, the effective destination. It must be the same
   * for a carry or a closure to count.
   */
  identity: string[];
}

export interface PlannedPatch {
  operation: number;
  start: number;
  end: number;
  replacement: string;
  destinations: Destination[];
  proof: Proof;
}

export interface PlannedListed {
  operation: number;
  reason: UncertainReason;
  /** Present when the operation was located before it was refused. */
  destinations?: Destination[];
  proof?: Proof;
}

export interface PlannedFile {
  applied: PlannedPatch[];
  listed: PlannedListed[];
  source?: string;
}

/** Keeps the patches that touch no other one; the others are listed as `overlap`. */
export function withoutOverlaps<T extends { operation: number; start: number; end: number }>(
  found: readonly T[],
  listed: PlannedListed[],
): T[] {
  const clash = (a: T, b: T) => a !== b && a.start <= b.end && b.start <= a.end;
  const kept = found.filter((a) => !found.some((b) => clash(a, b)));
  for (const item of found) {
    if (!kept.includes(item)) listed.push({ operation: item.operation, reason: "overlap" });
  }
  return kept;
}

export const byOperation = <T extends { operation: number }>(listed: readonly T[]) =>
  [...listed].sort((a, b) => a.operation - b.operation);

/** Operations a plan takes at most; the rest are listed. */
export const PLAN_OPERATIONS_MAX = 100;

/** Every byte outside the approved ranges is the same in both files. */
export function onlyApprovedBytes(
  old: string,
  next: string,
  ranges: readonly { start: number; end: number; replacement: string }[],
): boolean {
  let cursor = 0;
  let shift = 0;
  for (const item of [...ranges].sort((a, b) => a.start - b.start)) {
    if (old.slice(cursor, item.start) !== next.slice(cursor + shift, item.start + shift)) {
      return false;
    }
    if (
      next.slice(item.start + shift, item.start + shift + item.replacement.length) !==
      item.replacement
    ) {
      return false;
    }
    shift += item.replacement.length - (item.end - item.start);
    cursor = item.end;
  }
  return old.slice(cursor) === next.slice(cursor + shift) && old.length + shift === next.length;
}
