// The author journal (decision 0026, "Erasure"): one R2 object per account and artifact in the
// artifact's region's bucket, written before the first grant's code is issued. A D1 restore does
// not rewind it. Two first grants racing for the same person and artifact create one identity:
// the write is conditional on the object not existing, and the loser reads the winner's ID.

export interface JournalEntry {
  visitorId: string;
  firstGrantAt: number;
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
  return ((await existing.json()) as JournalEntry).visitorId;
}
