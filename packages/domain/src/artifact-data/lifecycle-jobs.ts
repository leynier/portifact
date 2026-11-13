// The rules of the jobs that carry lifecycle changes from D1 to the documents object (decision
// 0026, delivery 4): the R2 inventory of objects, the envelope a trusted path builds, what a job
// does after the object refused it, and the limits lifecycle commands carry. The jobs Worker's
// services apply them; nothing here performs I/O.
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  type DataControl,
  type DataEnvelope,
  type DataRefusalCode,
  type InventoryEntry,
  MAX_ARTIFACT_BYTES,
  MAX_COLLECTIONS,
  MAX_DOCUMENT_BYTES,
  MAX_INDEXED_FIELDS,
  ReviewedQuarantine,
} from "@portifact/contracts/artifact-data";

/** Where the region's bucket lists every object that may hold something. */
export const INVENTORY_PREFIX = "system/data-objects/";
/** Where the region's bucket keeps the author journal (`journalKey`). */
export const JOURNAL_PREFIX = "system/data-authors/";

export function inventoryKey(artifactId: string): string {
  return `${INVENTORY_PREFIX}${artifactId}`;
}

/** The artifact an inventory key names, or null for a key outside the inventory. */
export function inventoryArtifact(key: string): string | null {
  if (!key.startsWith(INVENTORY_PREFIX)) return null;
  const id = key.slice(INVENTORY_PREFIX.length);
  return id.length === 0 || id.includes("/") ? null : id;
}

/** The account and artifact a journal key names, or null for a key outside the journal. */
export function journalSubject(key: string): { userId: string; artifactId: string } | null {
  if (!key.startsWith(JOURNAL_PREFIX)) return null;
  const parts = key.slice(JOURNAL_PREFIX.length).split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  return { userId: parts[0] as string, artifactId: parts[1] as string };
}

/** Where one account's journal entries are listed, in every artifact of the region. */
export function journalPrefixOf(userId: string): string {
  return `${JOURNAL_PREFIX}${userId}/`;
}

/** A new inventory entry, written before anything can bind the object. */
export function inventoryEntry(artifactId: string, region: string, now: number): InventoryEntry {
  return { artifactId, region, createdAt: now };
}

/**
 * The entry once a whole erase that ends the artifact committed: kept, so a restore that brings
 * the artifact's row back still finds the object, until `inventoryPrunable`.
 */
export function inventoryRetired(entry: InventoryEntry, now: number): InventoryEntry {
  return { ...entry, retiredAt: entry.retiredAt ?? now };
}

/** Only a retired entry goes, once no restore can bring its artifact's row back. */
export function inventoryPrunable(entry: InventoryEntry, now: number): boolean {
  return entry.retiredAt !== undefined && now - entry.retiredAt >= ARTIFACT_DATA.inventoryRetiredMs;
}

/**
 * The limits a lifecycle command carries (fences, whole erases, author erasure chunks, the
 * operator's export and quarantine steps). Those commands are charged to `protected`, `cleanup`
 * or the operator's export, which are never refused for an allowance; every command still
 * carries limits the object validates, so these are the platform's caps and allowances no plan
 * reaches. They never reach a document command: only the jobs Worker's lifecycle paths send them.
 */
export const LIFECYCLE_LIMITS: ArtifactDataLimits = {
  bytesPerArtifact: MAX_ARTIFACT_BYTES,
  documentBytes: MAX_DOCUMENT_BYTES,
  documentsPerCollection: Number.MAX_SAFE_INTEGER,
  collections: MAX_COLLECTIONS,
  indexedFields: MAX_INDEXED_FIELDS,
  writesPerAuthorPerMinute: Number.MAX_SAFE_INTEGER,
  deletesPerAuthorPerMinute: Number.MAX_SAFE_INTEGER,
  readsPerCallerPerMinute: Number.MAX_SAFE_INTEGER,
  rowsReadPerDay: Number.MAX_SAFE_INTEGER,
  rowsWrittenPerDay: Number.MAX_SAFE_INTEGER,
  cleanupRowsPerDay: Number.MAX_SAFE_INTEGER,
  exportRowsPerDay: Number.MAX_SAFE_INTEGER,
  rightsRowsPerDay: Number.MAX_SAFE_INTEGER,
  liveMessagesPerDay: 0,
  connectionsPerArtifact: 0,
  connectionsPerAuthor: 0,
  connectsPerAuthorPerMinute: 0,
};

