// What a planner returns for one file, whatever its kind: the operations applied (one combined
// patch in base coordinates) and the operations listed, with why.
import type { UncertainReason } from "./edit.ts";

export interface PlannedPatch {
  operation: number;
  /** UTF-16 range of the stored file that is replaced, and its replacement as written. */
  start: number;
  end: number;
  replacement: string;
  destinations: string[];
}

export interface PlannedFile {
  applied: PlannedPatch[];
  listed: { operation: number; reason: UncertainReason }[];
  source?: string;
}

/** Keeps the patches that touch no other one; the others are listed as `overlap`. */
export function withoutOverlaps<T extends { operation: number; start: number; end: number }>(
  found: readonly T[],
  listed: PlannedFile["listed"],
): T[] {
  const clash = (a: T, b: T) => a !== b && a.start <= b.end && b.start <= a.end;
  const kept = found.filter((a) => !found.some((b) => clash(a, b)));
  for (const item of found)
    if (!kept.includes(item)) listed.push({ operation: item.operation, reason: "overlap" });
  return kept;
}

export const byOperation = (listed: PlannedFile["listed"]) =>
  [...listed].sort((a, b) => a.operation - b.operation);
