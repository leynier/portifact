// Storage accounting (decision 0026, "Storage accounting"): every answer carries the object's
// generation, storage sequence and bytes; the calling Worker keeps the newest report per object.
import type { StorageReport } from "@portifact/contracts/artifact-data";

/** Whether `incoming` replaces `current`: a later generation, or the same and a later sequence. */
export function newerReport(current: StorageReport | null, incoming: StorageReport): boolean {
  if (current === null) return true;
  if (incoming.generation !== current.generation) return incoming.generation > current.generation;
  return incoming.seq > current.seq;
}
