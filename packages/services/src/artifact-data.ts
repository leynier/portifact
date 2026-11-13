// Artifact data's lifecycle (decision 0026, delivery 4, second half): how D1's changes reach each
// artifact's documents object. A hold, its release and a transfer raise `artifact_data.epoch`
// and write a `data_fence` job in their own batch; a purge (which is also how an account's or a
// workspace's deletion ends its artifacts) writes a `data_erase` job from the row it deletes; an
// account deletion retires the account's author journal entries and writes a
// `data_author_erasure` job for each. After a D1 restore the operator writes a `data_reconcile`
// job per region, which walks the R2 inventory against D1 by the record's field authority table,
// and resolves quarantines with `data_resolve` and exports with `data_export`. Every job is
// idempotent under at-least-once delivery, and the object decides every rule (`admit`, the fences
// and erase steps); these functions only order the systems and read the object's answers.
//
// Nothing here creates an object while artifact data is switched off (`createsObjects`): a job
// whose object holds no control record has nothing to fence or erase and ends.
import {
  DataAuthorErasurePayload as AuthorErasurePayload,
  type DataAuthorErasurePayload,
  DataErasePayload,
  DataExportPayload,
  DataFencePayload,
  DataReconcilePayload,
  DataResolvePayload,
  isWorkspaceId,
} from "@portifact/contracts";
import {
  type DataControl,
  type DataEnvelope,
  type DataFence,
  type DataRefusalCode,
  type ExportCursor,
  InventoryEntry,
  type JournalEntry,
  JournalEntry as JournalEntrySchema,
  type LifecycleEnvelope,
  type QuarantineReason,
  type QuarantineResolutionRequest,
  type RequiredErase,
  type ReviewedQuarantine,
  type StorageReport,
} from "@portifact/contracts/artifact-data";
import { bothSides, type Db, type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import { logEvent } from "@portifact/domain";
import {
  controlEnvelope,
  erasureRefused,
  fenceRefused,
  formatReviewed,
  INVENTORY_PREFIX,
  identityDisagreement,
  inventoryArtifact,
  inventoryEntry,
  inventoryKey,
  inventoryPrunable,
  inventoryRetired,
  JOURNAL_PREFIX,
  type JobStep,
  type JournalScan,
  journalKey,
  journalPrefixOf,
  journalPrunable,
  journalSubject,
  nextJournalScan,
  purgeAnswered,
  purgeEraseEpoch,
  purgeEraseTarget,
  reconcile,
  retired,
  reviewedState,
  rowEnvelope,
} from "@portifact/domain/artifact-data";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isHeld, openHold } from "./legal-holds.ts";

/** What the object answers a lifecycle command (the store's `Answer`, as RPC carries it). */
export type DataAnswer<T> =
  | { ok: true; value: T; storage: StorageReport }
  | { ok: false; code: DataRefusalCode; message: string; storage: StorageReport };

/** An answer that may be a replay of a recorded operation (author erasure chunks). */
export type DataReplayable<T> =
  | DataAnswer<T>
  | { ok: true; replayed: unknown; storage: StorageReport };

interface ExportedRow {
  collection: string;
  id: string;
  [field: string]: unknown;
}

/**
 * The documents object's lifecycle interface (`ArtifactDocuments` in apps/data): the methods the
 * jobs Worker may call. Every argument is parsed again on the object's side.
 */
export interface DataObjectRpc {
  lifecycleControl(): Promise<DataControl | null>;
  lifecycleFence(
    envelope: LifecycleEnvelope,
    fence: DataFence,
    now: number,
  ): Promise<DataAnswer<{ epoch: number; held: boolean; ownerId: string }>>;
  lifecycleErase(
    step: "prepare" | "commit" | "cancel",
    envelope: LifecycleEnvelope,
    eraseId: string,
    reason: RequiredErase,
    now: number,
  ): Promise<DataAnswer<{ outcome: "prepared" | "committed" | "cancelled" | "superseded" }>>;
  lifecycleEraseAuthor(
    envelope: LifecycleEnvelope,
    visitorId: string,
    opId: string,
    now: number,
  ): Promise<DataReplayable<{ documents: number; edits: number; more: boolean }>>;
  lifecycleQuarantine(
    envelope: LifecycleEnvelope,
    reason: QuarantineReason,
    now: number,
  ): Promise<DataAnswer<boolean>>;
  lifecycleResolve(
    envelope: LifecycleEnvelope,
    request: QuarantineResolutionRequest,
    now: number,
  ): Promise<DataAnswer<{ repeated: boolean }>>;
  lifecycleExport(
    envelope: LifecycleEnvelope,
    after: ExportCursor | null,
    now: number,
  ): Promise<DataAnswer<{ rows: ExportedRow[]; next: ExportCursor | null; revision: number }>>;
}

/** The objects of one region, as a job reaches them. */
export interface DataObjects {
  /** The region, as envelopes and the inventory name it. */
  region: string;
  object(artifactId: string): DataObjectRpc;
  /**
   * Whether a lifecycle command may bind an object that holds no control record yet. False while
   * `ARTIFACT_DATA_ENABLED` is off: nothing creates an object before the switch (decision 0026,
   * "Switches"), so export and erasure answer empty on a missing object.
   */
  createsObjects: boolean;
}

export interface DataEnv {
  ARTIFACT_DOCUMENTS?: DurableObjectNamespace | undefined;
  ARTIFACT_DATA_ENABLED?: string | undefined;
}

/**
 * The only place a stub is made (decision 0026, "One object"): named by the artifact ID, in the
 * EU jurisdiction for the `eu` region and with a western North America hint for the default one,
 * from the region the job runs in (the directory's). Null without the binding.
 */
export function dataNamespaces(env: DataEnv, region: string): DataObjects | null {
  const namespace = env.ARTIFACT_DOCUMENTS;
  if (namespace === undefined) return null;
  const options: DurableObjectNamespaceGetDurableObjectOptions | undefined =
    region === "default" ? { locationHint: "wnam" } : undefined;
  return {
    region,
    createsObjects: env.ARTIFACT_DATA_ENABLED === "true",
    object(artifactId) {
      // Scoped per call: only a job that reaches an object asks for the jurisdiction (workerd,
      // where the tests run, does not implement them).
      const scoped = region === "eu" ? namespace.jurisdiction("eu") : namespace;
      return scoped.get(scoped.idFromName(artifactId), options) as unknown as DataObjectRpc;
    },
  };
}