/** What D1 holds about an artifact with data: the numbers its envelopes carry. */
export interface DataRow {
  artifactId: string;
  region: string;
  ownerId: string;
  generation: number;
  epoch: number;
}

/** The envelope of a lifecycle command, from D1's row; no operation ID and no erase reason. */
export function rowEnvelope(row: DataRow): DataEnvelope {
  return {
    artifactId: row.artifactId,
    region: row.region,
    ownerId: row.ownerId,
    generation: row.generation,
    epoch: row.epoch,
  };
}

/**
 * The operator's envelope under a quarantine: what the object itself recorded. Only the operator's
 * paths use it (quarantine, its resolution and the export), after D1 was checked against it.
 */
export function controlEnvelope(control: DataControl): DataEnvelope {
  return {
    artifactId: control.artifactId,
    region: control.region,
    ownerId: control.ownerId,
    generation: control.generation,
    epoch: control.epoch,
  };
}

/**
 * What a job does next:
 * - `done`: the change holds in the object, or it can no longer apply and must not;
 * - `retry`: an earlier change has to land first (another fence, or D1 catching up with an erase
 *   that committed); the job runs again later;
 * - `wait`: the object is held or quarantined; the job waits for the release or the operator.
 */
export type JobStep = "done" | "retry" | "wait";

/**
 * After the object refused a `data_fence`: done when the object is already past this fence (a
 * later transition applied, or this transition ID applied with other contents, which only a
 * restore can cause and reconciliation repairs), or when the fence names a generation the object
 * has left and D1 no longer has the artifact's data row (a purge's erase overtook the fence: it
 * can never apply); retry while an earlier fence or D1's repair after an erase has yet to land;
 * done for a fence that can never apply (a transfer to its own owner, another artifact).
 */
export function fenceRefused(
  control: DataControl,
  envelope: DataEnvelope,
  code: DataRefusalCode,
  evidence: { dataRowGone: boolean },
): JobStep {
  // `conflict` (this transition ID applied with other contents) ends like any code but these two.
  if (code === "held") return "retry";
  if (code !== "stale") return "done";
  if (envelope.generation < control.generation && evidence.dataRowGone) return "done";
  // A repeat of the last transition is acknowledged, never stale, so only the epoch tells.
  return control.last.epoch >= envelope.epoch ? "done" : "retry";
}

/**
 * The epoch a purge's whole erase is sent at. D1 wrote the job in the batch that deleted the
 * artifact, so no fence can follow it in D1 and every fence the object knows is ordered before
 * the purge: the erase takes the object's epoch when that is newer than the one the job read
 * (fences a restore re-applied, or a release that landed while the job waited for it). The owner,
 * the generation and a standing hold are still checked by the object as for any erase step.
 */
export function purgeEraseEpoch(jobEpoch: number, control: DataControl | null): number {
  return control === null ? jobEpoch : Math.max(jobEpoch, control.epoch);
}

/**
 * The target of a purge's whole erase. The epoch is `purgeEraseEpoch`'s. The generation is the
 * one the job read, unless D1 proves the artifact's permanent deletion (its tombstone, and no
 * artifact row left but a purging one): then whatever generation the object is at is erased, as a
 * required erase prepared at that generation, because nothing of a deleted artifact may survive.
 * Without that proof an old generation stays old, and the object answers `superseded`.
 */
export function purgeEraseTarget(
  job: { generation: number; epoch: number },
  control: DataControl | null,
  evidence: { permanentlyDeleted: boolean },
): { generation: number; epoch: number } {
  const epoch = purgeEraseEpoch(job.epoch, control);
  if (control === null || !evidence.permanentlyDeleted)
    return { generation: job.generation, epoch };
  return { generation: control.generation, epoch };
}

