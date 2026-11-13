// The rules of the jobs that carry lifecycle changes from D1 to the documents object (decision
// 0026, delivery 4): the R2 inventory of objects, the envelope a trusted path builds, what a job
// does after the object refused it, and the limits lifecycle commands carry. The jobs Worker's
// services apply them; nothing here performs I/O.
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  type DataControl,
  type DataEnvelope,
  type DataFence,
  type DataRefusalCode,
  type InventoryEntry,
  MAX_ARTIFACT_BYTES,
  MAX_COLLECTIONS,
  MAX_DOCUMENT_BYTES,
  MAX_INDEXED_FIELDS,
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
 * restore can cause and reconciliation repairs), retry while an earlier fence or an erase's D1
 * repair has yet to land, and done for a fence that can never apply (a transfer to its own
 * owner, another artifact).
 */
export function fenceRefused(
  control: DataControl,
  envelope: DataEnvelope,
  fence: DataFence,
  code: DataRefusalCode,
): JobStep {
  if (code === "conflict") return "done";
  if (code === "held") return "retry";
  if (code !== "stale") return "done";
  if (control.last.id === fence.transition || control.last.epoch >= envelope.epoch) return "done";
  return "retry";
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
 * After the object refused a whole erase or an author erasure chunk: a hold or a quarantine waits,
 * a D1 row behind the object (`stale`) retries once the job that repairs it ran, and anything
 * else (another artifact) is a defect the job must not repeat forever.
 */
export function erasureRefused(code: DataRefusalCode): JobStep {
  if (code === "held" || code === "quarantined") return "wait";
  if (code === "stale" || code === "conflict") return "retry";
  return "done";
}
