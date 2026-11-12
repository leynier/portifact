// Author erasure (decision 0026, "Author erasure", decision 49). The first chunk writes the
// author's barrier, on an empty object too, before anything is deleted. From then on the barrier
// governs every path that could recreate author-associated state, and each chunk deletes a
// bounded part of what is left; the chunk that finds nothing left checks and cleans atomically
// and marks the barrier complete. Erasure is terminal: nothing about the author is ever written
// again in this object.
import { ARTIFACT_DATA } from "@portifact/contracts/artifact-data";
import { type Refusal, refuse } from "./decision.ts";

/** Every way a command could recreate an author's state, as the barrier rules see it. */
export type BarredPath =
  /** The author's own command of any kind: create, replace, delete, export, connect. */
  | { kind: "own_command" }
  /** Anyone editing a document the author created. */
  | { kind: "edit_created_by" }
  /** A settlement naming the author as the operation's actor. */
  | { kind: "settle" };

/**
 * The barrier's refusal. The author's own commands are refused before their rate row or any other
 * row is written; an edit of a document the author created is a conflict, so no edit recreates
 * the author's sequence; a settlement writes nothing (`settleDecision`).
 */
export function barrierRefusal(path: BarredPath): Refusal {
  if (path.kind === "edit_created_by") {
    return refuse("conflict", "this document's creator is being erased");
  }
  return refuse("forbidden", "this author's data was erased");
}

/** The documents a chunk takes: the request, between one and the cap. */
export function chunkSize(requested: number): number {
  const whole = Number.isFinite(requested) ? Math.trunc(requested) : 1;
  return Math.min(Math.max(whole, 1), ARTIFACT_DATA.caps.eraseChunkDocuments);
}

/** What one chunk found and changed, each part at most `take`. */
export interface ChunkWork {
  documents: number;
  edits: number;
  operations: number;
  rates: number;
  /** The author's own rights rows (one per day they used them). */
  rights: number;
}

/**
 * Whether a chunk must be followed by another: any part that reached `take` may have left more.
 * When none did, the chunk runs the terminal check (`completes`) in the same transaction.
 */
export function chunkLeavesMore(work: ChunkWork, take: number): boolean {
  return (
    work.documents >= take ||
    work.edits >= take ||
    work.operations >= take ||
    work.rates >= take ||
    work.rights >= take
  );
}

/**
 * The terminal condition, checked in the completing chunk's transaction: no document is created
 * or last edited by the author and no rights row of theirs is left. Then the chunk deletes any
 * remaining sequence and count of the author and marks the barrier complete.
 */
export function completes(left: { created: number; edited: number; rights: number }): boolean {
  return left.created === 0 && left.edited === 0 && left.rights === 0;
}
