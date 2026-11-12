// What a planner returns for one file, whatever its kind: the operations applied (one combined
// patch in base coordinates) and the operations listed, with why, and for each located operation
// the proof data a change item or a carried suggestion keeps. Offsets are UTF-16 units of the
// stored file's string, never anchor code points or UTF-8 bytes.
import type { Destination, Proof, RefusalReason } from "@portifact/contracts";
import type { Work } from "./work.ts";

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
  reason: RefusalReason;
  /** Every link around or inside the selection, when it was placed on the page. */
  destinations: Destination[];
  /** False when the selection could not be placed, so its links are not known. */
  destinationsKnown: boolean;
  /** Present when the operation was located and mapped to the file (its location is proven). */
  proof?: Proof;
}

/** An operation listed before it could be placed on the page. */
export const unplaced = (operation: number, reason: RefusalReason): PlannedListed => ({
  operation,
  reason,
  destinations: [],
  destinationsKnown: false,
});

/**
 * What a planner writes as the new file's hash in a block map it renders, before sizes are
 * checked; the plan replaces it with the real hash afterwards (`outputOf`).
 */
export const PENDING_SHA256 = "0".repeat(64);

export interface PlannedFile {
  applied: PlannedPatch[];
  listed: PlannedListed[];
  /** The whole new file, when anything applies. */
  source?: string;
  /** For a document: the stored files the commit will write for `source` (rendering, block map). */
  rendered?: { kind: "rendered" | "block_map"; text: string }[];
  work: Work;
}

/** Keeps the patches that touch no other one; the others are listed as `overlap`. */
export function withoutOverlaps<T extends PlannedPatch>(
  found: readonly T[],
  listed: PlannedListed[],
): T[] {
  const clash = (a: T, b: T) => a !== b && a.start <= b.end && b.start <= a.end;
  const kept = found.filter((a) => !found.some((b) => clash(a, b)));
  for (const item of found) {
    if (!kept.includes(item)) listed.push(listedPatch(item, "overlap"));
  }
  return kept;
}

/** A located and mapped operation listed after all: its location and links stay known. */
export const listedPatch = (item: PlannedPatch, reason: RefusalReason): PlannedListed => ({
  operation: item.operation,
  reason,
  destinations: item.destinations,
  destinationsKnown: true,
  proof: item.proof,
});

export const byOperation = <T extends { operation: number }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.operation - b.operation);

/** Applies ranges of the old file, in base coordinates, from the end. */
export function applyPatches(
  source: string,
  patches: readonly { start: number; end: number; replacement: string }[],
): string {
  const parts: string[] = [];
  let cursor = source.length;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    parts.push(source.slice(patch.end, cursor), patch.replacement);
    cursor = patch.start;
  }
  parts.push(source.slice(0, cursor));
  return parts.reverse().join("");
}

/** Every byte outside the approved ranges is the same in both files. */
export function onlyApprovedBytes(
  old: string,
  next: string,
  ranges: readonly { start: number; end: number; replacement: string }[],
): boolean {
  let cursor = 0;
  let shift = 0;
  for (const item of [...ranges].sort((a, b) => a.start - b.start)) {
    if (item.start < cursor) return false;
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
