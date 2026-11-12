// The author journal (decision 0026, "Author erasure"): one R2 object per account and artifact in
// the artifact's region's bucket, claimed before the first grant's code is issued. A D1 restore
// does not rewind it. Two first grants racing for the same person and artifact create one
// identity: the write is conditional on the object not existing, and the loser reads the
// winner's ID.
//
// The one retention rule: the account deletion job retires the entry first, before any erasure
// chunk runs; a retired entry refuses every claim; it is deleted RETIRED_KEEP_MS after
// retirement, which is longer than any grant or code issued before the deletion can live (30
// days and 60 seconds). After that the account no longer exists in D1 and its ID is never
// reused, so no issuance can name it again.

export const RETIRED_KEEP_MS = 31 * 86_400_000;

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

/** Retires the entry, first thing in the account deletion job, before any erasure chunk. */
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

/** Deletes a retired entry once its retention has passed; anything else is kept. */
export async function pruneRetired(
  bucket: R2Bucket,
  userId: string,
  artifactId: string,
  now: number,
): Promise<boolean> {
  const key = journalKey(userId, artifactId);
  const existing = await bucket.get(key);
  if (existing === null) return false;
  const stored = (await existing.json()) as JournalEntry;
  if (stored.retiredAt === undefined || now - stored.retiredAt < RETIRED_KEEP_MS) return false;
  await bucket.delete(key);
  return true;
}