/** A new operation or erase ID: its issue time and a random part (the object's ID form). */
export function lifecycleId(now: number): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const random = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${String(Math.floor(now)).padStart(13, "0")}.${random}`;
}

// D1's side.

const d = schema.artifactData;
const a = schema.artifacts;

/** D1's row for an artifact with data, its owner from the artifact, or null. */
export async function readDataRow(
  db: RegionalDb,
  region: string,
  artifactId: string,
): Promise<{
  artifactId: string;
  region: string;
  ownerId: string;
  generation: number;
  epoch: number;
} | null> {
  const [row] = await db
    .select({ ownerId: a.ownerId, generation: d.generation, epoch: d.epoch })
    .from(d)
    .innerJoin(a, eq(a.id, d.artifactId))
    .where(eq(d.artifactId, artifactId))
    .limit(1);
  return row ? { artifactId, region, ...row } : null;
}

/**
 * The statements a hold, a release or a transfer adds to its own batch, after its guard and on
 * the same condition: raise the epoch, then write the `data_fence` job from the row as raised, so
 * the job exists exactly when the change does. An artifact without data gets neither.
 * `fence(alias)` builds the fence's JSON from the selected rows; `owner` is the owner the object
 * knows (the old one for a transfer).
 */
export function dataFenceStatements(
  db: Db,
  input: {
    /** Selects the artifacts, as SQL over `artifact_data` (aliased `d`). */
    which: ReturnType<typeof sql>;
    fence: ReturnType<typeof sql>;
    owner: ReturnType<typeof sql>;
    /** Extra tables the selection joins, with their join conditions. */
    from?: ReturnType<typeof sql>;
    now: number;
  },
) {
  const from = input.from ?? sql``;
  return [
    db
      .update(d)
      .set({ epoch: sql`${d.epoch} + 1`, updatedAt: input.now })
      .where(
        sql`${d.artifactId} in (select d.artifact_id from ${d} d ${from} where ${input.which})`,
      ),
    // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
    // subject, generation.
    db
      .insert(schema.outbox)
      .select(
        sql`select null, 'data_fence', json_object('ownerId', ${input.owner}, 'generation', d.generation, 'epoch', d.epoch, 'fence', ${input.fence}), ${input.now}, null, 0, ${input.now}, d.artifact_id, null from ${d} d join ${a} da on da.id = d.artifact_id ${from} where ${input.which}`,
      ),
  ];
}

/**
 * The `data_erase` job a purge writes in the batch that deletes the artifact, from the row the
 * delete takes with it, on the same condition.
 */
export function dataEraseJob(
  db: Db,
  artifactId: string,
  condition: ReturnType<typeof sql>,
  now: number,
) {
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'data_erase', json_object('ownerId', da.owner_id, 'generation', d.generation, 'epoch', d.epoch), ${now}, null, 0, ${now}, d.artifact_id, null from ${d} d join ${a} da on da.id = d.artifact_id where d.artifact_id = ${artifactId} and ${condition}`,
    );
}

/** Keeps the newest storage report a caller received (`newerReport`: generation, then sequence). */
export async function recordStorageReport(
  db: RegionalDb,
  artifactId: string,
  report: StorageReport,
  now: number,
): Promise<void> {
  await db
    .update(d)
    .set({
      documentsBytes: report.bytes,
      reportGeneration: report.generation,
      reportSeq: report.seq,
      updatedAt: now,
    })
    .where(
      and(
        eq(d.artifactId, artifactId),
        sql`(${d.reportGeneration} < ${report.generation} or (${d.reportGeneration} = ${report.generation} and ${d.reportSeq} < ${report.seq}))`,
      ),
    );
}

/** Why a whole erase is required: the owner's deletion, or a purge on its own. */
export async function eraseReason(global: GlobalDb, ownerId: string): Promise<RequiredErase> {
  const t = schema.tombstones;
  if (isWorkspaceId(ownerId)) {
    const [pending] = await global
      .select({ id: schema.workspaceDeletions.workspaceId })
      .from(schema.workspaceDeletions)
      .where(eq(schema.workspaceDeletions.workspaceId, ownerId))
      .limit(1);
    const [gone] = await global
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.kind, "workspace"), eq(t.id, ownerId)))
      .limit(1);
    return pending || gone ? "workspace_deletion" : "purge";
  }
  const [pending] = await global
    .select({ id: schema.accountDeletions.userId })
    .from(schema.accountDeletions)
    .where(eq(schema.accountDeletions.userId, ownerId))
    .limit(1);
  const [gone] = await global
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.kind, "account"), eq(t.id, ownerId)))
    .limit(1);
  return pending || gone ? "account_deletion" : "purge";
}

// R2's side: the inventory and the journal, in the region's bucket.

async function readJson<T>(bucket: R2Bucket, key: string, parse: (value: unknown) => T) {
  const object = await bucket.get(key);
  if (object === null) return null;
  return { value: parse(await object.json()), etag: object.etag };
}

/**
 * Registers an artifact's object before anything can bind it: the R2 inventory entry first (a
 * conditional put; a restore never rewinds it, so reconciliation always finds the object), then
 * D1's row. A crash between leaves an entry without a row, which reconciliation reads as an object
 * with no control record (nothing to do). The owner API's first write calls it (delivery 5).
 */
