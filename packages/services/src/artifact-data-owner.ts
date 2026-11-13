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
  AUTHOR_DELETE_PAGES,
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
  type DataResetPayload,
  DataResetPayload as DataResetPayloadSchema,
  ERASURE_ACTOR,
  type ErrorCode,
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
  HELD_MESSAGE,
  ok,
  type Result,
} from "@portifact/domain";
import {
  dayOf,
  emptyDay,
  INVENTORY_PREFIX,
  inventoryArtifact,
  LIFECYCLE_LIMITS,
} from "@portifact/domain/artifact-data";
import { and, eq, sql } from "drizzle-orm";
import { authorizeOn } from "./actors.ts";
import {
  DATA_JOB_WAIT_MS,
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
  intent: "read" | "write" | "export" | "erase",
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
  if (!deps.enabled && intent !== "export" && intent !== "erase") return unavailable();
  // A held artifact's data is read by nobody but the operator (legal-holds.ts).
  if (artifact.state === "suspended" && (await isHeld(db, input.artifactId))) return heldRefusal();
  if (intent === "write" && artifact.state === "archived") {
    return fail("artifact_archived", "Restore the artifact to change its data.");
  }
  if (intent === "erase" && artifact.state !== "active" && artifact.state !== "archived") {
    return fail("forbidden", "A suspended artifact's data cannot be changed.");
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
  kind: "change" | "erase" = "change",
): Promise<Result<{ opId: string; fresh: boolean }>> {
  const proposed = newOperationId(input.now);
  const { row } = found;
  const a = schema.artifacts;
  const d = schema.artifactData;
  // A change needs an active artifact; the owner's erase also an archived one (its data stays
  // while archived and the owner side may erase it).
  const states = kind === "erase" ? sql`('active', 'archived')` : sql`('active')`;
  const guard = sql`exists (select 1 from ${a} join ${d} on ${d.artifactId} = ${a.id} where ${a.id} = ${input.artifactId} and ${a.ownerId} = ${found.ownerId} and ${a.state} in ${states} and ${notHeldSql(sql`${a.id}`)} and ${d.generation} = ${row.generation} and ${d.epoch} = ${row.epoch})`;
  const payload =
    kind === "erase"
      ? sql`json_object('ownerId', ${row.ownerId}, 'generation', ${row.generation}, 'epoch', ${row.epoch}, 'actor', ${input.userId}, 'eraseId', ${proposed})`
      : sql`json_object('ownerId', ${row.ownerId}, 'generation', ${row.generation}, 'epoch', ${row.epoch}, 'actor', ${input.userId}, 'opId', ${proposed})`;
  const topic = kind === "erase" ? "data_reset" : "data_audit";
  const available =
    kind === "erase" ? input.now + DATA_RESET_DELAY_MS : input.now + DATA_AUDIT_DELAY_MS;
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
        sql`select null, ${topic}, ${payload}, ${available}, null, 0, ${input.now}, ${input.artifactId}, null where exists (select 1 from ${ops} where ${ops.actorId} = ${input.userId} and ${ops.idempotencyKey} = ${input.idempotencyKey} and ${ops.opId} = ${proposed})`,
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
  const again = await target(db, deps, input, kind === "erase" ? "erase" : "write");
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
async function dataAuditEventId(
  artifactId: string,
  payload: Pick<DataAuditPayload, "actor" | "opId">,
): Promise<string> {
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
            // An author erasure chunk is the system's (decision 0026, "Author erasure").
            actor:
              payload.actor === ERASURE_ACTOR
                ? { type: "system" }
                : { type: "user", id: payload.actor },
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

// The owner's erase of all an artifact's data (decision 0026, "Interfaces, scopes and parity").

/** How long a reset's job waits before it finishes what the request did not. */
export const DATA_RESET_DELAY_MS = 60_000;

/**
 * Erases all an artifact's documents and collections, an owner's reset (an optional erase intent,
 * at most `erase.intentsPerDay` a day, never `requiredErase`). Authorized like a change but also
 * on an archived artifact, and while artifact data is switched off (decision 0026, "Switches":
 * erasure works on objects that exist). Claimed in D1 with its `data_reset` job, so a crash
 * between the object's two steps is finished by the job under the same erase ID; then D1 asks
 * for an open hold before each step and follows the object's new generation, recording
 * `data.erased` in that batch. An artifact that never stored data has nothing to erase.
 */
export async function eraseArtifactData(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite,
): Promise<Result<{ erased: true; generation: number }>> {
  const found = await target(db, deps, input, "erase");
  if (!found.ok) return found;
  const row = found.value.row;
  if (row === null) return ok({ erased: true, generation: 0 });
  const hit = await hitRateLimit(
    db.global.$client,
    `data_owner:${input.artifactId}`,
    60_000,
    input.now,
  );
  if (hit.count > DATA_OWNER_WRITES_PER_MINUTE) {
    return fail("rate_limited", "Too many changes to this artifact's data. Try again in a minute.");
  }
  const requestHash = await hashRequest({ artifactId: input.artifactId, command: "erase" });
  const claim = await claimOperation(
    db,
    deps,
    input,
    { ...found.value, row },
    requestHash,
    "erase",
  );
  if (!claim.ok) return claim;
  const payload: DataResetPayload = {
    ownerId: row.ownerId,
    generation: row.generation,
    epoch: row.epoch,
    actor: input.userId,
    eraseId: claim.value.opId,
  };
  const reset = await completeReset(db, deps.objects, input.artifactId, payload, input.now);
  if (!reset.ok && claim.value.fresh && reset.definite) {
    await retireReset(db, input, claim.value.opId);
  }
  return reset.ok ? ok({ erased: true, generation: reset.generation }) : reset;
}

type ResetOutcome =
  | { ok: true; generation: number }
  | { ok: false; code: ErrorCode; message: string; definite: boolean; wait?: boolean };

/** Takes back a refused reset's claim and job: the object erased nothing. */
async function retireReset(db: RegionalDb, input: OwnerDataWrite, eraseId: string) {
  const o = schema.outbox;
  await db.batch([
    db
      .delete(o)
      .where(
        and(
          eq(o.topic, "data_reset"),
          eq(o.subject, input.artifactId),
          sql`json_extract(${o.payload}, '$.eraseId') = ${eraseId}`,
        ),
      ),
    db
      .delete(ops)
      .where(
        and(
          eq(ops.actorId, input.userId),
          eq(ops.idempotencyKey, input.idempotencyKey),
          eq(ops.opId, eraseId),
        ),
      ),
  ]);
}

/**
 * The reset's two steps under its erase ID, then D1. Asks D1 for an open hold before each step
 * (decision 0026, note 15: every job that erases payload does), never erasing held data; the
 * object refuses a held one too. A step repeated after a crash answers how the intent ended.
 */
async function completeReset(
  db: RegionalDb,
  objects: DataObjects | null,
  artifactId: string,
  payload: DataResetPayload,
  now: number,
): Promise<ResetOutcome> {
  if (objects === null) {
    return {
      ok: false,
      code: "capacity_unavailable",
      message: "Artifact data is unavailable. Try again later.",
      definite: false,
    };
  }
  const object = objects.object(artifactId);
  const envelope = {
    artifactId,
    region: objects.region,
    ownerId: payload.ownerId,
    generation: payload.generation,
    epoch: payload.epoch,
  };
  for (const step of ["prepare", "commit"] as const) {
    if (await isHeld(db, artifactId)) {
      return {
        ok: false,
        code: "forbidden",
        message: HELD_MESSAGE,
        definite: step === "prepare",
        wait: true,
      };
    }
    const answer = (await object.ownerCommand(
      envelope,
      payload.actor,
      { kind: "erase", step, eraseId: payload.eraseId },
      LIFECYCLE_LIMITS,
      now,
    )) as Answer & { value?: { outcome?: string } };
    if (!answer.ok) {
      const error = dataRefusalError(answer.code, answer.message);
      return { ok: false, ...error, definite: step === "prepare", wait: answer.code === "held" };
    }
    const outcome = answer.value?.outcome;
    if (outcome === "cancelled" || outcome === "superseded") {
      return {
        ok: false,
        code: "version_conflict",
        message: "The artifact's data changed; try again.",
        definite: true,
      };
    }
    if (step === "commit") {
      const generation = answer.storage.generation;
      await followReset(db, artifactId, payload, generation, now);
      return { ok: true, generation };
    }
  }
  /* c8 ignore next */
  throw new Error("unreachable");
}

/** D1 follows the object's new generation, records `data.erased` and ends the reset's job. */
async function followReset(
  db: RegionalDb,
  artifactId: string,
  payload: DataResetPayload,
  generation: number,
  now: number,
) {
  const d = schema.artifactData;
  const o = schema.outbox;
  const id = await dataAuditEventId(artifactId, { actor: payload.actor, opId: payload.eraseId });
  const ae = schema.auditEvents;
  await db.batch([
    db
      .update(d)
      .set({ generation, updatedAt: now })
      .where(and(eq(d.artifactId, artifactId), sql`${d.generation} < ${generation}`)),
    auditEvent(
      db,
      {
        id,
        ownerId: payload.ownerId,
        kind: "data.erased",
        actor: { type: "user", id: payload.actor },
        targetId: artifactId,
        artifactId,
        detail: {},
        now: Number(payload.eraseId.slice(0, 13)),
      },
      sql`not exists (select 1 from ${ae} where ${ae.id} = ${id})`,
    ),
    db
      .delete(o)
      .where(
        and(
          eq(o.topic, "data_reset"),
          eq(o.subject, artifactId),
          sql`json_extract(${o.payload}, '$.eraseId') = ${payload.eraseId}`,
        ),
      ),
  ]);
}

/**
 * The `data_reset` job: finishes a reset the request left (a crash between its steps). A held
 * artifact keeps the job a day at a time, erasing nothing; a refusal ends it. Throws without the
 * binding, so the row stays.
 */
export async function runDataReset(
  db: RegionalDb,
  objects: DataObjects | null | undefined,
  row: OutboxRow,
  now: number,
): Promise<"done" | "stale" | "kept"> {
  if (!objects) throw new Error("data_reset needs the documents binding");
  const parsed = DataResetPayloadSchema.safeParse(row.payload);
  if (!parsed.success || row.subject === null) return "stale";
  const result = await completeReset(db, objects, row.subject, parsed.data, now);
  if (result.ok) return "done";
  if (result.wait) {
    await db
      .update(schema.outbox)
      .set({ availableAt: now + DATA_JOB_WAIT_MS, dispatchedAt: null })
      .where(eq(schema.outbox.id, row.id));
    return "kept";
  }
  if (result.code === "capacity_unavailable")
    throw new Error("data_reset could not reach the object");
  return "stale";
}

// Deleting one author's documents (the owner side's moderation; decision 0026).

/**
 * Deletes the documents one author created, collection by collection, in bulk deletes of up to
 * 100 through the same claimed path as any owner-side change (so each is audited and applied
 * once), at most `AUTHOR_DELETE_PAGES` a call; `more` asks the caller to call again. It is not an
 * author erasure: no barrier is set, the author's edits to others' documents stay, and the
 * author may write again (the account deletion's erasure is the terminal one).
 */
export async function deleteAuthorData(
  db: RegionalDb,
  deps: OwnerDataDeps,
  input: OwnerDataWrite & { author: string },
): Promise<Result<{ removed: number; more: boolean }>> {
  const described = await describeArtifactData(db, deps, input);
  if (!described.ok) return described;
  let removed = 0;
  let pages = 0;
  for (const collection of described.value.collections) {
    while (true) {
      if (pages >= AUTHOR_DELETE_PAGES) return ok({ removed, more: true });
      const page = await queryArtifactData(db, deps, {
        ...input,
        query: {
          collection: collection.name,
          equals: { field: "_by", value: input.author },
          limit: ARTIFACT_DATA.caps.bulkDocuments,
        },
      });
      if (!page.ok) return page;
      const ids = page.value.documents.map((doc) => doc._id);
      if (ids.length === 0) break;
      // One key per page of IDs, so a retried call names the same operation for the same page.
      const pageKey = await hashRequest([input.idempotencyKey, collection.name, ids]);
      const deleted = await deleteDataDocuments(db, deps, {
        ...input,
        idempotencyKey: `author-${pageKey.slice(0, 48)}`,
        collection: collection.name,
        ids,
      });
      if (!deleted.ok) return deleted;
      removed += deleted.value.removed;
      pages += 1;
      if (ids.length < ARTIFACT_DATA.caps.bulkDocuments) break;
    }
  }
  return ok({ removed, more: false });
}

// The daily sweep of audit obligations left pending (decision 0026, "Audit with durable states").

/** An obligation pending this long without its event is relayed again. */
export const PENDING_AUDIT_AGE_MS = 3_600_000;
/** Inventory entries one run reads at most. */
export const AUDIT_SWEEP_ENTRIES = 25;
const SWEEP_CURSOR = "data_audit_sweep";

/**
 * Walks the region's inventory a page per run, from `maintenance_cursors`, and asks each object
 * with a D1 row for its obligations pending longer than an hour: each gets its `data_audit` job
 * again (unless one is waiting), so an obligation whose job a restore rewound is still recorded.
 * A pass starts at most once a day (`passStartedAt`). Objects without a D1 row (purged, or never
 * registered) are skipped: their obligations went with their data or never existed.
 */
export async function sweepDataAudit(
  db: RegionalDb,
  bucket: R2Bucket,
  objects: DataObjects | null,
  now: number,
): Promise<{ objects: number; relayed: number }> {
  if (objects === null) return { objects: 0, relayed: 0 };
  const c = schema.maintenanceCursors;
  const [saved] = await db.select().from(c).where(eq(c.name, SWEEP_CURSOR)).limit(1);
  const started = saved?.cursor ?? "";
  if (saved && started === "" && now - saved.passStartedAt < 86_400_000) {
    return { objects: 0, relayed: 0 };
  }
  const listed = await bucket.list({
    prefix: INVENTORY_PREFIX,
    limit: AUDIT_SWEEP_ENTRIES,
    ...(started === "" ? {} : { startAfter: started }),
  });
  let visited = 0;
  let relayed = 0;
  for (const entry of listed.objects) {
    const artifactId = inventoryArtifact(entry.key);
    if (artifactId === null) continue;
    const row = await readDataRow(db, objects.region, artifactId);
    if (row === null) continue;
    visited += 1;
    const pending = await objects.object(artifactId).auditPending(
      {
        artifactId,
        region: objects.region,
        ownerId: row.ownerId,
        generation: row.generation,
        epoch: row.epoch,
      },
      now - PENDING_AUDIT_AGE_MS,
      now,
    );
    for (const obligation of pending) {
      const o = schema.outbox;
      const payload = sql`json_object('ownerId', ${obligation.owner}, 'generation', ${obligation.generation}, 'epoch', ${row.epoch}, 'actor', ${obligation.actor}, 'opId', ${obligation.opId})`;
      const written = await db
        .insert(o)
        .select(
          sql`select null, 'data_audit', ${payload}, ${now}, null, 0, ${now}, ${artifactId}, null where not exists (select 1 from ${o} where ${o.topic} = 'data_audit' and ${o.subject} = ${artifactId} and json_extract(${o.payload}, '$.opId') = ${obligation.opId})`,
        )
        .returning({ id: o.id });
      relayed += written.length;
    }
  }
  const last = listed.objects.at(-1)?.key ?? null;
  const next = listed.truncated && last !== null ? last : "";
  await db
    .insert(c)
    .values({ name: SWEEP_CURSOR, cursor: next, passStartedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: c.name,
      // A new pass records when it started; a resumed one keeps its start.
      set: { cursor: next, updatedAt: now, ...(started === "" ? { passStartedAt: now } : {}) },
    });
  return { objects: visited, relayed };
}