/**
 * What a purge's job does with the object's answer. Only a commit of this job's own erase (the
 * commit answered `committed`, or the prepare found its ID already committed) lets the inventory
 * entry be retired and the job end. `superseded` means this old intent cannot act, not that the
 * data is gone: the job keeps its obligation and the operator gets a finding. `cancelled` comes
 * back.
 */
export function purgeAnswered(
  outcome: "prepared" | "committed" | "cancelled" | "superseded",
): "retire" | "superseded" | "retry" {
  if (outcome === "committed") return "retire";
  if (outcome === "superseded") return "superseded";
  return "retry";
}

/**
 * After the object refused a whole erase or an author erasure chunk: a hold or a quarantine waits,
 * a D1 row behind the object (`stale`) retries once the job that repairs it ran, and anything
 * else (another artifact) is a defect the job must not repeat forever.
 */
export function erasureRefused(code: DataRefusalCode): JobStep {
  if (code === "held" || code === "quarantined") return "wait";
  if (code === "stale" || code === "conflict") return "retry";
  return "done";
}

/**
 * The record's first row of the field authority table: an object is followed or resolved only
 * when its inventory key names the artifact its entry names, the entry's region is the job's, the
 * directory (when it has the artifact) puts it in the job's region, and the control record names
 * the same artifact and region. Any disagreement goes to the operator; nothing is followed.
 */
export function identityDisagreement(input: {
  key: string;
  entry: InventoryEntry;
  region: string;
  directoryRegion: string | null;
  control: DataControl;
}): "key" | "inventory_region" | "directory_region" | "control" | null {
  if (inventoryArtifact(input.key) !== input.entry.artifactId) return "key";
  if (input.entry.region !== input.region) return "inventory_region";
  if (input.directoryRegion !== null && input.directoryRegion !== input.region) {
    return "directory_region";
  }
  if (
    input.control.artifactId !== input.entry.artifactId ||
    input.control.region !== input.region
  ) {
    return "control";
  }
  return null;
}

/** The reviewed state as `data-findings` prints it and `data-resolve --state` takes it back. */
export function formatReviewed(state: ReviewedQuarantine): string {
  return [state.reason, state.at, state.ownerId, state.generation, state.epoch].join(":");
}

/** The reviewed state from its printed form, or null when it is not one. */
export function parseReviewed(text: string): ReviewedQuarantine | null {
  const parts = text.split(":");
  if (parts.length !== 5) return null;
  const [reason, at, ownerId, generation, epoch] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const parsed = ReviewedQuarantine.safeParse({
    reason,
    at: Number(at),
    ownerId,
    generation: Number(generation),
    epoch: Number(epoch),
  });
  const numeric = [at, generation, epoch].every((part) => /^[0-9]{1,16}$/.test(part));
  return parsed.success && numeric ? parsed.data : null;
}

/**
 * Where an account's journal scan stands in one region, kept across capped runs: the last key
 * it walked in the current pass, when that pass started, and whether the pass found an entry
 * still to retire.
 */
export interface JournalScan {
  after: string | null;
  passStartedAt: number;
  sawLive: boolean;
}

/**
 * The scan after one listed page. A pass ends at the listing's end; the scan is complete only when
 * a whole pass found nothing left to retire. A scan starts when the account deletion's first run
 * reaches the region, so every pass begins after the deletion was requested. A pass that retired
 * something is followed by another from the start, so an entry written while a pass ran behind
 * its cursor is found by the next one. (Delivery 6's issuance refuses an account being deleted, so
 * after a clean pass no entry appears but a claim already in flight before the deletion, which
 * issuance must check again after its claim.)
 */
export function nextJournalScan(
  scan: JournalScan,
  page: { lastKey: string | null; truncated: boolean; live: number },
  now: number,
): { scan: JournalScan | null; complete: boolean } {
  const sawLive = scan.sawLive || page.live > 0;
  if (page.truncated && page.lastKey !== null) {
    return {
      scan: { after: page.lastKey, passStartedAt: scan.passStartedAt, sawLive },
      complete: false,
    };
  }
  if (!sawLive) return { scan: null, complete: true };
  return { scan: { after: null, passStartedAt: now, sawLive: false }, complete: false };
}