export async function registerDataObject(
  db: RegionalDb,
  bucket: R2Bucket,
  region: string,
  artifactId: string,
  now: number,
): Promise<void> {
  await bucket.put(
    inventoryKey(artifactId),
    JSON.stringify(inventoryEntry(artifactId, region, now)),
    {
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
  await db
    .insert(d)
    .values({ artifactId, generation: 0, epoch: 0, updatedAt: now })
    .onConflictDoNothing();
}

/**
 * Marks an artifact's inventory entry retired once its whole erase committed: a write conditional
 * on the entry it read (or on there being none), retried on a race, so the first retirement is
 * the one kept, whichever delivery made it.
 */
async function retireInventory(bucket: R2Bucket, region: string, artifactId: string, now: number) {
  const key = inventoryKey(artifactId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const found = await readJson(bucket, key, (value) => InventoryEntry.parse(value));
    if (found?.value.retiredAt !== undefined) return;
    const entry = found?.value ?? inventoryEntry(artifactId, region, now);
    const written = await bucket.put(key, JSON.stringify(inventoryRetired(entry, now)), {
      onlyIf: found === null ? { etagDoesNotMatch: "*" } : { etagMatches: found.etag },
    });
    if (written !== null) return;
  }
  throw new Error("inventory entry kept changing while it was retired");
}

/**
 * Retires an account's journal entry in one artifact, so no claim can revive the person (the
 * record's one retention rule); an absent entry is written retired without an ID. Conditional on
 * what was read, so a racing claim either lands first and is retired, or loses.
 */
export async function retireJournalEntry(
  bucket: R2Bucket,
  userId: string,
  artifactId: string,
  now: number,
): Promise<JournalEntry> {
  const key = journalKey(userId, artifactId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const found = await readJson(bucket, key, (value) => JournalEntrySchema.parse(value));
    if (found?.value.retiredAt !== undefined) return found.value;
    const next = retired(found?.value ?? null, now);
    const written = await bucket.put(key, JSON.stringify(next), {
      onlyIf: found === null ? { etagDoesNotMatch: "*" } : { etagMatches: found.etag },
      // Listed with the key, so a walk skips retired entries without reading each one.
      customMetadata: { retired: "1" },
    });
    if (written !== null) return next;
  }
  throw new Error("journal entry kept changing while it was retired");
}

/** One `data_author_erasure` job for an account in an artifact, unless one is already waiting. */
function authorErasureJob(
  db: Db,
  artifactId: string,
  payload: DataAuthorErasurePayload,
  now: number,
) {
  const o = schema.outbox;
  return db
    .insert(o)
    .select(
      sql`select null, 'data_author_erasure', json_object('userId', ${payload.userId}, 'visitorId', ${payload.visitorId}), ${now}, null, 0, ${now}, ${artifactId}, null where not exists (select 1 from ${o} where ${o.topic} = 'data_author_erasure' and ${o.subject} = ${artifactId} and json_extract(${o.payload}, '$.userId') = ${payload.userId})`,
    );
}

/** Journal entries one call retires at most, per region. */
const JOURNAL_BATCH = 100;
/** Keys one call lists: one page per call, so an account with no entries costs one list. */
const JOURNAL_PAGE = 1000;

const scanName = (userId: string) => `data_journal:${userId}`;

/**
 * An account deletion's part in one region: every journal entry of the account that is not yet
 * retired gets its `data_author_erasure` job, then is retired. The job comes first, so a crash
 * between leaves an entry the next run finds again; the job retires it too before any chunk.
 * Retired entries carry `retired` in their metadata, so the walk skips them from the listing.
 * One page is listed per call, from where the last call stopped (a `maintenance_cursors` row per
 * account and region); `nextJournalScan` decides when the scan is complete: a whole pass begun
 * after the deletion was requested that found nothing left to retire. `more` until then.
 */
export async function scheduleAuthorErasures(
  db: RegionalDb,
  bucket: R2Bucket,
  userId: string,
  now: number,
): Promise<{ more: boolean; scheduled: number }> {
  const c = schema.maintenanceCursors;
  const name = scanName(userId);
  const [saved] = await db.select().from(c).where(eq(c.name, name)).limit(1);
  const scan: JournalScan = saved
    ? {
        ...(JSON.parse(saved.cursor) as Omit<JournalScan, "passStartedAt">),
        passStartedAt: saved.passStartedAt,
      }
    : { after: null, passStartedAt: now, sawLive: false };
  const listed = await bucket.list({
    prefix: journalPrefixOf(userId),
    limit: JOURNAL_PAGE,
    include: ["customMetadata"],
    ...(scan.after === null ? {} : { startAfter: scan.after }),
  });
  let scheduled = 0;
  let live = 0;
  let lastKey: string | null = null;
  let truncated = listed.truncated;
  for (const object of listed.objects) {
    if (live >= JOURNAL_BATCH) {
      // The batch is full: this page continues next call from the last key retired.
      truncated = true;
      break;
    }
    lastKey = object.key;
    if (object.customMetadata?.retired === "1") continue;
    const subject = journalSubject(object.key);
    if (subject === null || subject.userId !== userId) continue;
    live += 1;
    const found = await readJson(bucket, object.key, (value) => JournalEntrySchema.parse(value));
    if (found !== null && found.value.retiredAt === undefined && found.value.visitorId !== null) {
      await authorErasureJob(
        db,
        subject.artifactId,
        { userId, visitorId: found.value.visitorId },
        now,
      );
      scheduled += 1;
    }
    await retireJournalEntry(bucket, userId, subject.artifactId, now);
  }
  const next = nextJournalScan(scan, { lastKey, truncated, live }, now);
  if (next.scan === null) {
    await db.delete(c).where(eq(c.name, name));
  } else {
    await saveJournalScan(db, userId, next.scan, now);
  }
  return { more: !next.complete, scheduled };
}

/**
 * Saves an account's scan position only while the account's deletion is still pending, so a
 * stalled scan that returns after the deletion ended never leaves a row naming the account. With
 * one database the condition is in the statements themselves (`bothSides`); with a separate one
 * the deletion row is read globally first, and the maintenance prune (`pruneJournalCursors`)
 * removes what a race between that read and the write leaves.
 */
async function saveJournalScan(db: RegionalDb, userId: string, scan: JournalScan, now: number) {
  const c = schema.maintenanceCursors;
  const ad = schema.accountDeletions;
  const name = scanName(userId);
  const { passStartedAt, ...rest } = scan;
  const cursor = JSON.stringify(rest);
  const both = bothSides(db);
  if (both) {
    const pending = sql`exists (select 1 from ${ad} where ${ad.userId} = ${userId})`;
    await both.batch([
      both
        .update(c)
        .set({ cursor, passStartedAt, updatedAt: now })
        .where(and(eq(c.name, name), pending)),
      // Columns in schema order: name, cursor, pass started at, updated at.
      both
        .insert(c)
        .select(
          sql`select ${name}, ${cursor}, ${passStartedAt}, ${now} where ${pending} and not exists (select 1 from ${c} where ${c.name} = ${name})`,
        ),
    ]);
    return;
  }
  const [pending] = await db.global
    .select({ userId: ad.userId })
    .from(ad)
    .where(eq(ad.userId, userId))
    .limit(1);
  if (!pending) return;
  await db
    .insert(c)
    .values({ name, cursor, passStartedAt, updatedAt: now })
    .onConflictDoUpdate({ target: c.name, set: { cursor, passStartedAt, updatedAt: now } });
}

/** Leftover scan positions one maintenance run looks at most, per region. */
const JOURNAL_CURSOR_PRUNE = 50;

/**
 * Removes account scan positions whose account deletion is no longer pending (finished, or
 * withdrawn by a restore): a scan resumes only while its deletion runs, so such a row is a
 * leftover of a late scan and names an account that may be gone. Bounded per run.
 */
export async function pruneJournalCursors(db: RegionalDb): Promise<number> {
  const c = schema.maintenanceCursors;
  const ad = schema.accountDeletions;
  const rows = await db
    .select({ name: c.name })
    .from(c)
    .where(sql`${c.name} like 'data_journal:%'`)
    .limit(JOURNAL_CURSOR_PRUNE);
  if (rows.length === 0) return 0;
  const users = rows.map((row) => row.name.slice("data_journal:".length));
  const pending = new Set(
    (await db.global.select({ userId: ad.userId }).from(ad).where(inArray(ad.userId, users))).map(
      (row) => row.userId,
    ),
  );
  const gone = rows.filter((row) => !pending.has(row.name.slice("data_journal:".length)));
  if (gone.length === 0) return 0;
  await db.delete(c).where(
    inArray(
      c.name,
      gone.map((row) => row.name),
    ),
  );
  return gone.length;
}

/** The statement that removes an account's scan positions, for the deletion's last batch. */
export function deleteJournalCursor(db: Db, userId: string, condition: ReturnType<typeof sql>) {
  const c = schema.maintenanceCursors;
  return db.delete(c).where(and(eq(c.name, scanName(userId)), condition));
}

// The jobs.

/** A job's outcome, as `runJob` reads it. */
export type DataJobOutcome = "done" | "stale" | "pending" | "kept";

/** A held or quarantined object waits this long before the job is tried again. */
export const DATA_JOB_WAIT_MS = 86_400_000;
/** How long a purge waits before preparing a new erase ID after its intent was cancelled. */
export const DATA_ERASE_FRESH_MS = 60_000;
/** Author erasure chunks one job run sends at most before it gives the queue back. */
export const AUTHOR_CHUNKS_PER_RUN = 8;

type OutboxRow = typeof schema.outbox.$inferSelect;

/** Moves the job's own row to `at` with a new payload (the relay sends it again then). */
async function keep(db: Db, row: OutboxRow, at: number, payload?: unknown): Promise<"kept"> {
  await db
    .update(schema.outbox)
    .set({
      availableAt: at,
      dispatchedAt: null,
      ...(payload === undefined ? {} : { payload }),
    })
    .where(eq(schema.outbox.id, row.id));
  return "kept";
}

async function afterRefusal(
  db: Db,
  row: OutboxRow,
  step: JobStep,
  reason: DataRefusalCode,
  now: number,
): Promise<DataJobOutcome> {
  // A refusal that ends the job is worth a look; one that waits or retries is expected.
  if (step === "done")
    logEvent("warn", "data_job_refused", { id: row.id, topic: row.topic, reason });
  else logEvent("log", "data_job_refused", { id: row.id, topic: row.topic, reason });
  if (step === "wait") return keep(db, row, now + DATA_JOB_WAIT_MS);
  return step === "retry" ? "pending" : "stale";
}

function needs(objects: DataObjects | null | undefined, topic: string): DataObjects {
  // Thrown, not reported done: the row stays and the job runs again where the binding is.
  if (!objects) throw new Error(`${topic} needs the artifact data binding`);
  return objects;
}

/**
 * A `data_fence` job: tells the object about a hold, a release or a transfer, under the owner it
 * knows and the epoch D1 raised, at D1's current generation. Done once the object acknowledged it
 * or is already past it (`fenceRefused`); retried while an earlier change has to land first.
 */
export async function runDataFence(
  db: RegionalDb,
  data: DataObjects | null | undefined,
  row: OutboxRow,
  now: number,
): Promise<DataJobOutcome> {
  const objects = needs(data, "data_fence");
  const payload = DataFencePayload.parse(row.payload);
  const artifactId = row.subject ?? "";
  const object = objects.object(artifactId);
  const control = await object.lifecycleControl();
  if (control === null && !objects.createsObjects) return "done";
  const current = await readDataRow(db, objects.region, artifactId);
  const envelope: DataEnvelope = {
    artifactId,
    region: objects.region,
    ownerId: payload.ownerId,
    generation: current?.generation ?? payload.generation,
    epoch: payload.epoch,
  };
  const answer = await object.lifecycleFence(envelope, payload.fence, now);
  if (answer.ok) return "done";
  const after = await object.lifecycleControl();
  const step =
    after === null
      ? "retry"
      : fenceRefused(after, envelope, answer.code, {
          dataRowGone: current === null,
          stillWanted: await fenceStillWanted(db, artifactId, payload.fence, after),
        });
  if (step !== "reissue" || after === null || current === null) {
    return afterRefusal(db, row, step, answer.code, now);
  }
  // Another transition took this fence's epoch while D1 still wants its change: a new epoch from
  // D1, past both D1's and the object's, taken only from the epoch read, then the same fence.
  const [raised] = await db
    .update(d)
    .set({ epoch: sql`max(${d.epoch}, ${after.epoch}) + 1`, updatedAt: now })
    .where(and(eq(d.artifactId, artifactId), eq(d.epoch, current.epoch)))
    .returning({ epoch: d.epoch });
  if (!raised) return "pending";
  await db
    .update(schema.outbox)
    .set({ payload: { ...payload, epoch: raised.epoch } })
    .where(eq(schema.outbox.id, row.id));
  const again = await object.lifecycleFence(
    { ...envelope, epoch: raised.epoch },
    payload.fence,
    now,
  );
  return again.ok ? "done" : "pending";
}

/**
 * Whether D1 still wants a refused fence's change, from D1's own rows and the object's state: a
 * hold whose D1 row is still open and that the object lacks, a release of the hold the object
 * still has and D1 closed, a transfer to the owner D1 names and the object does not.
 */
async function fenceStillWanted(
  db: RegionalDb,
  artifactId: string,
  fence: DataFence,
  control: DataControl,
): Promise<boolean> {
  const h = schema.legalHolds;
  if (fence.kind === "hold") {
    if (control.hold !== null) return false;
    const open = await openHold(db, artifactId);
    return open?.id === fence.transition;
  }
  if (fence.kind === "release") {
    const holdId = fence.transition.replace(/:release$/, "");
    if (control.hold?.transition !== holdId) return false;
    const [closed] = await db
      .select({ id: h.id })
      .from(h)
      .where(and(eq(h.id, holdId), sql`${h.releasedAt} is not null`))
      .limit(1);
    return closed !== undefined && (await openHold(db, artifactId)) === undefined;
  }
  if (fence.kind === "transfer") {
    if (control.ownerId === fence.toOwner) return false;
    const [artifact] = await db
      .select({ ownerId: a.ownerId })
      .from(a)
      .where(eq(a.id, artifactId))
      .limit(1);
    return artifact?.ownerId === fence.toOwner;
  }
  return false;
}

/**
 * Whether D1 proves an artifact's permanent deletion: its tombstone, and no row of it left but a
 * purging one (the evidence `purgeEraseTarget` needs to erase whatever generation the object is at).
 */
export async function permanentlyDeleted(db: RegionalDb, artifactId: string): Promise<boolean> {
  const t = schema.tombstones;
  const [tombstone] = await db.global
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.kind, "artifact"), eq(t.id, artifactId)))
    .limit(1);
  if (!tombstone) return false;
  const [artifact] = await db
    .select({ state: a.state })
    .from(a)
    .where(eq(a.id, artifactId))
    .limit(1);
  return artifact === undefined || artifact.state === "purging";
}

