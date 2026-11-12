// The author journal (decision 0026, "Author erasure"): one R2 object per account and artifact in
// the artifact's region's bucket, claimed before the first grant's code is issued. A D1 restore
// does not rewind it. Two first grants racing for the same person and artifact create one
// identity: the write is conditional on the object not existing, and the loser reads the
// winner's ID. Erasure never deletes the entry: it retires it, and a retired entry refuses every
// later claim, so a grant authorized before the deletion and resumed after it cannot revive the
// person under a fresh ID (finding 8). Account IDs are never reused, so the tombstone is kept.

export interface JournalEntry {
  visitorId: string;
  firstGrantAt: number;
  retiredAt?: number;
}

export class RetiredIdentity extends Error {
  constructor() {
    super("this account's data in this artifact was erased");
  }
}

export function journalKey(userId: string, artifactId: string): string {
  return `system/data-authors/${userId}/${artifactId}`;
}

/** The visitor ID this person has in this artifact: the existing one, or `candidate` if first. */
export async function claimVisitorId(
  bucket: R2Bucket,
  userId: string,
  artifactId: string,
  candidate: string,
  now: number,
): Promise<string> {
  const key = journalKey(userId, artifactId);
  const entry: JournalEntry = { visitorId: candidate, firstGrantAt: now };
  const written = await bucket.put(key, JSON.stringify(entry), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written !== null) return candidate;
  const existing = await bucket.get(key);
  if (existing === null) throw new Error("journal entry vanished");
  const stored = (await existing.json()) as JournalEntry;
  if (stored.retiredAt !== undefined) throw new RetiredIdentity();
  return stored.visitorId;
}

/** Retires the entry after the author's erasure finished; the visitor ID is kept for evidence. */
export async function retireVisitorId(
  bucket: R2Bucket,
  userId: string,
  artifactId: string,
  now: number,
): Promise<void> {
  const key = journalKey(userId, artifactId);
  const existing = await bucket.get(key);
  const stored: JournalEntry =
    existing === null
      ? { visitorId: "", firstGrantAt: now }
      : ((await existing.json()) as JournalEntry);
  await bucket.put(key, JSON.stringify({ ...stored, retiredAt: now }));
}
