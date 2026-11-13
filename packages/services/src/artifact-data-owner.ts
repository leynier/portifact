// The owner side of artifact data (decision 0026, delivery 5): describe, declare, read, query,
// count, create, replace, delete, bulk writes and the export, for an artifact's admins and editors
// (and service tokens holding the data scopes). The API, the MCP tools and the CLI are thin
// adapters over these functions, so all three get the same checks, quotas, states and errors.
//
// Every command is authorized here on the artifact's owner (role action `data`), then sent to the
// artifact's documents object with the envelope from D1 and the owner plan's limits; the object
// admits, authorizes again and charges it by the domain's rules. A mutation carries an operation
// ID from the caller's idempotency key, and its `data_audit` job is written before the object is
// called: the job settles the operation with the object and records the audit event, or records
// the operation aborted so a late arrival cannot commit ("Audit with durable states").
//
// Nothing here creates an object while artifact data is switched off: every command but the
// export answers `not_found`, and an export of an artifact that never stored data answers empty.
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  type CollectionDeclaration,
  type CollectionInfo,
  type DataAuditPayload,
  DataAuditPayload as DataAuditPayloadSchema,
  type DataCount,
  type DataDescription,
  type DataDescriptionView,
  type DataExportDocument,
  type DataExportPageView,
  type DataQuery,
  type ExportCursor,
  exportCursorText,
  type OwnerDataCommand,
  type StoredDocument,
} from "@portifact/contracts";
import { hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import {
  type DataWork,
  dataAuditEvent,
  dataRefusalError,
  fail,
  ok,
  type Result,
} from "@portifact/domain";
import { dayOf, emptyDay } from "@portifact/domain/artifact-data";
import { and, eq, sql } from "drizzle-orm";
import { authorizeOn } from "./actors.ts";
import {
  type DataObjects,
  readDataRow,
  recordStorageReport,
  registerDataObject,
} from "./artifact-data.ts";
import { auditEvent } from "./audit.ts";
import { checkDataWriteCapacity } from "./budget.ts";
import { hashRequest } from "./idempotency.ts";
import { heldRefusal, isHeld, notHeldSql } from "./legal-holds.ts";
import { ownerEntitlements } from "./plans.ts";

/** What the owner side's services need besides the artifact's regional database. */
export interface OwnerDataDeps {
  /** The artifact's region's objects; null without the binding. */
  objects: DataObjects | null;
  /** The artifact's region's bucket, for the inventory entry a first write registers. */
  bucket: R2Bucket;
  /** `ARTIFACT_DATA_ENABLED`: off, nothing but the export is reachable. */
  enabled: boolean;
}

export interface OwnerDataInput {
  userId: string;
  artifactId: string;
  now: number;
}

/** A mutation's input: the caller's idempotency key names its operation in the object. */
export interface OwnerDataWrite extends OwnerDataInput {
  idempotencyKey: string;
}

/** How long the audit job waits before it first asks the object: the mutation has answered. */
export const DATA_AUDIT_DELAY_MS = 30_000;

const missing = () => fail<never>("not_found", "Artifact not found.");
const unavailable = () => fail<never>("not_found", "Artifact data is not available.");
const noCollection = () => fail<never>("not_found", "No such collection.");

interface Target {
  ownerId: string;
  state: string;
  region: string;
  limits: ArtifactDataLimits;
  dataArtifacts: number;
  row: Awaited<ReturnType<typeof readDataRow>>;
}

/**
 * The artifact as the owner side may act on it: present, the caller an admin or editor of its
 * owner (or a token reaching it), not held, and, for a change, active. The plan's limits come
 * from the owner's entitlements, never the caller's.
 */
async function target(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataInput,
  intent: "read" | "write" | "export",
): Promise<Result<Target>> {
  const [artifact] = await db
    .select({
      ownerId: schema.artifacts.ownerId,
      state: schema.artifacts.state,
      createdBy: schema.artifacts.createdBy,
      externalKey: schema.artifacts.externalKey,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!artifact || artifact.state === "purging" || artifact.state === "deleted") return missing();
  const allowed = await authorizeOn(db, input.userId, artifact, "data", missing);
  if (!allowed.ok) return allowed;
  if (!deps.enabled && intent !== "export") return unavailable();
  // A held artifact's data is read by nobody but the operator (legal-holds.ts).
  if (artifact.state === "suspended" && (await isHeld(db, input.artifactId))) return heldRefusal();
  if (intent === "write" && artifact.state === "archived") {
    return fail("artifact_archived", "Restore the artifact to change its data.");
  }
  if (intent === "write" && artifact.state !== "active") {
    return fail("forbidden", "A suspended artifact's data cannot be changed.");
  }
  // The owner's plan (decision 0026, "The plan limits"), never the caller's.
  const plan = (await ownerEntitlements(db.global, artifact.ownerId, input.now)).data;
  const region = allowed.value.region;
  return ok({
    ownerId: artifact.ownerId,
    state: artifact.state,
    region,
    limits: plan.perArtifact,
    dataArtifacts: plan.artifacts,
    row: await readDataRow(db, region, input.artifactId),
  });
}

type Answer =
  | {
      ok: true;
      value?: unknown;
      replayed?: unknown;
      storage: { generation: number; seq: number; bytes: number };
    }
  | {
      ok: false;
      code: string;
      message: string;
      storage?: { generation: number; seq: number; bytes: number };
    };

/** Sends one command to the object and keeps its storage report. */
async function send(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataInput,
  found: Target & { row: NonNullable<Target["row"]> },
  command: OwnerDataCommand,
  opId?: string,
): Promise<Result<{ value: unknown; replayed: boolean }>> {
  if (deps.objects === null) {
    return fail("capacity_unavailable", "Artifact data is unavailable. Try again later.");
  }
  const envelope = {
    artifactId: input.artifactId,
    region: found.row.region,
    ownerId: found.row.ownerId,
    generation: found.row.generation,
    epoch: found.row.epoch,
    ...(opId === undefined ? {} : { opId }),
  };
  const answer = (await deps.objects
    .object(input.artifactId)
    .ownerCommand(envelope, input.userId, command, found.limits, input.now)) as Answer;
  if (answer.storage !== undefined && (answer.ok || answer.storage.seq > 0)) {
    await recordStorageReport(db, input.artifactId, answer.storage, input.now);
  }
  if (!answer.ok) {
    const error = dataRefusalError(answer.code, answer.message);
    return fail(error.code, error.message);
  }
  return ok({
    value: "replayed" in answer ? answer.replayed : answer.value,
    replayed: "replayed" in answer,
  });
}

/**
 * Owner-side changes one artifact admits per minute, refused ones included: every attempt costs
 * a claim and a call to the object, so a caller whose changes the object keeps refusing (a spent
 * day, a full collection) still has a bound.
 */
export const DATA_OWNER_WRITES_PER_MINUTE = 60;

/** A new operation ID: the issue time the object's horizon reads, and a random part. */
function newOperationId(now: number): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const random = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${String(Math.floor(now)).padStart(13, "0")}.${random}`;
}

const ops = schema.dataOperations;

/**
 * The D1 claim of an owner-side change, the one guarded write between authorization and the
 * object (decision 0026, delivery 5). One statement inserts the caller's operation for this
 * idempotency key, or keeps the one a lost answer left, only while the artifact is still the
 * authorized owner's, active, not held and at the generation and epoch the envelope carries: a
 * transfer, a hold, a suspension or a fence that landed after authorization refuses it. A new
 * claim writes the `data_audit` job in the same batch; a kept one sends the object the same
 * operation ID, issue time included, so the object applies the change once and answers a retry
 * from its own record. A key sent with another request is refused.
 */
async function claimOperation(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite,
  found: Target & { row: NonNullable<Target["row"]> },
  requestHash: string,
): Promise<Result<{ opId: string; fresh: boolean }>> {
  const proposed = newOperationId(input.now);
  const { row } = found;
  const a = schema.artifacts;
  const d = schema.artifactData;
  const guard = sql`exists (select 1 from ${a} join ${d} on ${d.artifactId} = ${a.id} where ${a.id} = ${input.artifactId} and ${a.ownerId} = ${found.ownerId} and ${a.state} = 'active' and ${notHeldSql(sql`${a.id}`)} and ${d.generation} = ${row.generation} and ${d.epoch} = ${row.epoch})`;
  const payload = sql`json_object('ownerId', ${row.ownerId}, 'generation', ${row.generation}, 'epoch', ${row.epoch}, 'actor', ${input.userId}, 'opId', ${proposed})`;
  // Columns in schema order. The outbox's: id, topic, payload, available, dispatched, attempts,
  // created, subject, generation.
  const [claimed] = await db.batch([
    db
      .insert(ops)
      .select(
        sql`select ${input.userId}, ${input.idempotencyKey}, ${input.artifactId}, ${proposed}, ${requestHash}, ${input.now} where ${guard}`,
      )
      .onConflictDoUpdate({
        target: [ops.actorId, ops.idempotencyKey],
        set: { artifactId: sql`${ops.artifactId}` },
        setWhere: sql`${ops.requestHash} = excluded.request_hash and ${ops.artifactId} = excluded.artifact_id`,
      })
      .returning({ opId: ops.opId }),
    db
      .insert(schema.outbox)
      .select(
        sql`select null, 'data_audit', ${payload}, ${input.now + DATA_AUDIT_DELAY_MS}, null, 0, ${input.now}, ${input.artifactId}, null where exists (select 1 from ${ops} where ${ops.actorId} = ${input.userId} and ${ops.idempotencyKey} = ${input.idempotencyKey} and ${ops.opId} = ${proposed})`,
      ),
  ]);
  const opId = claimed[0]?.opId;
  if (opId !== undefined) {
    // A kept claim past the object's horizon would be refused there: the key has expired.
    if (input.now - Number(opId.slice(0, 13)) > ARTIFACT_DATA.horizonMs) {
      return fail(
        "invalid_input",
        "This Idempotency-Key has expired. Send the change with a new one.",
      );
    }
    return ok({ opId, fresh: opId === proposed });
  }
  const [kept] = await db
    .select({ hash: ops.requestHash, artifactId: ops.artifactId })
    .from(ops)
    .where(and(eq(ops.actorId, input.userId), eq(ops.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (kept && (kept.hash !== requestHash || kept.artifactId !== input.artifactId)) {
    return fail("invalid_input", "This Idempotency-Key was used for a different request.");
  }
  // The artifact changed after authorization: answer what it is now.
  const again = await target(db, deps, input, "write");
  if (!again.ok) return again;
  return fail("version_conflict", "The artifact's data changed; try again.");
}

/**
 * Takes back a new claim and its audit job once the object refused the change: a refusal commits
 * nothing, so nothing is left to settle, and a refused caller leaves no durable work behind.
 */
async function retireOperation(db: RegionalDb, input: OwnerDataWrite, opId: string) {
  const o = schema.outbox;
  await db.batch([
    db
      .delete(o)
      .where(
        and(
          eq(o.topic, "data_audit"),
          eq(o.subject, input.artifactId),
          sql`json_extract(${o.payload}, '$.opId') = ${opId}`,
        ),
      ),
    db
      .delete(ops)
      .where(
        and(
          eq(ops.actorId, input.userId),
          eq(ops.idempotencyKey, input.idempotencyKey),
          eq(ops.opId, opId),
        ),
      ),
  ]);
}

/** The `data_audit` job of a kept claim whose change committed now (a concurrent retry's). */
async function auditJob(
  db: RegionalDb,
  input: OwnerDataWrite,
  row: NonNullable<Target["row"]>,
  opId: string,
): Promise<void> {
  const payload: DataAuditPayload = {
    ownerId: row.ownerId,
    generation: row.generation,
    epoch: row.epoch,
    actor: input.userId,
    opId,
  };
  await db.insert(schema.outbox).values({
    topic: "data_audit",
    payload,
    availableAt: input.now + DATA_AUDIT_DELAY_MS,
    createdAt: input.now,
    subject: input.artifactId,
  });
}

/**
 * A change: authorized on the artifact's owner, within the owner's rate, the data step and the
 * plan's data artifacts, claimed in D1 by one guarded statement with its audit job, then sent to
 * the object under the claim's operation ID. Every request does all of it, a retry included, so a
 * retry is answered under the caller's current authorization and never from a stored answer.
 */
async function mutate(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite,
  command: OwnerDataCommand,
  register = false,
): Promise<Result<{ value: unknown; replayed: boolean }>> {
  const found = await target(db, deps, input, "write");
  if (!found.ok) return found;
  const hit = await hitRateLimit(
    db.global.$client,
    `data_owner:${input.artifactId}`,
    60_000,
    input.now,
  );
  if (hit.count > DATA_OWNER_WRITES_PER_MINUTE) {
    return fail("rate_limited", "Too many changes to this artifact's data. Try again in a minute.");
  }
  // Budget protection's data step stops new and growing work only (`DATA_WORK_PAUSED`): deletes
  // always pass, and reads and exports never come here.
  const capacity = await checkDataWriteCapacity(db.global, command.kind as DataWork, input.now);
  if (!capacity.ok) return capacity;
  let row = found.value.row;
  if (row === null) {
    if (!register) return noCollection();
    const registered = await registerDataObject(
      db,
      deps.bucket,
      found.value.region,
      input.artifactId,
      input.now,
      { ownerId: found.value.ownerId, dataArtifacts: found.value.dataArtifacts },
    );
    if (!registered) {
      return fail(
        "quota_exceeded",
        `Your plan allows data on ${found.value.dataArtifacts} artifact${found.value.dataArtifacts === 1 ? "" : "s"}.`,
      );
    }
    row = await readDataRow(db, found.value.region, input.artifactId);
    if (row === null) return missing();
  }
  const admitted = { ...found.value, row };
  const requestHash = await hashRequest({ artifactId: input.artifactId, command });
  const claim = await claimOperation(db, deps, input, admitted, requestHash);
  if (!claim.ok) return claim;
  const sent = await send(db, deps, input, admitted, command, claim.value.opId);
  if (!sent.ok) {
    if (claim.value.fresh) await retireOperation(db, input, claim.value.opId);
    return sent;
  }
  if (!sent.value.replayed && !claim.value.fresh) {
    await auditJob(db, input, row, claim.value.opId);
  }
  return sent;
}

/** A read: authorized, then the object, or the empty answer when nothing was ever stored. */
async function read<T>(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataInput,
  command: OwnerDataCommand,
  empty: () => Result<T>,
  intent: "read" | "export" = "read",
): Promise<Result<{ value: T; found: Target }>> {
  const found = await target(db, deps, input, intent);
  if (!found.ok) return found;
  const row = found.value.row;
  if (row === null) {
    const answer = empty();
    return answer.ok ? ok({ value: answer.value, found: found.value }) : answer;
  }
  const sent = await send(db, deps, input, { ...found.value, row }, command);
  if (!sent.ok) return sent;
  return ok({ value: sent.value.value as T, found: found.value });
}

// Reads.

export async function describeArtifactData(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataInput,
): Promise<Result<DataDescriptionView>> {
  const empty = (): Result<DataDescription | null> => ok(null);
  const result = await read(db, deps, input, { kind: "describe" }, empty);
  if (!result.ok) return result;
  const { value, found } = result.value;
  const limits = found.limits;
  const [stored] = await db
    .select({ bytes: schema.artifactData.documentsBytes })
    .from(schema.artifactData)
    .where(eq(schema.artifactData.artifactId, input.artifactId))
    .limit(1);
  return ok({
    artifactId: input.artifactId,
    exists: value !== null && found.row !== null,
    generation: value?.generation ?? found.row?.generation ?? 0,
    revision: value?.revision ?? 0,
    collections: value?.collections ?? [],
    today: value?.today ?? emptyDay(dayOf(input.now)),
    limits: {
      bytesPerArtifact: limits.bytesPerArtifact,
      documentBytes: limits.documentBytes,
      documentsPerCollection: limits.documentsPerCollection,
      collections: limits.collections,
      indexedFields: limits.indexedFields,
      rowsReadPerDay: limits.rowsReadPerDay,
      rowsWrittenPerDay: limits.rowsWrittenPerDay,
      cleanupRowsPerDay: limits.cleanupRowsPerDay,
      exportRowsPerDay: limits.exportRowsPerDay,
    },
    storedBytes: stored?.bytes ?? 0,
  });
}

export async function getDataDocument(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataInput & { collection: string; id: string },
): Promise<Result<StoredDocument>> {
  const result = await read<StoredDocument>(
    db,
    deps,
    input,
    { kind: "get", collection: input.collection, id: input.id },
    () => fail("not_found", "No such document."),
  );
  return result.ok ? ok(result.value.value) : result;
}

export async function queryArtifactData(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataInput & { query: DataQuery },
): Promise<Result<{ documents: StoredDocument[]; next: string | null }>> {
  const result = await read<{ documents: StoredDocument[]; next: string | null }>(
    db,
    deps,
    input,
    { kind: "query", query: input.query },
    () => noCollection(),
  );
  return result.ok ? ok(result.value.value) : result;
}

export async function countArtifactData(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataInput & { count: DataCount },
): Promise<Result<{ documents: number }>> {
  const result = await read<{ documents: number }>(
    db,
    deps,
    input,
    { kind: "count", count: input.count },
    () => noCollection(),
  );
  return result.ok ? ok(result.value.value) : result;
}

interface ObjectExportPage {
  rows: DataExportDocument[];
  next: ExportCursor | null;
  revision: number;
}

/**
 * One export page (decision 0026, "Export"), in primary key order after `after`. The first page
 * also carries the header's generation and collections, read from a description after the page:
 * the file is consistent when every page and that description saw one revision. Works while
 * artifact data is switched off, on objects that exist; an artifact that never stored data
 * exports empty.
 */
export async function exportArtifactData(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataInput & { after: ExportCursor | null },
): Promise<Result<DataExportPageView>> {
  const emptyPage = (): Result<ObjectExportPage> => ok({ rows: [], next: null, revision: 0 });
  const result = await read<ObjectExportPage>(
    db,
    deps,
    input,
    { kind: "export", after: input.after },
    emptyPage,
    "export",
  );
  if (!result.ok) return result;
  const { value: page, found } = result.value;
  let header: DataExportPageView["header"] = null;
  if (input.after === null) {
    let description: DataDescription | null = null;
    if (found.row !== null) {
      const described = await send(
        db,
        deps,
        input,
        { ...found, row: found.row },
        { kind: "describe" },
      );
      if (!described.ok) return described;
      description = described.value.value as DataDescription;
    }
    header = {
      generation: description?.generation ?? found.row?.generation ?? 0,
      // A declaration between the page and the description moves it: the file then says so.
      revision: description?.revision ?? page.revision,
      collections: (description?.collections ?? []).map((collection: CollectionInfo) => ({
        name: collection.name,
        mode: collection.mode,
        uniqueKey: collection.uniqueKey,
        indexed: collection.indexed.map((field) => field.field),
      })),
    };
  }
  return ok({
    artifactId: input.artifactId,
    revision: page.revision,
    rows: page.rows,
    next: exportCursorText(page.next),
    header,
  });
}

// Changes.

export async function declareDataCollection(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite & { declaration: CollectionDeclaration },
): Promise<Result<{ collection: CollectionInfo; building: number }>> {
  const result = await mutate(
    db,
    deps,
    input,
    { kind: "declare", declaration: input.declaration },
    true,
  );
  if (!result.ok) return result;
  // Index builds are incremental (decision 0026): a few steps now; `buildDataIndexes` runs more.
  if (!result.value.replayed && (result.value.value as { building: number }).building > 0) {
    await buildDataIndexes(db, deps, { ...input, idempotencyKey: `${input.idempotencyKey}:build` });
  }
  const described = await describeArtifactData(db, deps, input);
  if (!described.ok) return described;
  const collection = described.value.collections.find(
    (item) => item.name === input.declaration.name,
  );
  if (collection === undefined) return noCollection();
  return ok({
    collection,
    building: collection.indexed.filter((field) => field.state === "building").length,
  });
}

/** Index build steps one request runs before it answers. */
export const INDEX_STEPS_PER_REQUEST = 4;

/**
 * Runs up to `INDEX_STEPS_PER_REQUEST` index build steps while any declared field is building
 * (decision 0026, "Index builds are incremental"): what a declaration did not finish.
 */
export async function buildDataIndexes(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite,
): Promise<Result<{ building: number }>> {
  let building = 1;
  for (let step = 0; building > 0 && step < INDEX_STEPS_PER_REQUEST; step += 1) {
    const stepped = await mutate(
      db,
      deps,
      { ...input, idempotencyKey: `${input.idempotencyKey}:${step}` },
      { kind: "index_step" },
    );
    if (!stepped.ok) return stepped;
    building = stepped.value.replayed ? 0 : (stepped.value.value as { building: number }).building;
  }
  return ok({ building });
}

/** A replayed single write answers the document as it is now. */
async function documentAfter(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite & { collection: string },
  written: { value: unknown; replayed: boolean },
): Promise<Result<StoredDocument>> {
  if (!written.replayed) return ok(written.value as StoredDocument);
  const target = (written.value as { target?: string }).target ?? "";
  const id = target.slice(target.indexOf("/") + 1);
  return getDataDocument(db, deps, { ...input, id });
}

export async function createDataDocument(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite & { collection: string; body: Record<string, unknown> },
): Promise<Result<StoredDocument>> {
  const result = await mutate(db, deps, input, {
    kind: "create",
    collection: input.collection,
    body: input.body,
  });
  return result.ok ? documentAfter(db, deps, input, result.value) : result;
}

export async function replaceDataDocument(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite & { collection: string; id: string; body: Record<string, unknown> },
): Promise<Result<StoredDocument>> {
  const result = await mutate(db, deps, input, {
    kind: "replace",
    collection: input.collection,
    id: input.id,
    body: input.body,
  });
  return result.ok ? documentAfter(db, deps, input, result.value) : result;
}

export async function deleteDataDocument(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite & { collection: string; id: string },
): Promise<Result<{ id: string }>> {
  const result = await mutate(db, deps, input, {
    kind: "remove",
    collection: input.collection,
    id: input.id,
  });
  return result.ok ? ok({ id: input.id }) : result;
}

export async function createDataDocuments(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite & { collection: string; documents: Record<string, unknown>[] },
): Promise<Result<{ ids: string[] }>> {
  const result = await mutate(db, deps, input, {
    kind: "bulk_create",
    input: { collection: input.collection, documents: input.documents },
  });
  if (!result.ok) return result;
  // The object's record of a bulk create keeps its count, not its IDs: a replay answers none.
  return ok(result.value.replayed ? { ids: [] } : (result.value.value as { ids: string[] }));
}

function bulkCount(written: { value: unknown; replayed: boolean }, field: string): number {
  const value = written.value as Record<string, unknown> & {
    result?: Record<string, number> | null;
  };
  const counted = written.replayed ? value.result?.[field] : value[field];
  return typeof counted === "number" ? counted : 0;
}

export async function replaceDataDocuments(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite & {
    collection: string;
    documents: { id: string; body: Record<string, unknown> }[];
  },
): Promise<Result<{ replaced: number }>> {
  const result = await mutate(db, deps, input, {
    kind: "bulk_replace",
    input: { collection: input.collection, documents: input.documents },
  });
  return result.ok ? ok({ replaced: bulkCount(result.value, "replaced") }) : result;
}

export async function deleteDataDocuments(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite & { collection: string; ids: string[] },
): Promise<Result<{ removed: number }>> {
  const result = await mutate(db, deps, input, {
    kind: "bulk_remove",
    collection: input.collection,
    ids: input.ids,
  });
  return result.ok ? ok({ removed: bulkCount(result.value, "removed") }) : result;
}

// The audit relay.

type OutboxRow = typeof schema.outbox.$inferSelect;

/** How long a `data_audit` job waits when the object cannot decide yet (an ID from the future). */
export const DATA_AUDIT_RETRY_MS = 5 * 60_000;

/** The audit event's ID for an operation: one per operation, so a repeated delivery adds none. */
async function dataAuditEventId(artifactId: string, payload: DataAuditPayload): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${artifactId}\u0000${payload.actor}\u0000${payload.opId}`),
  );
  return `ae_${[...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * The `data_audit` job (decision 0026, "Audit with durable states"): asks the object how the
 * owner-side operation ended. A committed obligation becomes the owner's audit event (once: its
 * ID is the operation's), then is acknowledged; an operation the object never committed is
 * recorded aborted there, so a late arrival cannot commit, and records nothing. Idempotent: a
 * repeated delivery finds the event and the acknowledgement already done. Throws without the
 * binding, so the row stays. While artifact data is off it never binds an empty object.
 */
export async function runDataAudit(
  db: RegionalDb,
  objects: DataObjects | null | undefined,
  row: OutboxRow,
  now: number,
): Promise<"done" | "stale" | "kept"> {
  if (!objects) throw new Error("data_audit needs the documents binding");
  const parsed = DataAuditPayloadSchema.safeParse(row.payload);
  if (!parsed.success || row.subject === null) return "stale";
  const payload = parsed.data;
  const artifactId = row.subject;
  const envelope = {
    artifactId,
    region: objects.region,
    ownerId: payload.ownerId,
    generation: payload.generation,
    epoch: payload.epoch,
  };
  const object = objects.object(artifactId);
  // Settling an unknown operation records it aborted, which binds an empty object: never while
  // artifact data is off (`createsObjects`). An object nothing bound committed nothing.
  if (!objects.createsObjects && (await object.lifecycleControl()) === null) return "done";
  const answer = await object.auditSettle(envelope, payload.actor, payload.opId, now);
  if (answer.state === "aborted") return "done";
  if (answer.state === "refused") {
    // Another artifact or region never settles; an ID the object cannot decide yet waits.
    if (answer.code === "forbidden" || answer.code === "invalid_input") return "stale";
    await db
      .update(schema.outbox)
      .set({ availableAt: now + DATA_AUDIT_RETRY_MS, dispatchedAt: null })
      .where(eq(schema.outbox.id, row.id));
    return "kept";
  }
  if (!answer.delivered) {
    const event = dataAuditEvent(answer.kind, answer.detail);
    if (event !== null) {
      const id = await dataAuditEventId(artifactId, payload);
      const ae = schema.auditEvents;
      await db.batch([
        auditEvent(
          db,
          {
            id,
            ownerId: payload.ownerId,
            kind: event.kind,
            actor: { type: "user", id: payload.actor },
            targetId: artifactId,
            artifactId,
            detail: event.detail as never,
            now: Number(payload.opId.slice(0, 13)),
          },
          sql`not exists (select 1 from ${ae} where ${ae.id} = ${id})`,
        ),
      ]);
    }
    await object.auditAcknowledge(envelope, payload.actor, payload.opId, now);
  }
  return "done";
}