/**
 * A `data_erase` job: the whole erase a purge requires, prepared and committed under one erase
 * ID (a prepared one is resumed under its own ID whatever its age), at the target
 * `purgeEraseTarget` gives (the object's own generation once D1 proves the permanent deletion).
 * The inventory entry is retired only when the object confirms this erase committed
 * (`purgeAnswered`); `superseded` keeps the entry and the job, with a finding for the operator. A
 * held or quarantined object waits; the erase is never skipped.
 */
export async function runDataErase(
  db: RegionalDb,
  bucket: R2Bucket,
  data: DataObjects | null | undefined,
  row: OutboxRow,
  now: number,
): Promise<DataJobOutcome> {
  const objects = needs(data, "data_erase");
  const payload = DataErasePayload.parse(row.payload);
  const artifactId = row.subject ?? "";
  const object = objects.object(artifactId);
  const control = await object.lifecycleControl();
  if (control === null && !objects.createsObjects) {
    await retireInventory(bucket, objects.region, artifactId, now);
    return "done";
  }
  const deleted = await permanentlyDeleted(db, artifactId);
  const target = purgeEraseTarget(payload, control, { permanentlyDeleted: deleted });
  const envelope: DataEnvelope = {
    artifactId,
    region: objects.region,
    ownerId: payload.ownerId,
    ...target,
  };
  const reason = await eraseReason(db.global, payload.ownerId);
  // A prepared erase is resumed under its own ID; otherwise this job's own, kept in its row before
  // the first prepare, so a retry after a crash past the commit sees its erase committed.
  const eraseId = control?.erasing?.id ?? payload.eraseId ?? lifecycleId(now);
  if (payload.eraseId !== eraseId) {
    await db
      .update(schema.outbox)
      .set({ payload: { ...payload, eraseId } })
      .where(eq(schema.outbox.id, row.id));
  }
  const prepared = await object.lifecycleErase("prepare", envelope, eraseId, reason, now);
  if (!prepared.ok && prepared.code === "conflict" && control?.erasing === null) {
    // This job's ID can no longer start an intent (past the horizon, its record pruned): the next
    // run starts a fresh one.
    await db
      .update(schema.outbox)
      .set({ payload: { ...payload, eraseId: lifecycleId(now) } })
      .where(eq(schema.outbox.id, row.id));
    return "pending";
  }
  if (!prepared.ok) return afterRefusal(db, row, erasureRefused(prepared.code), prepared.code, now);
  let outcome = prepared.value.outcome;
  if (outcome === "prepared") {
    const committed = await object.lifecycleErase("commit", envelope, eraseId, reason, now);
    if (!committed.ok) {
      return afterRefusal(db, row, erasureRefused(committed.code), committed.code, now);
    }
    outcome = committed.value.outcome;
  }
  const next = purgeAnswered(outcome);
  if (next === "fresh") {
    // This ID's intent was cancelled (a hold ended it): terminal for the ID. With no other intent
    // prepared, the purge goes on under a new ID after a short wait; with one, it resumes that.
    const latest = await object.lifecycleControl();
    if (latest?.erasing) return "pending";
    return keep(db, row, now + DATA_ERASE_FRESH_MS, { ...payload, eraseId: lifecycleId(now) });
  }
  if (next === "retry") return "pending";
  if (next === "superseded") {
    await recordFinding(db, artifactId, "superseded", null, now);
    return keep(db, row, now + DATA_JOB_WAIT_MS);
  }
  await retireInventory(bucket, objects.region, artifactId, now);
  return "done";
}

