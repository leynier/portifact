// The author journal's rules (decision 0026, "Author erasure", step 1): one entry per account and
// artifact in the region's bucket, claimed with a conditional put before a grant's code is issued.
// Of two racing first grants one writes and the other reads the winner's visitor ID. The one
// retention rule: the account deletion job retires the entry first, before any erasure chunk; a
// retired entry refuses every claim; it is deleted `journalRetiredMs` after retirement, longer
// than any grant or code issued before the deletion can live.
import { ARTIFACT_DATA, type JournalEntry } from "@portifact/contracts/artifact-data";
import { accept, type Decision, refuse } from "./decision.ts";

export function journalKey(userId: string, artifactId: string): string {
  return `system/data-authors/${userId}/${artifactId}`;
}

/**
 * The visitor ID a claim gets. `existing` is the entry the conditional put lost to (null when the
 * put wrote `candidate`): its ID, unless it was retired.
 */
export function claimOutcome(existing: JournalEntry | null, candidate: string): Decision<string> {
  if (existing === null) return accept(candidate);
  if (existing.retiredAt !== undefined || existing.visitorId === null) {
    return refuse("forbidden", "this account's data in this artifact was erased");
  }
  return accept(existing.visitorId);
}

/**
 * The entry after retirement: kept with its ID, so no claim can revive the person. Where the
 * person never had an entry, a retired entry without an ID is written, so a first grant delayed
 * past the deletion cannot create one.
 */
export function retired(existing: JournalEntry | null, now: number): JournalEntry {
  if (existing === null) return { visitorId: null, firstGrantAt: now, retiredAt: now };
  return { ...existing, retiredAt: existing.retiredAt ?? now };
}

/** Whether an entry may be deleted now: only a retired one, after its retention. */
export function journalPrunable(entry: JournalEntry, now: number): boolean {
  return entry.retiredAt !== undefined && now - entry.retiredAt >= ARTIFACT_DATA.journalRetiredMs;
}