/**
 * A `data_author_erasure` job: retires the account's journal entry in the artifact (first, before
 * any chunk), then sends bounded erasure chunks until the object answers that nothing is left.
 * The object is read whatever D1 holds: a missing `artifact_data` row is no proof the object is
 * gone (a restore can lose it). Only an absent object ends the job without a chunk; one D1 has no
 * row for is erased under its own identity (erasure only removes the person's data), and a
 * quarantined or held one keeps the job waiting until its resolution or release wakes it.
 */
export async function runDataAuthorErasure(
  db: RegionalDb,
  bucket: R2Bucket,
  data: DataObjects | null | undefined,
  row: OutboxRow,
  now: number,
): Promise<DataJobOutcome> {
  const objects = needs(data, "data_author_erasure");
  const payload = AuthorErasurePayload.parse(row.payload);
  const artifactId = row.subject ?? "";
  await retireJournalEntry(bucket, payload.userId, artifactId, now);
  const object = objects.object(artifactId);
  const control = await object.lifecycleControl();
  const current = await readDataRow(db, objects.region, artifactId);
  if (control === null && (current === null || !objects.createsObjects)) return "done";
  const envelope =
    current !== null ? rowEnvelope(current) : controlEnvelope(control as DataControl);
  for (let chunk = 0; chunk < AUTHOR_CHUNKS_PER_RUN; chunk += 1) {
    const answer = await object.lifecycleEraseAuthor(
      envelope,
      payload.visitorId,
      lifecycleId(now),
      now,
    );
    if (!answer.ok) return afterRefusal(db, row, erasureRefused(answer.code), answer.code, now);
    if (current !== null) await recordStorageReport(db, artifactId, answer.storage, now);
    if ("value" in answer && !answer.value.more) return "done";
  }
  return keep(db, row, now);
}

async function recordFinding(
  db: RegionalDb,
  artifactId: string,
  action: (typeof schema.DATA_FINDING_ACTIONS)[number],
  reason: string | null,
  now: number,
  options: {
    /** Keeps the action an existing finding holds, only marking it seen again. */
    keepAction?: boolean;
    /** The quarantined state the operator resolves against, when it is known. */
    state?: ReviewedQuarantine | null;
  } = {},
): Promise<void> {
  const state =
    options.state === undefined
      ? {}
      : { state: options.state === null ? null : formatReviewed(options.state) };
  await db
    .insert(schema.dataFindings)
    .values({ artifactId, action, reason, firstSeenAt: now, lastSeenAt: now, ...state })
    .onConflictDoUpdate({
      target: schema.dataFindings.artifactId,
      set: options.keepAction
        ? { lastSeenAt: now, ...state }
        : { action, reason, lastSeenAt: now, ...state },
    });
}

/** Inventory entries one reconciliation run walks at most. */
const RECONCILE_PAGE = 50;

/**
 * Reconciles one object after a restore (decision 0026, "Restore", the field authority table).
 * First the artifact and region: the inventory key against its entry, the entry's region and the
 * directory's against the job's, the control record's identity against them; any disagreement is
 * an operator finding and nothing is followed. Then D1's row (its owner from the artifact, the
 * hold from the re-applied holds) against the object's control record, applying `reconcile`'s
 * answer and recording it, with the quarantined state the operator resolves against.
 */
export async function reconcileObject(
  db: RegionalDb,
  objects: DataObjects,
  entry: InventoryEntry,
  now: number,
  key = inventoryKey(entry.artifactId),
): Promise<string> {
  const artifactId = entry.artifactId;
  const object = objects.object(artifactId);
  const control = await object.lifecycleControl();
  if (control === null) return "none";
  const ad = schema.artifactDirectory;
  const [directory] = await db.global
    .select({ region: ad.region })
    .from(ad)
    .where(eq(ad.id, artifactId))
    .limit(1);
  const disagreement = identityDisagreement({
    key,
    entry,
    region: objects.region,
    directoryRegion: directory?.region ?? null,
    control,
  });
  if (disagreement !== null) {
    await recordFinding(db, artifactId, "identity_mismatch", disagreement, now);
    return `operator:${disagreement}`;
  }
  const current = await readDataRow(db, objects.region, artifactId);
  // A purged artifact's object: its own erase committed before the entry was retired.
  if (current === null && entry.retiredAt !== undefined) return "none";
  const decision = reconcile(
    current === null
      ? null
      : {
          ownerId: current.ownerId,
          generation: current.generation,
          epoch: current.epoch,
          held: await isHeld(db, artifactId),
        },
    control,
  );
  switch (decision.action) {
    case "none":
      return "none";
    case "operator":
      // A quarantine an earlier run recorded keeps its finding, only marked seen again.
      await recordFinding(
        db,
        artifactId,
        "awaiting_operator",
        control.quarantine?.reason ?? null,
        now,
        {
          keepAction: true,
          state: reviewedState(control),
        },
      );
      return "operator";
    case "quarantine": {
      // The finding first: a run that stops after the quarantine leaves the operator's line,
      // and the next run, finding the quarantine, records its state.
      await recordFinding(db, artifactId, "quarantined", decision.reason, now);
      const answer = await object.lifecycleQuarantine(
        controlEnvelope(control),
        decision.reason,
        now,
      );
      if (!answer.ok) throw new Error(`quarantine refused: ${answer.code}`);
      const after = await object.lifecycleControl();
      await recordFinding(db, artifactId, "quarantined", decision.reason, now, {
        state: after === null ? null : reviewedState(after),
      });
      return `quarantine:${decision.reason}`;
    }
    case "raise":
      await recordFinding(db, artifactId, "raised", null, now);
      await raiseRow(db, artifactId, current, decision.generation, decision.epoch, now);
      return "raise";
    case "resume_erase": {
      if (current === null) return "none";
      const reason = await eraseReason(db.global, current.ownerId);
      const envelope = {
        ...controlEnvelope(control),
        generation: decision.generation,
        epoch: decision.epoch,
      };
      const answer = await object.lifecycleErase("commit", envelope, decision.eraseId, reason, now);
      if (!answer.ok) {
        await recordFinding(db, artifactId, "refused", answer.code, now);
        return `refused:${answer.code}`;
      }
      // D1 follows the object as it now is: the same raise a later run would make if this one
      // stopped here, so a crash between the commit and D1 changes nothing.
      await recordFinding(db, artifactId, "resumed_erase", null, now);
      await followObject(db, object, current, now);
      return "resume_erase";
    }
  }
}

/**
 * Raises D1 to the object after a step that moved it (a resumed erase): reconciliation's own
 * raise, from the control record read again, so D1 is never ahead of what the object holds.
 */
async function followObject(
  db: RegionalDb,
  object: DataObjectRpc,
  read: { ownerId: string; generation: number; epoch: number; artifactId: string },
  now: number,
): Promise<void> {
  const after = await object.lifecycleControl();
  const held = await isHeld(db, read.artifactId);
  const decision = reconcile({ ...read, held }, after);
  if (decision.action === "raise") {
    await raiseRow(db, read.artifactId, read, decision.generation, decision.epoch, now);
  }
}

/** Raises D1's numbers only from the values it read, so a racing change keeps its own. */
async function raiseRow(
  db: RegionalDb,
  artifactId: string,
  read: { generation: number; epoch: number } | null,
  generation: number,
  epoch: number,
  now: number,
): Promise<void> {
  if (read === null) return;
  await db
    .update(d)
    .set({ generation, epoch, updatedAt: now })
    .where(
      and(eq(d.artifactId, artifactId), eq(d.generation, read.generation), eq(d.epoch, read.epoch)),
    );
}

/**
 * A `data_reconcile` job, one per region after a restore: walks the region's inventory, a page per
 * run (`reconcileObject`, pruning entries past their retention), then the journal, re-deriving
 * the author erasures a rewound outbox lost from the retired entries (decision 0026: "never from a
 * rewound outbox") and pruning those past theirs. Resumes from the key it reached.
 */
export async function runDataReconcile(
  db: RegionalDb,
  bucket: R2Bucket,
  data: DataObjects | null | undefined,
  row: OutboxRow,
  now: number,
): Promise<DataJobOutcome> {
  const objects = needs(data, "data_reconcile");
  const payload = DataReconcilePayload.parse(row.payload);
  const prefix = payload.phase === "inventory" ? INVENTORY_PREFIX : JOURNAL_PREFIX;
  const listed = await bucket.list({
    prefix,
    limit: RECONCILE_PAGE,
    ...(payload.cursor === null ? {} : { startAfter: payload.cursor }),
  });
  for (const object of listed.objects) {
    if (payload.phase === "inventory") {
      if (inventoryArtifact(object.key) === null) continue;
      const found = await readJson(bucket, object.key, (value) => InventoryEntry.safeParse(value));
      if (found === null) continue;
      if (!found.value.success) {
        logEvent("warn", "data_record_unreadable", { id: row.id, topic: row.topic });
        continue;
      }
      if (inventoryPrunable(found.value.data, now)) {
        await bucket.delete(object.key);
        continue;
      }
      await reconcileObject(db, objects, found.value.data, now, object.key);
    } else {
      const subject = journalSubject(object.key);
      if (subject === null) continue;
      const found = await readJson(bucket, object.key, (value) =>
        JournalEntrySchema.safeParse(value),
      );
      if (found === null) continue;
      if (!found.value.success) {
        logEvent("warn", "data_record_unreadable", { id: row.id, topic: row.topic });
        continue;
      }
      const entry = found.value.data;
      if (journalPrunable(entry, now)) {
        await bucket.delete(object.key);
        continue;
      }
      if (entry.retiredAt !== undefined && entry.visitorId !== null) {
        await authorErasureJob(
          db,
          subject.artifactId,
          { userId: subject.userId, visitorId: entry.visitorId },
          now,
        );
      }
    }
  }
  const last = listed.objects.at(-1)?.key ?? null;
  if (listed.truncated && last !== null) {
    return keep(db, row, now, { phase: payload.phase, cursor: last });
  }
  if (payload.phase === "inventory") return keep(db, row, now, { phase: "journal", cursor: null });
  return "done";
}

/**
 * A `data_resolve` job, the operator's resolution of one quarantine (`resolveReviewed` in the
 * object). The reviewed state names one quarantine of one object (its artifact, region and
 * incarnation, with the owner, generation and epoch), so a state of another artifact or region
 * is refused before the object is read, and the object refuses any other quarantine atomically.
 * Then the record's artifact and region authority (`identityDisagreement`) is checked as
 * reconciliation checks it: a disagreement keeps its finding and nothing is resolved. `erase` is
 * refused while D1 holds (and in the object while the object holds); `adopt` needs D1 to name
 * the owner the object recorded and makes the object keep its hold or take D1's. The object
 * resolves first; only then does D1 follow it, never moving its epoch backward (an epoch D1
 * gave a pending fence stays that fence's). The artifact's waiting data jobs are woken after.
 * Receipts are the object's ended-intent records, kept `ARTIFACT_DATA.replayMs` (24 hours): a
 * retry within it finishes the same resolution; after it the retry is refused as a conflict
 * (the quarantine it reviewed is gone), and D1 is repaired by the next reconciliation.
 */
export async function runDataResolve(
  db: RegionalDb,
  bucket: R2Bucket,
  data: DataObjects | null | undefined,
  row: OutboxRow,
  now: number,
): Promise<DataJobOutcome> {
  const objects = needs(data, "data_resolve");
  const payload = DataResolvePayload.parse(row.payload);
  const artifactId = row.subject ?? "";
  if (payload.expected.artifactId !== artifactId || payload.expected.region !== objects.region) {
    return refuseResolution(db, artifactId, "forbidden", now);
  }
  const object = objects.object(artifactId);
  const control = await object.lifecycleControl();
  if (control === null) return refuseResolution(db, artifactId, "not_found", now);
  const key = inventoryKey(artifactId);
  const entry = await readJson(bucket, key, (value) => InventoryEntry.parse(value));
  const ad = schema.artifactDirectory;
  const [directory] = await db.global
    .select({ region: ad.region })
    .from(ad)
    .where(eq(ad.id, artifactId))
    .limit(1);
  const disagreement =
    entry === null
      ? "key"
      : identityDisagreement({
          key,
          entry: entry.value,
          region: objects.region,
          directoryRegion: directory?.region ?? null,
          control,
        });
  if (disagreement !== null) {
    await recordFinding(db, artifactId, "identity_mismatch", disagreement, now);
    return "stale";
  }
  const [artifact] = await db
    .select({ ownerId: a.ownerId })
    .from(a)
    .where(eq(a.id, artifactId))
    .limit(1);
  const open = await openHold(db, artifactId);
  if (payload.decision === "erase" && open) return refuseResolution(db, artifactId, "held", now);
  if (
    payload.decision === "adopt" &&
    (!artifact || artifact.ownerId !== payload.expected.ownerId)
  ) {
    return refuseResolution(db, artifactId, "stale", now);
  }
  const answer = await object.lifecycleResolve(
    controlEnvelope(control),
    {
      id: payload.resolutionId,
      decision: payload.decision,
      expected: payload.expected,
      hold: open ? { transition: open.id } : null,
    },
    now,
  );
  if (!answer.ok) return refuseResolution(db, artifactId, answer.code, now);
  const after = await object.lifecycleControl();
  if (after !== null && artifact && artifact.ownerId === after.ownerId) {
    await followResolution(db, artifactId, after, now);
  }
  if (!artifact) await retireInventory(bucket, objects.region, artifactId, now);
  await wakeDataJobs(db, artifactId, now);
  await recordFinding(
    db,
    artifactId,
    payload.decision === "adopt" ? "adopted" : "erased",
    null,
    now,
    { state: null },
  );
  return "done";
}

async function refuseResolution(
  db: RegionalDb,
  artifactId: string,
  code: DataRefusalCode,
  now: number,
): Promise<"stale"> {
  await recordFinding(db, artifactId, "refused", code, now, { keepAction: false });
  return "stale";
}

/**
 * D1 follows a resolved object: the object's generation, and the larger of D1's and the object's
 * epoch, written only from the row read (or inserted when there is none), so an epoch D1 already
 * gave a pending fence is never taken back.
 */
async function followResolution(
  db: RegionalDb,
  artifactId: string,
  control: DataControl,
  now: number,
): Promise<void> {
  const [current] = await db
    .select({ generation: d.generation, epoch: d.epoch })
    .from(d)
    .where(eq(d.artifactId, artifactId))
    .limit(1);
  if (!current) {
    await db
      .insert(d)
      .values({ artifactId, generation: control.generation, epoch: control.epoch, updatedAt: now })
      .onConflictDoNothing();
    return;
  }
  await db
    .update(d)
    .set({
      generation: control.generation,
      epoch: Math.max(current.epoch, control.epoch),
      updatedAt: now,
    })
    .where(
      and(
        eq(d.artifactId, artifactId),
        eq(d.generation, current.generation),
        eq(d.epoch, current.epoch),
      ),
    );
}

/**
 * A `data_export` job, the operator's export (allowed under a hold or a quarantine): one page per
 * run into the region's bucket as JSON Lines, `<key>/<page>.jsonl`, under the object's own
 * identity. An object that holds nothing exports nothing.
 */
export async function runDataExport(
  db: RegionalDb,
  bucket: R2Bucket,
  data: DataObjects | null | undefined,
  row: OutboxRow,
  now: number,
): Promise<DataJobOutcome> {
  const objects = needs(data, "data_export");
  const payload = DataExportPayload.parse(row.payload);
  const object = objects.object(row.subject ?? "");
  const control = await object.lifecycleControl();
  if (control === null) return "done";
  const answer = await object.lifecycleExport(controlEnvelope(control), payload.after, now);
  if (!answer.ok) {
    const reason = answer.code;
    logEvent("warn", "data_job_refused", { id: row.id, topic: row.topic, reason });
    return "stale";
  }
  const header = {
    artifact: control.artifactId,
    generation: control.generation,
    revision: answer.value.revision,
    page: payload.page,
  };
  const lines = [header, ...answer.value.rows].map((line) => JSON.stringify(line)).join("\n");
  await bucket.put(`${payload.key}/${String(payload.page).padStart(6, "0")}.jsonl`, `${lines}\n`);
  if (answer.value.next === null) return "done";
  return keep(db, row, now, { key: payload.key, after: answer.value.next, page: payload.page + 1 });
}

/** The data jobs a hold deferred, sent again now that it is released (`runHoldRelease`). */
export async function wakeDataJobs(db: Db, artifactId: string, now: number): Promise<void> {
  const o = schema.outbox;
  await db
    .update(o)
    .set({ availableAt: now, dispatchedAt: null })
    .where(
      and(
        eq(o.subject, artifactId),
        sql`${o.topic} in ('data_fence', 'data_erase', 'data_author_erasure')`,
        sql`${o.availableAt} > ${now}`,
      ),
    );
}

/** The operator's view of reconciliation's findings, newest first. */
export async function listDataFindings(db: RegionalDb, limit: number) {
  return db
    .select()
    .from(schema.dataFindings)
    .orderBy(sql`${schema.dataFindings.lastSeenAt} desc`)
    .limit(limit);
}

/** Writes the operator's jobs: a region's reconciliation, a resolution, an export. */
export async function queueDataReconcile(db: RegionalDb, now: number): Promise<void> {
  await db.insert(schema.outbox).values({
    topic: "data_reconcile",
    payload: { phase: "inventory", cursor: null },
    availableAt: now,
    createdAt: now,
    subject: `reconcile:${now}`,
  });
}

export async function queueDataResolve(
  db: RegionalDb,
  artifactId: string,
  decision: "adopt" | "erase",
  expected: ReviewedQuarantine,
  now: number,
): Promise<string> {
  const resolutionId = lifecycleId(now);
  await db.insert(schema.outbox).values({
    topic: "data_resolve",
    payload: { decision, resolutionId, expected },
    availableAt: now,
    createdAt: now,
    subject: artifactId,
  });
  return resolutionId;
}

export async function queueDataExport(
  db: RegionalDb,
  artifactId: string,
  now: number,
): Promise<string> {
  const key = `system/data-exports/${artifactId}.${now}`;
  await db.insert(schema.outbox).values({
    topic: "data_export",
    payload: { key, after: null, page: 0 },
    availableAt: now,
    createdAt: now,
    subject: artifactId,
  });
  return key;
}
