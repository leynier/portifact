// One artifact's data (decision 0026): a SQLite-backed Durable Object named by the artifact ID
// that speaks only the document API, to the page and to the owner side. Every command follows
// the same shape:
//
// 1. awaits that may yield (hashing the request, leasing owner allowance from the ledger);
// 2. one synchronous transaction that admits the envelope against the control record, looks up
//    the operation record (a replay answers here, before any charge) and charges an upper bound
//    of the work, committed even when it refuses;
// 3. one synchronous transaction that admits the envelope again, checks the operation record and
//    authorization again, and reads or writes.
//
// Nothing runs between 2 and 3, and nothing before 2 decides anything: a hold, a transfer or a
// duplicate that lands during an await is seen by 2 and 3 (finding 1).
import { DurableObject } from "cloudflare:workers";
import {
  type Mode as AdmitMode,
  admit,
  applyFence,
  type Control,
  type Envelope,
  type FenceChange,
  newControl,
} from "./envelope.ts";
import type { Pool } from "./ledger.ts";
import {
  buildQuery,
  type Caller,
  collectionName,
  DataError,
  type DataErrorCode,
  type DataLimits,
  deleteScope,
  documentBody,
  encodeCursor,
  fieldIndex,
  fieldName,
  MAX_PAGE,
  type Mode,
  OWNER_AUTHOR,
  mode as parseMode,
  type QuerySpec,
  readScope,
  uniqueValue,
  writeScope,
} from "./model.ts";

export interface Cost {
  rowsRead: number;
  rowsWritten: number;
}

export type OwnerAllowances = Record<Pool, number>;

/** What the calling Worker states besides the envelope: who calls, the plan's limits, the owner. */
export interface CallContext {
  caller: Caller;
  limits: DataLimits;
  owner: { id: string; allowances: OwnerAllowances };
  now: number;
}

/** The object's storage, reported with every answer, refusals included. */
export interface StorageReport {
  generation: number;
  seq: number;
  bytes: number;
}

/** What a replayed mutation answers: that it was done and what it named, never a body. */
export interface Replay {
  kind: string;
  target: string;
}

export type Outcome<T> =
  | { ok: true; value: T; cost: Cost; storage: StorageReport }
  | { ok: true; replayed: Replay; cost: Cost; storage: StorageReport }
  | { ok: false; error: DataErrorCode; message: string; cost: Cost; storage: StorageReport };

export type Json = string | number | boolean | null | object;

export interface StoredDocument {
  _id: string;
  /** The grant session that created it: attribution, not proof of who typed it. */
  _by: string;
  _editedBy: string | null;
  _created: number;
  _updated: number;
  _seq: number;
  [field: string]: Json;
}

export interface Page {
  documents: StoredDocument[];
  next: string | null;
}

/** One exported document: its server fields and its body exactly as stored. */
export interface ExportRow {
  collection: string;
  id: string;
  by: string;
  editedBy: string | null;
  created: number;
  updated: number;
  body: string;
}

export interface ChangeMessage {
  collection: string;
  kind: "created" | "updated" | "deleted";
  id: string;
  seq: number;
  document?: StoredDocument;
}

interface Attachment {
  socketId: string;
  author: string | null;
  principal: string;
  subscriptions: string[];
  deadline: number;
  window: number;
  messagesIn: number;
  bytesOut: number;
  /** Bytes already reserved against the artifact's day and the owner's lease, not yet sent. */
  reserved: number;
  liveBytesPerDay: number;
}

export const LIVE = {
  messageBytes: 1024,
  /** A page only subscribes; a few messages a minute is all it needs, and each is a billed request. */
  messagesPerMinute: 4,
  bytesOutPerMinute: 256 * 1024,
  subscriptions: 20,
  /** Bytes reserved at a time for a connection: one counter write per chunk, not per message. */
  reserveChunk: 16 * 1024,
} as const;

/**
 * Upper bounds of each command's rows, charged before it runs (measured actual work is below
 * them; a test asserts it). The overhead covers the control record, the collection row, the
 * field list, the operation record and the charge's own counter rows.
 */
export const BOUND = {
  overhead: 30,
  read: { read: MAX_PAGE + 1 + 30, written: 4 },
  get: { read: 30, written: 4 },
  write: { read: 40, written: 40 },
  /** A declaration: the schema on the first one, before any index it builds. */
  declare: { read: 60, written: 60 },
  cleanup: { read: 40, written: 40 },
} as const;
export const LEASE_CHUNK = {
  share: 0.05,
  read: 100_000,
  written: 1_000,
  bytes: 1_000_000,
} as const;
/** How long a mutation's record answers a retry; after it, the ID is a new operation. */
export const REPLAY_MS = 86_400_000;
/** Delivered audit obligations are kept for late settlement this long. */
export const DELIVERED_MS = 7 * 86_400_000;
export const ERASE_CHUNK_MAX = 500;
export const BULK_MAX = 100;
export const EXPORT_PAGE = { rows: 500, bytes: 1024 * 1024 } as const;
/** Rows one alarm prunes from each control table; more wait for the next alarm. */
export const PRUNE_BATCH = 500;
/** The system actor that runs erasure jobs. */
export const ERASURE_ACTOR = "system:erasure";

const SCHEMA = [
  "create table if not exists pf_meta (key text primary key, value) without rowid",
  `create table if not exists pf_collections (name text primary key, mode text not null,
     unique_key text, documents integer not null default 0, bytes integer not null default 0) without rowid`,
  "create table if not exists pf_fields (name text primary key) without rowid",
  `create table if not exists pf_documents (collection text not null, id text not null,
     author text not null, editor text, created integer not null, updated integer not null,
     seq integer not null, unique_value text, body text not null, size integer not null,
     primary key (collection, id)) without rowid`,
  "create index if not exists pf_documents_author on pf_documents (collection, author, created, id)",
  "create index if not exists pf_documents_created on pf_documents (collection, created, id)",
  "create index if not exists pf_documents_by_author on pf_documents (author, collection, id)",
  "create index if not exists pf_documents_by_editor on pf_documents (editor) where editor is not null",
  `create unique index if not exists pf_documents_unique
     on pf_documents (collection, author, unique_value) where unique_value is not null`,
  "create table if not exists pf_seq (scope text primary key, value integer not null) without rowid",
  `create table if not exists pf_rate (subject text not null, kind text not null, window integer not null,
     used integer not null, primary key (subject, kind, window)) without rowid`,
  `create table if not exists pf_day (day integer primary key, read_used integer not null default 0,
     written_used integer not null default 0, cleanup_used integer not null default 0,
     export_used integer not null default 0, live_bytes integer not null default 0)`,
  `create table if not exists pf_lease (pool text primary key, lease_id text not null, owner text not null,
     owner_epoch integer not null, day integer not null, granted integer not null, used integer not null) without rowid`,
  `create table if not exists pf_ops (op_key text primary key, actor text not null, request_hash text not null,
     state text not null, kind text not null, target text not null, result text, at integer not null) without rowid`,
  "create index if not exists pf_ops_actor on pf_ops (actor)",
  "create index if not exists pf_ops_at on pf_ops (at)",
  `create table if not exists pf_audit (op_key text primary key, kind text not null, detail text not null,
     owner text not null, state text not null, at integer not null) without rowid`,
  "create index if not exists pf_audit_state on pf_audit (state, at)",
  "create table if not exists pf_barriers (author text primary key, at integer not null) without rowid",
];

/** Tables of one generation's data; the rest is control and survives an erase. */
const PAYLOAD_TABLES = ["pf_documents", "pf_collections", "pf_fields", "pf_seq", "pf_ops"];

type Row = Record<string, SqlStorageValue>;

interface DocumentRow extends Row {
  id: string;
  author: string;
  editor: string | null;
  created: number;
  updated: number;
  seq: number;
  body: string;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_");
}

function day(now: number): number {
  return Math.floor(now / 86_400_000);
}

function minute(now: number): number {
  return Math.floor(now / 60_000);
}

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function utf8(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Who acts, as operation records and audit name them. */
export function actorOf(caller: Caller): string {
  if (caller.kind === "visitor") return caller.author;
  if (caller.kind === "owner") return `owner:${caller.actor ?? "owner"}`;
  return "reader";
}

/** The full identity of an operation: the same for its record, its audit obligation and D1's event. */
export function operationKey(actor: string, generation: number, opId: string): string {
  return `${actor}|${generation}|${opId}`;
}

type Estimate = { read: number; written: number };
type ChargeKind = "grow" | "read" | "cleanup" | "export";

export class ArtifactDocuments extends DurableObject<Env> {
  #cost: Cost = { rowsRead: 0, rowsWritten: 0 };
  #schemaReady = false;

  #all<T extends Row>(sql: string, ...params: unknown[]): T[] {
    const cursor = this.ctx.storage.sql.exec<T>(sql, ...params);
    const rows = cursor.toArray();
    this.#cost.rowsRead += cursor.rowsRead;
    this.#cost.rowsWritten += cursor.rowsWritten;
    return rows;
  }

  #hasSchema(): boolean {
    if (!this.#schemaReady) {
      this.#schemaReady =
        this.#all("select 1 as found from sqlite_schema where name = 'pf_meta'").length === 1;
    }
    return this.#schemaReady;
  }

  #ensureSchema(): void {
    if (this.#hasSchema()) return;
    for (const statement of SCHEMA) this.#all(statement);
    this.#schemaReady = true;
  }

  #control(): Control | null {
    if (!this.#hasSchema()) return null;
    const [row] = this.#all<{ value: string }>("select value from pf_meta where key = 'control'");
    return row === undefined ? null : (JSON.parse(row.value) as Control);
  }

  #saveControl(control: Control): void {
    this.#all(
      "insert into pf_meta (key, value) values ('control', ?) on conflict (key) do update set value = excluded.value",
      JSON.stringify(control),
    );
  }

  /** Raises the storage sequence (and the payload revision when documents changed). */
  #touch(payload = false): void {
    const control = this.#control();
    if (control === null) return;
    this.#saveControl({
      ...control,
      storageSeq: control.storageSeq + 1,
      payloadRevision: control.payloadRevision + (payload ? 1 : 0),
    });
  }

  #storage(): StorageReport {
    const control = this.#control();
    return {
      generation: control?.generation ?? 0,
      seq: control?.storageSeq ?? 0,
      bytes: this.ctx.storage.sql.databaseSize,
    };
  }

  /**
   * The one validator. An empty object gets a control record only where the mode creates one
   * (a first write); everything else on an empty object sees nothing to do.
   */
  #admit(envelope: Envelope, mode: AdmitMode, now: number): Control | null {
    const stored = this.#control();
    const verdict = admit(stored, envelope, mode);
    if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
    if ("done" in verdict) return null;
    if (stored === null) {
      if (mode.kind !== "request" || !mode.create) return null;
      this.#ensureSchema();
      const control = newControl(envelope, now);
      this.#saveControl(control);
      return control;
    }
    if (verdict.adopt) {
      const adopted = { ...stored, epoch: envelope.epoch };
      this.#saveControl(adopted);
      return adopted;
    }
    return stored;
  }

  #rate(subject: string, kind: string, window: number, limit: number): boolean {
    const [row] = this.#all<{ used: number }>(
      `insert into pf_rate (subject, kind, window, used) values (?, ?, ?, 1)
       on conflict (subject, kind, window) do update set used = used + 1 returning used`,
      subject,
      kind,
      window,
    );
    return (row as { used: number }).used > limit;
  }

  /**
   * Leases owner allowance. The lease is installed only if the control record still names the
   * owner and ownership epoch it was asked for: a transfer during the ledger's await makes the
   * grant obsolete, and it is given back to the ledger once, under its lease ID (finding 1).
   */
  async #lease(context: CallContext, pool: Pool, need: number): Promise<void> {
    const before = this.#control();
    if (before === null) return;
    const today = day(context.now);
    const [lease] = this.#all<{
      owner: string;
      owner_epoch: number;
      day: number;
      granted: number;
      used: number;
    }>("select owner, owner_epoch, day, granted, used from pf_lease where pool = ?", pool);
    const current =
      lease !== undefined &&
      lease.owner === before.ownerId &&
      lease.owner_epoch === before.ownerEpoch &&
      lease.day === today
        ? lease
        : undefined;
    if (current !== undefined && current.granted - current.used >= need) return;
    const limit = context.owner.allowances[pool];
    const chunk =
      pool === "live_bytes"
        ? LEASE_CHUNK.bytes
        : pool === "documents_read" || pool === "export"
          ? LEASE_CHUNK.read
          : LEASE_CHUNK.written;
    const want = Math.max(need, Math.min(Math.ceil(limit * LEASE_CHUNK.share), chunk));
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName(context.owner.id));
    const leaseId = newId();
    const granted = await ledger.lease(pool, today, want, limit);
    const installed = this.ctx.storage.transactionSync(() => {
      const now = this.#control();
      if (now === null || now.ownerId !== before.ownerId || now.ownerEpoch !== before.ownerEpoch)
        return false;
      this.#all(
        `insert into pf_lease (pool, lease_id, owner, owner_epoch, day, granted, used) values (?, ?, ?, ?, ?, ?, 0)
         on conflict (pool) do update set
           granted = case when owner = excluded.owner and owner_epoch = excluded.owner_epoch and day = excluded.day
             then granted + excluded.granted else excluded.granted end,
           used = case when owner = excluded.owner and owner_epoch = excluded.owner_epoch and day = excluded.day
             then used else 0 end,
           lease_id = excluded.lease_id, owner = excluded.owner, owner_epoch = excluded.owner_epoch, day = excluded.day`,
        pool,
        leaseId,
        now.ownerId,
        now.ownerEpoch,
        today,
        granted,
      );
      return true;
    });
    if (!installed) {
      await ledger.giveBack(pool, today, granted, limit, leaseId);
      throw new DataError("stale", "the artifact changed owner");
    }
  }

  async #leases(context: CallContext, estimate: Estimate): Promise<void> {
    if (estimate.written > 0) await this.#lease(context, "documents_written", estimate.written);
    if (estimate.read > 0) await this.#lease(context, "documents_read", estimate.read);
  }

  #spendLease(pool: Pool, amount: number): boolean {
    if (amount === 0) return false;
    const [lease] = this.#all<{ granted: number; used: number }>(
      "update pf_lease set used = used + ? where pool = ? returning granted, used",
      amount,
      pool,
    );
    return lease === undefined || lease.used > lease.granted;
  }

  /**
   * Charges an upper bound of the work, committed whether or not it refuses. Growth and reads
   * spend the artifact's day and the owner's leases; cleanup and export spend their own daily
   * allowances, never the growth budget; every kind can carry a rate.
   */
  #charge(
    context: CallContext,
    kind: ChargeKind,
    rate: { subject: string; kind: string; limit: number } | null,
    estimate: Estimate,
    protect = false,
  ): void {
    if (!this.#hasSchema()) return;
    const refusal = this.ctx.storage.transactionSync(() => {
      this.#touch();
      const today = day(context.now);
      if (rate !== null && this.#rate(rate.subject, rate.kind, minute(context.now), rate.limit)) {
        return {
          code: "rate_limited" as const,
          message: "too many requests, try again in a minute",
        };
      }
      if (kind === "cleanup" || kind === "export") {
        const column = kind === "cleanup" ? "cleanup_used" : "export_used";
        const [row] = this.#all<{ used: number }>(
          `insert into pf_day (day, ${column}) values (?, ?)
           on conflict (day) do update set ${column} = ${column} + excluded.${column} returning ${column} as used`,
          today,
          estimate.read + estimate.written,
        );
        const limit =
          kind === "cleanup" ? context.limits.cleanupRowsPerDay : context.limits.exportRowsPerDay;
        if (protect) return null;
        if ((row as { used: number }).used > limit) {
          return { code: "rate_limited" as const, message: `the day's ${kind} allowance is spent` };
        }
        // Cleanup and export are the owner's own pools too, so every artifact's cleanup and export
        // stays inside the owner's ceiling (finding 9), never inside the growth pools.
        if (this.#spendLease(kind, estimate.read + estimate.written)) {
          return {
            code: "rate_limited" as const,
            message: `the owner's ${kind} allowance for today is spent`,
          };
        }
        return null;
      }
      const [row] = this.#all<{ read_used: number; written_used: number }>(
        `insert into pf_day (day, read_used, written_used) values (?, ?, ?)
         on conflict (day) do update set read_used = read_used + excluded.read_used,
           written_used = written_used + excluded.written_used
         returning read_used, written_used`,
        today,
        estimate.read,
        estimate.written,
      );
      const spent = row as { read_used: number; written_used: number };
      // A read's few control writes are counted but never refuse it: a spent growth day must not
      // stop anyone reading.
      const growth = kind === "grow";
      if (
        spent.read_used > context.limits.rowsReadPerDay ||
        (growth && spent.written_used > context.limits.rowsWrittenPerDay)
      ) {
        return {
          code: "quota_exceeded" as const,
          message: "this artifact's data budget for today is spent",
        };
      }
      const overRead = this.#spendLease("documents_read", estimate.read);
      const overWritten = growth && this.#spendLease("documents_written", estimate.written);
      if (overRead || overWritten) {
        return {
          code: "quota_exceeded" as const,
          message: "the owner's data budget for today is spent",
        };
      }
      return null;
    });
    if (refusal !== null) throw new DataError(refusal.code, refusal.message);
  }

  async #run<T>(work: () => T | Promise<T>, after?: (value: T) => void): Promise<Outcome<T>> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      const value = await work();
      if (value !== null && typeof value === "object" && "__replay" in value) {
        return {
          ok: true,
          replayed: (value as unknown as { __replay: Replay }).__replay,
          cost: this.#cost,
          storage: this.#storage(),
        };
      }
      after?.(value);
      return { ok: true, value, cost: this.#cost, storage: this.#storage() };
    } catch (error) {
      if (error instanceof DataError) {
        return {
          ok: false,
          error: error.code,
          message: error.message,
          cost: this.#cost,
          storage: this.#storage(),
        };
      }
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        return {
          ok: false,
          error: "conflict",
          message: "already exists",
          cost: this.#cost,
          storage: this.#storage(),
        };
      }
      throw error;
    }
  }

  #opKey(envelope: Envelope, actor: string): string | null {
    return envelope.opId === undefined
      ? null
      : operationKey(actor, envelope.generation, envelope.opId);
  }

  /**
   * A recorded operation: the same request replays as "done" after the caller's current
   * authorization was checked; another request under the same key is a conflict; an aborted
   * one stays aborted. Records hold no bodies.
   */
  #replay(
    key: string | null,
    requestHash: string,
    authorize: () => void,
  ): { __replay: Replay; result: string | null } | null {
    if (key === null) return null;
    const [prior] = this.#all<{
      request_hash: string;
      kind: string;
      target: string;
      state: string;
      result: string | null;
    }>("select request_hash, kind, target, state, result from pf_ops where op_key = ?", key);
    if (prior === undefined) return null;
    if (prior.state === "aborted") throw new DataError("conflict", "this operation was abandoned");
    if (prior.request_hash !== requestHash)
      throw new DataError("conflict", "this operation ID was used for another request");
    authorize();
    return { __replay: { kind: prior.kind, target: prior.target }, result: prior.result };
  }

  #record(
    key: string | null,
    actor: string,
    requestHash: string,
    kind: string,
    target: string,
    now: number,
    result: string | null = null,
  ): void {
    if (key === null) return;
    this.#all(
      `insert into pf_ops (op_key, actor, request_hash, state, kind, target, result, at) values (?, ?, ?, 'committed', ?, ?, ?, ?)`,
      key,
      actor,
      requestHash,
      kind,
      target,
      result,
      now,
    );
    this.#scheduleAlarm(now + REPLAY_MS);
  }

  /** An owner-side mutation's audit obligation, under the operation's full identity (finding 11). */
  #audit(key: string | null, ownerId: string, kind: string, detail: object, now: number): void {
    if (key === null) return;
    this.#all(
      "insert into pf_audit (op_key, kind, detail, owner, state, at) values (?, ?, ?, ?, 'pending', ?) on conflict do nothing",
      key,
      kind,
      JSON.stringify(detail),
      ownerId,
      now,
    );
  }

  #nextSeq(scope: string): number {
    const [row] = this.#all<{ value: number }>(
      `insert into pf_seq (scope, value) values (?, 1) on conflict (scope) do update set value = value + 1 returning value`,
      scope,
    );
    return (row as { value: number }).value;
  }

  #collection(name: string): { mode: Mode; uniqueKey: string | null; documents: number } {
    const [row] = this.#all<{ mode: string; unique_key: string | null; documents: number }>(
      "select mode, unique_key, documents from pf_collections where name = ?",
      collectionName(name),
    );
    if (row === undefined) throw new DataError("not_found", "no such collection");
    return { mode: row.mode as Mode, uniqueKey: row.unique_key, documents: row.documents };
  }

  #document(row: DocumentRow): StoredDocument {
    return {
      ...(JSON.parse(row.body) as Record<string, Json>),
      _id: row.id,
      _by: row.author,
      _editedBy: row.editor,
      _created: row.created,
      _updated: row.updated,
      _seq: row.seq,
    };
  }

  /**
   * Growth is refused when the documents' own bytes pass the plan's size, or when the database
   * file passes it plus the room kept for control records. A change that does not grow either
   * (a smaller replacement, a deletion) always goes through.
   */
  #checkGrowth(before: number, limits: DataLimits, grew: number): void {
    const after = this.ctx.storage.sql.databaseSize;
    const [row] = this.#all<{ n: number }>(
      "select coalesce(sum(bytes), 0) as n from pf_collections",
    );
    const data = (row as { n: number }).n;
    if (
      (grew > 0 && data > limits.bytesPerArtifact) ||
      (after > before && after > limits.bytesPerArtifact + CONTROL_RESERVE)
    ) {
      throw new DataError("quota_exceeded", "this artifact's data is full");
    }
  }

  #barred(author: string): boolean {
    return this.#all("select 1 from pf_barriers where author = ?", author).length > 0;
  }

  /** The documents an index over a new field would cover: what building it can write at most. */
  #documentCount(): number {
    if (!this.#hasSchema()) return 0;
    const [row] = this.#all<{ n: number }>(
      "select coalesce(sum(documents), 0) as n from pf_collections",
    );
    return (row as { n: number }).n;
  }

  async declareCollection(
    envelope: Envelope,
    context: CallContext,
    input: { name: string; mode: string; uniqueKey?: string; indexed?: string[] },
  ): Promise<Outcome<{ name: string; mode: Mode }>> {
    const actor = actorOf(context.caller);
    const key = this.#opKey(envelope, actor);
    const requestHash = await hash(["declare", input]);
    return this.#run(async () => {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      // An index over a new field writes one entry per existing document: its bound is reserved
      // before it is built (finding 9).
      const fields = (input.indexed ?? []).length;
      const estimate = {
        read: BOUND.declare.read + fields * this.#documentCount(),
        written: BOUND.declare.written + fields * this.#documentCount(),
      };
      const replay = this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: true }, context.now);
        return this.#replay(key, requestHash, () => {});
      });
      if (replay !== null) return replay as never;
      await this.#leases(context, estimate);
      this.ctx.storage.transactionSync(() =>
        this.#admit(envelope, { kind: "request", create: true }, context.now),
      );
      this.#charge(context, "grow", null, estimate);
      return this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: true }, context.now);
        const again = this.#replay(key, requestHash, () => {});
        if (again !== null) return again as never;
        this.#touch(true);
        const name = collectionName(input.name);
        const chosen = parseMode(input.mode);
        const [count] = this.#all<{ n: number }>("select count(*) as n from pf_collections");
        const exists = this.#all("select 1 from pf_collections where name = ?", name).length;
        if (exists === 0 && (count as { n: number }).n >= context.limits.collections) {
          throw new DataError(
            "quota_exceeded",
            `at most ${context.limits.collections} collections`,
          );
        }
        const uniqueKey = input.uniqueKey === undefined ? null : fieldName(input.uniqueKey);
        this.#all(
          `insert into pf_collections (name, mode, unique_key) values (?, ?, ?) on conflict (name) do update set mode = excluded.mode`,
          name,
          chosen,
          uniqueKey,
        );
        for (const field of input.indexed ?? []) {
          fieldName(field);
          if (this.#all("select 1 from pf_fields where name = ?", field).length === 0) {
            const [present] = this.#all<{ n: number }>("select count(*) as n from pf_fields");
            if ((present as { n: number }).n >= context.limits.indexedFields) {
              throw new DataError("quota_exceeded", "too many indexed fields");
            }
            this.#all("insert into pf_fields (name) values (?)", field);
            this.#all(
              `create index ${fieldIndex(field)} on pf_documents (collection, json_extract(body, '$.${field}'), created, id)`,
            );
          }
        }
        this.#record(key, actor, requestHash, "collection", name, context.now);
        this.#audit(key, envelope.ownerId, "data.collection_set", { mode: chosen }, context.now);
        return { name, mode: chosen };
      });
    });
  }

  async create(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    body: unknown,
  ): Promise<Outcome<StoredDocument>> {
    const caller = context.caller;
    const actor = actorOf(caller);
    const key = this.#opKey(envelope, actor);
    const requestHash = await hash(["create", collection, body]);
    const author = caller.kind === "visitor" ? caller.author : OWNER_AUTHOR;
    const authorize = () => {
      if (writeScope(this.#collection(collection).mode, caller) === "none") {
        throw new DataError("forbidden", "you cannot write to this collection");
      }
      if (caller.kind === "visitor" && this.#barred(author))
        throw new DataError("forbidden", "this author's data was erased");
    };
    return this.#run(
      async () => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such collection");
        await this.#leases(context, BOUND.write);
        if (this.ctx.getWebSockets().length > 0)
          await this.#lease(context, "live_bytes", LIVE.reserveChunk);
        const replay = this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          return this.#replay(key, requestHash, authorize);
        });
        if (replay !== null) return replay as never;
        this.#charge(
          context,
          "grow",
          caller.kind === "visitor"
            ? { subject: author, kind: "writes", limit: context.limits.writesPerAuthorPerMinute }
            : null,
          BOUND.write,
        );
        return this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          const again = this.#replay(key, requestHash, authorize);
          if (again !== null) return again as never;
          authorize();
          this.#touch(true);
          const before = this.ctx.storage.sql.databaseSize;
          const target = this.#collection(collection);
          if (target.documents >= context.limits.documentsPerCollection) {
            throw new DataError(
              "quota_exceeded",
              `a collection holds at most ${context.limits.documentsPerCollection} documents`,
            );
          }
          const { text, size } = documentBody(body, context.limits.documentBytes);
          const unique =
            target.uniqueKey === null
              ? null
              : uniqueValue(body as Record<string, unknown>, target.uniqueKey);
          const id = newId();
          const seq = this.#nextSeq(
            target.mode === "own" ? `author:${author}` : `collection:${collection}`,
          );
          this.#all(
            `insert into pf_documents (collection, id, author, editor, created, updated, seq, unique_value, body, size)
             values (?, ?, ?, null, ?, ?, ?, ?, ?, ?)`,
            collection,
            id,
            author,
            context.now,
            context.now,
            seq,
            unique,
            text,
            size,
          );
          this.#all(
            "update pf_collections set documents = documents + 1, bytes = bytes + ? where name = ?",
            size,
            collection,
          );
          this.#checkGrowth(before, context.limits, size);
          this.#record(key, actor, requestHash, "document", `${collection}/${id}`, context.now);
          if (caller.kind === "owner")
            this.#audit(
              key,
              envelope.ownerId,
              "data.document_created",
              { bytes: size },
              context.now,
            );
          return this.#document({
            id,
            author,
            editor: null,
            created: context.now,
            updated: context.now,
            seq,
            body: text,
          });
        });
      },
      (document) =>
        this.#notify(collection, document._by, {
          collection,
          kind: "created",
          id: document._id,
          seq: document._seq,
          document,
        }),
    );
  }

  /**
   * Replaces a body. One that does not grow the document is charged to cleanup, but still under
   * the author's write rate (finding 16); one that grows is charged as growth.
   */
  async replace(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
    body: unknown,
  ): Promise<Outcome<StoredDocument>> {
    const caller = context.caller;
    const actor = actorOf(caller);
    const key = this.#opKey(envelope, actor);
    const requestHash = await hash(["replace", collection, id, body]);
    const authorize = () => {
      if (writeScope(this.#collection(collection).mode, caller) === "none") {
        throw new DataError("forbidden", "you cannot write to this collection");
      }
      if (caller.kind === "visitor" && this.#barred(caller.author))
        throw new DataError("forbidden", "this author's data was erased");
    };
    return this.#run(
      async () => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
        // Whether it shrinks is decided after the awaits, so both pools are leased first.
        await this.#leases(context, BOUND.write);
        await this.#lease(context, "cleanup", BOUND.write.read + BOUND.write.written);
        if (this.ctx.getWebSockets().length > 0)
          await this.#lease(context, "live_bytes", LIVE.reserveChunk);
        const decided = this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          const replay = this.#replay(key, requestHash, authorize);
          if (replay !== null) return replay;
          const [old] = this.#all<{ size: number }>(
            "select size from pf_documents where collection = ? and id = ?",
            collection,
            id,
          );
          return { shrinks: old !== undefined && utf8(JSON.stringify(body)) <= old.size };
        });
        if ("__replay" in decided) return decided as never;
        const rate =
          caller.kind === "visitor"
            ? {
                subject: caller.author,
                kind: "writes",
                limit: context.limits.writesPerAuthorPerMinute,
              }
            : null;
        this.#charge(context, decided.shrinks ? "cleanup" : "grow", rate, BOUND.write);
        return this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          const again = this.#replay(key, requestHash, authorize);
          if (again !== null) return again as never;
          authorize();
          this.#touch(true);
          const before = this.ctx.storage.sql.databaseSize;
          const target = this.#collection(collection);
          const scope = writeScope(target.mode, caller);
          const { text, size } = documentBody(body, context.limits.documentBytes);
          const unique =
            target.uniqueKey === null
              ? null
              : uniqueValue(body as Record<string, unknown>, target.uniqueKey);
          const own = scope === "own" ? " and author = ?" : "";
          const mine = scope === "own" && caller.kind === "visitor" ? [caller.author] : [];
          const [old] = this.#all<{ size: number; author: string; created: number }>(
            `select size, author, created from pf_documents where collection = ? and id = ?${own}`,
            collection,
            id,
            ...mine,
          );
          if (old === undefined) throw new DataError("not_found", "no such document");
          const editorId = caller.kind === "visitor" ? caller.author : OWNER_AUTHOR;
          const editor = editorId === old.author ? null : editorId;
          const seq = this.#nextSeq(
            target.mode === "own" ? `author:${old.author}` : `collection:${collection}`,
          );
          this.#all(
            `update pf_documents set body = ?, size = ?, updated = ?, seq = ?, unique_value = ?, editor = ?
             where collection = ? and id = ?${own}`,
            text,
            size,
            context.now,
            seq,
            unique,
            editor,
            collection,
            id,
            ...mine,
          );
          this.#all(
            "update pf_collections set bytes = bytes + ? where name = ?",
            size - old.size,
            collection,
          );
          this.#checkGrowth(before, context.limits, size - old.size);
          this.#record(key, actor, requestHash, "document", `${collection}/${id}`, context.now);
          if (caller.kind === "owner")
            this.#audit(
              key,
              envelope.ownerId,
              "data.document_replaced",
              { bytes: size },
              context.now,
            );
          return this.#document({
            id,
            author: old.author,
            editor,
            created: old.created,
            updated: context.now,
            seq,
            body: text,
          });
        });
      },
      (document) =>
        this.#notify(collection, document._by, {
          collection,
          kind: "updated",
          id,
          seq: document._seq,
          document,
        }),
    );
  }

  /**
   * Deletes a document: cleanup, under the author's delete rate, never refused by the growth
   * budget or the terms; a visitor may always delete what they created.
   */
  async remove(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
  ): Promise<Outcome<{ id: string; author: string; seq: number }>> {
    const caller = context.caller;
    const actor = actorOf(caller);
    const key = this.#opKey(envelope, actor);
    const requestHash = await hash(["remove", collection, id]);
    const authorize = () => {
      if (deleteScope(this.#collection(collection).mode, caller) === "none") {
        throw new DataError("forbidden", "you cannot delete in this collection");
      }
    };
    return this.#run(
      async () => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
        await this.#lease(context, "cleanup", BOUND.cleanup.read + BOUND.cleanup.written);
        if (this.ctx.getWebSockets().length > 0)
          await this.#lease(context, "live_bytes", LIVE.reserveChunk);
        const replay = this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          return this.#replay(key, requestHash, authorize);
        });
        if (replay !== null) return replay as never;
        this.#charge(
          context,
          "cleanup",
          caller.kind === "visitor"
            ? {
                subject: caller.author,
                kind: "deletes",
                limit: context.limits.deletesPerAuthorPerMinute,
              }
            : null,
          BOUND.cleanup,
        );
        return this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          const again = this.#replay(key, requestHash, authorize);
          if (again !== null) return again as never;
          authorize();
          this.#touch(true);
          const target = this.#collection(collection);
          const scope = deleteScope(target.mode, caller);
          const own = scope === "own" ? " and author = ?" : "";
          const mine = scope === "own" && caller.kind === "visitor" ? [caller.author] : [];
          const [gone] = this.#all<{ size: number; author: string }>(
            `delete from pf_documents where collection = ? and id = ?${own} returning size, author`,
            collection,
            id,
            ...mine,
          );
          if (gone === undefined) throw new DataError("not_found", "no such document");
          this.#all(
            "update pf_collections set documents = documents - 1, bytes = bytes - ? where name = ?",
            gone.size,
            collection,
          );
          const seq = this.#nextSeq(
            target.mode === "own" ? `author:${gone.author}` : `collection:${collection}`,
          );
          this.#record(key, actor, requestHash, "deleted", `${collection}/${id}`, context.now);
          if (caller.kind === "owner")
            this.#audit(key, envelope.ownerId, "data.document_deleted", {}, context.now);
          return { id, author: gone.author, seq };
        });
      },
      (gone) =>
        this.#notify(collection, gone.author, { collection, kind: "deleted", id, seq: gone.seq }),
    );
  }

  /**
   * The owner side deletes up to BULK_MAX documents of one collection in one operation (cleanup
   * allowance, one operation record, one audit obligation).
   */
  async bulkRemove(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    ids: string[],
  ): Promise<Outcome<{ removed: number }>> {
    const actor = actorOf(context.caller);
    const key = this.#opKey(envelope, actor);
    const requestHash = await hash(["bulk_remove", collection, ids]);
    return this.#run(async () => {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      if (ids.length === 0 || ids.length > BULK_MAX)
        throw new DataError("invalid_input", `between 1 and ${BULK_MAX} documents`);
      if (!this.#hasSchema()) throw new DataError("not_found", "no such collection");
      const estimate = {
        read: BOUND.overhead + ids.length * 4,
        written: BOUND.overhead + ids.length * 6,
      };
      await this.#lease(context, "cleanup", estimate.read + estimate.written);
      const replay = this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: false }, context.now);
        return this.#replay(key, requestHash, () => {});
      });
      if (replay !== null) return replay as never;
      this.#charge(context, "cleanup", null, estimate);
      return this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: false }, context.now);
        const again = this.#replay(key, requestHash, () => {});
        if (again !== null) return again as never;
        this.#collection(collection);
        this.#touch(true);
        let removed = 0;
        let bytes = 0;
        for (const id of ids) {
          const [gone] = this.#all<{ size: number }>(
            "delete from pf_documents where collection = ? and id = ? returning size",
            collection,
            id,
          );
          if (gone !== undefined) {
            removed += 1;
            bytes += gone.size;
          }
        }
        this.#all(
          "update pf_collections set documents = documents - ?, bytes = bytes - ? where name = ?",
          removed,
          bytes,
          collection,
        );
        this.#record(
          key,
          actor,
          requestHash,
          "bulk_deleted",
          collection,
          context.now,
          JSON.stringify({ removed }),
        );
        this.#audit(
          key,
          envelope.ownerId,
          "data.documents_deleted",
          { documents: removed },
          context.now,
        );
        return { removed };
      });
    });
  }

  /** Per-caller read rates live in memory: they shape traffic; the spend is durable. */
  #readCounts = new Map<string, number>();

  #readLimited(context: CallContext): boolean {
    const caller = context.caller;
    if (caller.kind === "owner") return false;
    const key = `${caller.kind === "visitor" ? caller.author : "readers"}:${minute(context.now)}`;
    const used = (this.#readCounts.get(key) ?? 0) + 1;
    if (this.#readCounts.size > 10_000) this.#readCounts.clear();
    this.#readCounts.set(key, used);
    return used > context.limits.readsPerCallerPerMinute;
  }

  /** Reads: leases, then the charge and the read in two transactions with nothing between. */
  async #read<T>(
    envelope: Envelope,
    context: CallContext,
    estimate: Estimate,
    work: () => T,
    operator = false,
  ): Promise<Outcome<T>> {
    return this.#run(async () => {
      if (!operator) await this.#lease(context, "documents_read", estimate.read);
      const mode: AdmitMode = operator ? { kind: "operator" } : { kind: "request", create: false };
      if (!this.#hasSchema()) return work();
      if (!operator && this.#readLimited(context))
        throw new DataError("rate_limited", "too many reads, try again in a minute");
      this.ctx.storage.transactionSync(() => this.#admit(envelope, mode, context.now));
      this.#charge(context, operator ? "export" : "read", null, estimate, operator);
      return this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, mode, context.now);
        return work();
      });
    });
  }

  async get(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
  ): Promise<Outcome<StoredDocument>> {
    return this.#read(envelope, context, BOUND.get, () => {
      if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
      const target = this.#collection(collection);
      const scope = readScope(target.mode, context.caller);
      if (scope === "none") throw new DataError("not_found", "no such document");
      const caller = context.caller;
      const own = scope === "own" ? " and author = ?" : "";
      const mine = scope === "own" && caller.kind === "visitor" ? [caller.author] : [];
      const [row] = this.#all<DocumentRow>(
        `select id, author, editor, created, updated, seq, body from pf_documents where collection = ? and id = ?${own}`,
        collection,
        id,
        ...mine,
      );
      if (row === undefined) throw new DataError("not_found", "no such document");
      return this.#document(row);
    });
  }

  async query(envelope: Envelope, context: CallContext, spec: QuerySpec): Promise<Outcome<Page>> {
    return this.#read(envelope, context, BOUND.read, () => {
      if (!this.#hasSchema()) return { documents: [], next: null };
      const target = this.#collection(spec.collection);
      const scope = readScope(target.mode, context.caller);
      if (scope === "none") return { documents: [], next: null };
      const caller = context.caller;
      const author = caller.kind === "visitor" ? caller.author : null;
      const indexed = this.#all<{ name: string }>("select name from pf_fields").map(
        (row) => row.name,
      );
      const { sql, params, limit } = buildQuery(spec, scope, author, indexed);
      const rows = this.#all<DocumentRow>(sql, ...params);
      const documents = rows.slice(0, limit).map((row) => this.#document(row));
      const last = documents.at(-1);
      return {
        documents,
        next:
          rows.length > limit && last !== undefined ? encodeCursor(last._created, last._id) : null,
      };
    });
  }

  /**
   * The owner side's counts: a collection's documents from its counter (one row), or one
   * author's documents through the author index, charged at the collection's cap.
   */
  async count(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    by?: string,
  ): Promise<Outcome<{ documents: number }>> {
    const estimate = {
      read: BOUND.overhead + (by === undefined ? 0 : context.limits.documentsPerCollection),
      written: 4,
    };
    return this.#read(envelope, context, estimate, () => {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      if (!this.#hasSchema()) return { documents: 0 };
      const target = this.#collection(collection);
      if (by === undefined) return { documents: target.documents };
      const [row] = this.#all<{ n: number }>(
        "select count(*) as n from pf_documents indexed by pf_documents_author where collection = ? and author = ?",
        collection,
        by,
      );
      return { documents: (row as { n: number }).n };
    });
  }

  explainQuery(spec: QuerySpec, scope: "all" | "own", indexed: string[]): string[] {
    const { sql, params } = buildQuery(spec, scope, "v_x", indexed);
    return this.ctx.storage.sql
      .exec<{ detail: string }>(`explain query plan ${sql}`, ...params)
      .toArray()
      .map((row) => row.detail);
  }

  /**
   * Erases one author, in bounded, idempotent chunks (findings 8, 10, 17). The first chunk sets
   * the author's barrier (on an empty object too), closes the author's live connections and
   * deletes their sequence; every chunk deletes at most `chunk` of the author's documents, rewrites
   * at most `chunk` of their edits on others' documents to `erased`, and deletes at most `chunk`
   * of their operation and rate rows, through author-first indexes. A chunk with an operation
   * ID is recorded with its result, so a retry replays it instead of erasing more.
   */
  async eraseAuthorChunk(
    envelope: Envelope,
    author: string,
    chunk: number,
    context?: CallContext,
  ): Promise<Outcome<{ erased: number; more: boolean }>> {
    const take = Math.min(Math.max(chunk, 1), ERASE_CHUNK_MAX);
    const key = this.#opKey(envelope, ERASURE_ACTOR);
    const requestHash = await hash(["erase_author", author, take]);
    return this.#run(() => {
      const now = context?.now ?? Date.now();
      const replay = this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: true }, now);
        return this.#replay(key, requestHash, () => {});
      });
      if (replay !== null) {
        if (replay.result !== null)
          return JSON.parse(replay.result) as { erased: number; more: boolean };
        return replay as never;
      }
      if (context !== undefined)
        this.#charge(
          context,
          "cleanup",
          null,
          { read: take * 4 + BOUND.overhead, written: take * 6 + BOUND.overhead },
          true,
        );
      return this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: true }, now);
        const again = this.#replay(key, requestHash, () => {});
        if (again !== null && again.result !== null)
          return JSON.parse(again.result) as { erased: number; more: boolean };
        const first =
          this.#all(
            "insert into pf_barriers (author, at) values (?, ?) on conflict do nothing returning 1",
            author,
            now,
          ).length > 0;
        if (first) {
          for (const socket of this.ctx.getWebSockets(`author:${author}`))
            socket.close(4410, "erased");
          this.#all("delete from pf_seq where scope = ?", `author:${author}`);
        }
        const gone = this.#all<{ collection: string; size: number }>(
          `delete from pf_documents where (author, collection, id) in
             (select author, collection, id from pf_documents indexed by pf_documents_by_author where author = ? limit ?)
           returning collection, size`,
          author,
          take,
        );
        const byCollection = new Map<string, { documents: number; bytes: number }>();
        for (const row of gone) {
          const entry = byCollection.get(row.collection) ?? { documents: 0, bytes: 0 };
          byCollection.set(row.collection, {
            documents: entry.documents + 1,
            bytes: entry.bytes + row.size,
          });
        }
        for (const [name, entry] of byCollection) {
          this.#all(
            "update pf_collections set documents = documents - ?, bytes = bytes - ? where name = ?",
            entry.documents,
            entry.bytes,
            name,
          );
        }
        const edits = this.#all(
          `update pf_documents set editor = 'erased' where (collection, id) in
             (select collection, id from pf_documents indexed by pf_documents_by_editor where editor = ? limit ?) returning 1`,
          author,
          take,
        );
        const ops = this.#all(
          "delete from pf_ops where op_key in (select op_key from pf_ops indexed by pf_ops_actor where actor = ? limit ?) returning 1",
          author,
          take,
        );
        const rates = this.#all(
          "delete from pf_rate where (subject, kind, window) in (select subject, kind, window from pf_rate where subject = ? limit ?) returning 1",
          author,
          take,
        );
        const more =
          gone.length === take ||
          edits.length === take ||
          ops.length === take ||
          rates.length === take ||
          this.#all(
            "select 1 from pf_documents indexed by pf_documents_by_author where author = ? limit 1",
            author,
          ).length > 0;
        this.#touch(gone.length > 0 || edits.length > 0);
        const result = { erased: gone.length, more };
        this.#record(
          key,
          ERASURE_ACTOR,
          requestHash,
          "author_erased",
          author,
          now,
          JSON.stringify(result),
        );
        this.#audit(
          key,
          envelope.ownerId,
          "data.author_erased",
          { documents: gone.length, edits: edits.length },
          now,
        );
        return result;
      });
    });
  }

  /**
   * The barrier (finding 6): validated against the generation and the owner, idempotent by the
   * transition's ID, persisted before it is acknowledged, on an empty object too.
   */
  fence(
    envelope: Envelope,
    change: FenceChange,
  ): Outcome<{ epoch: number; held: boolean; ownerId: string }> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    return this.ctx.storage.transactionSync(() => {
      this.#ensureSchema();
      const stored = this.#control();
      const applied = applyFence(stored, envelope, change, Date.now());
      if (!applied.ok)
        return {
          ok: false as const,
          error: applied.error,
          message: applied.message,
          cost: this.#cost,
          storage: this.#storage(),
        };
      if (!applied.repeated) {
        this.#saveControl(applied.control);
        if (stored !== null && applied.control.ownerId !== stored.ownerId)
          this.#all("delete from pf_lease");
        if (
          applied.control.hold !== null ||
          (stored !== null && applied.control.ownerId !== stored.ownerId)
        )
          this.closeConnections(4003);
      }
      return {
        ok: true as const,
        value: {
          epoch: applied.control.epoch,
          held: applied.control.hold !== null,
          ownerId: applied.control.ownerId,
        },
        cost: this.#cost,
        storage: this.#storage(),
      };
    });
  }

  /** Reconciliation's quarantine; nothing but the operator acts on the data until it is resolved. */
  quarantine(envelope: Envelope, reason: "owner" | "hold"): boolean {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#control();
      if (
        stored === null ||
        stored.artifactId !== envelope.artifactId ||
        stored.region !== envelope.region
      )
        return false;
      this.#saveControl({
        ...stored,
        quarantine: { reason, at: Date.now() },
        storageSeq: stored.storageSeq + 1,
      });
      this.closeConnections(4003);
      return true;
    });
  }

  /**
   * The operator's exit from a quarantine: `adopt` when D1 now names the owner the object
   * recorded (the envelope must name it), or `erase`, which moves to the next generation and
   * clears the quarantine in one transaction. A hold is left as it is.
   */
  resolveQuarantine(
    envelope: Envelope,
    decision: "adopt" | "erase",
  ): { ok: boolean; message?: string } {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#control();
      if (stored === null || stored.quarantine === null)
        return { ok: false, message: "nothing to resolve" };
      const verdict = admit(stored, envelope, { kind: "operator" });
      if (!verdict.ok) return { ok: false, message: verdict.message };
      if (decision === "erase") {
        this.#erasePayload();
        this.#saveControl({
          ...stored,
          generation: stored.generation + 1,
          erasing: null,
          quarantine: null,
          storageSeq: stored.storageSeq + 1,
          payloadRevision: stored.payloadRevision + 1,
        });
      } else {
        this.#saveControl({ ...stored, quarantine: null, storageSeq: stored.storageSeq + 1 });
      }
      return { ok: true };
    });
  }

  controlRecord(): Control | null {
    return this.#control();
  }

  /** Erase, step one: the shared validator; adopts the epoch it accepts; creates the control record on an empty object. */
  prepareErase(envelope: Envelope): Outcome<{ prepared: boolean }> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      return this.ctx.storage.transactionSync(() => {
        const stored = this.#control();
        const verdict = admit(stored, envelope, { kind: "erase" });
        if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
        if ("done" in verdict)
          return {
            ok: true as const,
            value: { prepared: false },
            cost: this.#cost,
            storage: this.#storage(),
          };
        this.#ensureSchema();
        const base = stored ?? newControl(envelope, Date.now());
        this.#saveControl({
          ...base,
          epoch: Math.max(base.epoch, envelope.epoch),
          erasing: { generation: envelope.generation, epoch: envelope.epoch },
          storageSeq: base.storageSeq + 1,
        });
        return {
          ok: true as const,
          value: { prepared: true },
          cost: this.#cost,
          storage: this.#storage(),
        };
      });
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
      return {
        ok: false,
        error: error.code,
        message: error.message,
        cost: this.#cost,
        storage: this.#storage(),
      };
    }
  }

  #erasePayload(): void {
    for (const { name } of this.#all<{ name: string }>("select name from pf_fields"))
      this.#all(`drop index if exists ${fieldIndex(name)}`);
    for (const table of PAYLOAD_TABLES) this.#all(`delete from ${table}`);
    this.closeConnections(4404);
  }

  /**
   * Erase, step two: one transaction deletes the payload and writes the next generation into the
   * control record, which keeps budgets, leases, barriers and audit obligations. A retry finds the
   * next generation and does nothing; on an empty object the record is the generation barrier.
   */
  commitErase(envelope: Envelope): Outcome<{ erased: boolean }> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      return this.ctx.storage.transactionSync(() => {
        const stored = this.#control();
        const verdict = admit(stored, envelope, { kind: "erase" });
        if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
        if (
          "done" in verdict ||
          stored === null ||
          stored.erasing === null ||
          stored.erasing.generation !== envelope.generation
        ) {
          return {
            ok: true as const,
            value: { erased: false },
            cost: this.#cost,
            storage: this.#storage(),
          };
        }
        this.#erasePayload();
        this.#saveControl({
          ...stored,
          generation: stored.generation + 1,
          erasing: null,
          storageSeq: stored.storageSeq + 1,
          payloadRevision: stored.payloadRevision + 1,
        });
        return {
          ok: true as const,
          value: { erased: true },
          cost: this.#cost,
          storage: this.#storage(),
        };
      });
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
      return {
        ok: false,
        error: error.code,
        message: error.message,
        cost: this.#cost,
        storage: this.#storage(),
      };
    }
  }

  cancelErase(envelope: Envelope): boolean {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#control();
      const verdict = admit(stored, envelope, { kind: "erase" });
      if (!verdict.ok || "done" in verdict || stored === null || stored.erasing === null)
        return false;
      this.#saveControl({ ...stored, erasing: null, storageSeq: stored.storageSeq + 1 });
      return true;
    });
  }

  /**
   * The audit relay's question (finding 11): the operation's full identity is the actor, the
   * generation the operation ran in and its ID. Answers a committed obligation (delivered or
   * not), a committed operation without one, or records the operation as aborted so a late
   * arrival cannot commit. Maintenance admission: artifact and region must match.
   */
  settle(
    envelope: Envelope,
    actor: string,
    opId: string,
  ):
    | { state: "committed"; kind: string; detail: string; delivered: boolean }
    | { state: "aborted" }
    | { state: "refused" } {
    return this.ctx.storage.transactionSync(() => {
      try {
        this.#admit(envelope, { kind: "maintenance" }, Date.now());
      } catch {
        return { state: "refused" as const };
      }
      this.#ensureSchema();
      const key = operationKey(actor, envelope.generation, opId);
      const [obligation] = this.#all<{ kind: string; detail: string; state: string }>(
        "select kind, detail, state from pf_audit where op_key = ?",
        key,
      );
      if (obligation !== undefined) {
        return {
          state: "committed" as const,
          kind: obligation.kind,
          detail: obligation.detail,
          delivered: obligation.state === "delivered",
        };
      }
      const [record] = this.#all<{ state: string; kind: string }>(
        "select state, kind from pf_ops where op_key = ?",
        key,
      );
      if (record?.state === "committed")
        return { state: "committed" as const, kind: record.kind, detail: "{}", delivered: true };
      if (record === undefined) {
        this.#touch();
        this.#all(
          "insert into pf_ops (op_key, actor, request_hash, state, kind, target, at) values (?, ?, '', 'aborted', 'aborted', '', ?)",
          key,
          actor,
          Date.now(),
        );
        this.#scheduleAlarm(Date.now() + REPLAY_MS);
      }
      return { state: "aborted" as const };
    });
  }

  /** Marks an obligation delivered; kept for late settlement, pruned after DELIVERED_MS. */
  acknowledge(envelope: Envelope, actor: string, opId: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      try {
        this.#admit(envelope, { kind: "maintenance" }, Date.now());
      } catch {
        return false;
      }
      if (!this.#hasSchema()) return false;
      const key = operationKey(actor, envelope.generation, opId);
      const updated = this.#all(
        "update pf_audit set state = 'delivered', at = ? where op_key = ? and state = 'pending' returning 1",
        Date.now(),
        key,
      );
      if (updated.length > 0) {
        this.#touch();
        this.#scheduleAlarm(Date.now() + DELIVERED_MS);
      }
      return updated.length > 0;
    });
  }

  auditFor(key: string): { kind: string; detail: string; state: string } | null {
    if (!this.#hasSchema()) return null;
    const [row] = this.ctx.storage.sql
      .exec<{ kind: string; detail: string; state: string }>(
        "select kind, detail, state from pf_audit where op_key = ?",
        key,
      )
      .toArray();
    return row ?? null;
  }

  budget(now: number): Record<string, number> {
    if (!this.#hasSchema()) return {};
    const [today] = this.ctx.storage.sql
      .exec<{
        read_used: number;
        written_used: number;
        cleanup_used: number;
        export_used: number;
        live_bytes: number;
      }>(
        "select read_used, written_used, cleanup_used, export_used, live_bytes from pf_day where day = ?",
        day(now),
      )
      .toArray();
    return {
      rows_read: today?.read_used ?? 0,
      rows_written: today?.written_used ?? 0,
      cleanup: today?.cleanup_used ?? 0,
      export: today?.export_used ?? 0,
      live_bytes: today?.live_bytes ?? 0,
    };
  }

  size(): StorageReport {
    return this.#storage();
  }

  /**
   * One export page (finding 12): documents in primary key order after `after`, each with its
   * server fields and its body exactly as stored, stopped at EXPORT_PAGE rows or bytes (a single
   * document larger than the byte cap still makes a page of one), with the payload revision,
   * which only changes to the documents move. The owner side, or the operator under a hold.
   */
  async exportPage(
    envelope: Envelope,
    context: CallContext,
    after: { collection: string; id: string } | null,
    limit: number,
    operator = false,
  ): Promise<
    Outcome<{
      rows: ExportRow[];
      next: { collection: string; id: string } | null;
      revision: number;
      bytes: number;
    }>
  > {
    const take = Math.min(Math.max(limit, 1), EXPORT_PAGE.rows);
    return this.#run(async () => {
      if (!operator && context.caller.kind !== "owner")
        throw new DataError("forbidden", "owner side only");
      if (!this.#hasSchema()) return { rows: [], next: null, revision: 0, bytes: 0 };
      if (!operator) await this.#lease(context, "export", take + BOUND.overhead + 4);
      this.ctx.storage.transactionSync(() =>
        this.#admit(
          envelope,
          operator ? { kind: "operator" } : { kind: "request", create: false },
          context.now,
        ),
      );
      this.#charge(context, "export", null, { read: take + BOUND.overhead, written: 4 }, operator);
      return this.ctx.storage.transactionSync(() => {
        this.#admit(
          envelope,
          operator ? { kind: "operator" } : { kind: "request", create: false },
          context.now,
        );
        const cursor = this.ctx.storage.sql.exec<DocumentRow & { collection: string }>(
          `select collection, id, author, editor, created, updated, seq, body from pf_documents
           where (collection, id) > (?, ?) order by collection, id limit ?`,
          after?.collection ?? "",
          after?.id ?? "",
          take + 1,
        );
        const rows: ExportRow[] = [];
        let bytes = 0;
        let cut = false;
        for (const row of cursor) {
          const exported: ExportRow = {
            collection: row.collection,
            id: row.id,
            by: row.author,
            editedBy: row.editor,
            created: row.created,
            updated: row.updated,
            body: row.body,
          };
          const size = utf8(JSON.stringify(exported)) + 1;
          if (rows.length >= take || (rows.length > 0 && bytes + size > EXPORT_PAGE.bytes)) {
            cut = true;
            break;
          }
          rows.push(exported);
          bytes += size;
        }
        this.#cost.rowsRead += cursor.rowsRead;
        const last = rows.at(-1);
        return {
          rows,
          next: cut && last !== undefined ? { collection: last.collection, id: last.id } : null,
          revision: this.#control()?.payloadRevision ?? 0,
          bytes,
        };
      });
    });
  }

  /** Spike only: fills a collection quickly, to time queries at the largest proposed cap. */
  seedForMeasure(
    envelope: Envelope,
    collection: string,
    count: number,
    now: number,
    authors = 500,
  ): number {
    this.ctx.storage.transactionSync(() => {
      this.#admit(envelope, { kind: "request", create: true }, now);
      for (let index = 0; index < count; index++) {
        this.#all(
          `insert into pf_documents (collection, id, author, created, updated, seq, body, size) values (?, ?, ?, ?, ?, ?, ?, 40)`,
          collection,
          newId(),
          `v_${index % authors}`,
          now + index,
          now + index,
          index,
          JSON.stringify({ index, text: "seeded", tag: `t${index % 1000}` }),
        );
      }
      this.#all(
        "update pf_collections set documents = documents + ? where name = ?",
        count,
        collection,
      );
    });
    return count;
  }

  /** Spike only: backdates replay records and rate rows, to test pruning. */
  backdateReplays(at: number): void {
    if (!this.#hasSchema()) return;
    this.ctx.storage.sql.exec("update pf_ops set at = ?", at);
  }

  // Housekeeping (finding 14): one alarm closes expired connections and prunes every control
  // table in bounded, age-ordered batches; under a hold or quarantine nothing is pruned.

  #scheduleAlarm(at: number): void {
    void this.ctx.storage.getAlarm().then((current) => {
      if (current === null || current > at) return this.ctx.storage.setAlarm(at);
      return undefined;
    });
  }

  /** Prunes one batch of each control table; returns how many rows went. */
  pruneReplays(now: number): number {
    if (!this.#hasSchema()) return 0;
    const control = this.#control();
    if (control === null || control.hold !== null || control.quarantine !== null) return 0;
    return this.ctx.storage.transactionSync(() => {
      const ops = this.#all(
        "delete from pf_ops where op_key in (select op_key from pf_ops indexed by pf_ops_at where at < ? limit ?) returning 1",
        now - REPLAY_MS,
        PRUNE_BATCH,
      ).length;
      const audit = this.#all(
        "delete from pf_audit where op_key in (select op_key from pf_audit indexed by pf_audit_state where state = 'delivered' and at < ? limit ?) returning 1",
        now - DELIVERED_MS,
        PRUNE_BATCH,
      ).length;
      const rates = this.#all(
        "delete from pf_rate where (subject, kind, window) in (select subject, kind, window from pf_rate where window < ? limit ?) returning 1",
        minute(now) - 1440,
        PRUNE_BATCH,
      ).length;
      const days = this.#all("delete from pf_day where day < ? returning 1", day(now) - 2).length;
      const total = ops + audit + rates + days;
      if (total > 0) this.#touch();
      return total;
    });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.deadline <= now) socket.close(4001, "renew");
      else next = next === null ? attachment.deadline : Math.min(next, attachment.deadline);
    }
    const pruned = this.pruneReplays(now);
    if (this.#hasSchema()) {
      const [oldest] = this.ctx.storage.sql
        .exec<{ at: number | null }>("select min(at) as at from pf_ops")
        .toArray();
      const wake =
        pruned >= PRUNE_BATCH ? now + 60_000 : oldest?.at != null ? oldest.at + REPLAY_MS : null;
      if (wake !== null) next = next === null ? wake : Math.min(next, wake);
    }
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now + 1_000));
  }

  // The live channel.

  closeConnections(code: number): number {
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) socket.close(code, "reconnect");
    return sockets.length;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/peek") {
      const envelope = JSON.parse(url.searchParams.get("envelope") ?? "{}") as Envelope;
      const page = await this.query(envelope, OWNER_PEEK(Number(url.searchParams.get("now"))), {
        collection: url.searchParams.get("collection") ?? "",
      });
      return Response.json(page);
    }
    if (url.pathname !== "/live" || request.headers.get("Upgrade") !== "websocket")
      return new Response(null, { status: 404 });
    const envelope = JSON.parse(request.headers.get("X-Portifact-Envelope") ?? "null") as Envelope;
    const caller = JSON.parse(request.headers.get("X-Portifact-Caller") ?? "null") as {
      author: string | null;
      principal: string;
      deadline: number;
      limits: DataLimits;
      now: number;
      owner?: { id: string; allowances: OwnerAllowances };
    };
    const owner = caller.owner ?? {
      id: envelope.ownerId,
      allowances: {
        documents_read: 0,
        documents_written: 0,
        cleanup: 0,
        export: 0,
        live_bytes: caller.limits.liveBytesPerDay,
      },
    };
    try {
      // The owner's live bytes are leased before the connection exists: acknowledgements are
      // charged like any other message (finding 15).
      await this.#lease(
        { caller: { kind: "reader" }, limits: caller.limits, owner, now: caller.now },
        "live_bytes",
        LIVE.reserveChunk,
      );
      this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: false }, caller.now);
        if (caller.deadline <= caller.now) throw new DataError("forbidden", "expired");
        const who = caller.author ?? "readers";
        if (caller.author !== null && this.#hasSchema() && this.#barred(caller.author))
          throw new DataError("forbidden", "erased");
        if (
          this.#hasSchema() &&
          this.#rate(who, "connects", minute(caller.now), caller.limits.connectsPerAuthorPerMinute)
        ) {
          throw new DataError("rate_limited", "too many connections");
        }
      });
    } catch (error) {
      if (error instanceof DataError)
        return new Response(null, { status: error.code === "rate_limited" ? 429 : 403 });
      throw error;
    }
    if (this.ctx.getWebSockets().length >= caller.limits.connectionsPerArtifact)
      return new Response(null, { status: 429 });
    const tag = caller.author === null ? "reader" : `author:${caller.author}`;
    if (this.ctx.getWebSockets(tag).length >= caller.limits.connectionsPerAuthor)
      return new Response(null, { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [tag]);
    const socketId = newId();
    server.serializeAttachment({
      socketId,
      author: caller.author,
      principal: caller.principal,
      subscriptions: [],
      deadline: caller.deadline,
      window: minute(caller.now),
      messagesIn: 0,
      bytesOut: 0,
      reserved: 0,
      liveBytesPerDay: caller.limits.liveBytesPerDay,
    } satisfies Attachment);
    this.#scheduleAlarm(caller.deadline);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "X-Portifact-Socket": socketId },
    });
  }

  async renew(
    envelope: Envelope,
    socketId: string,
    principal: string,
    deadline: number,
  ): Promise<boolean> {
    try {
      this.#admit(envelope, { kind: "request", create: false }, Date.now());
    } catch (error) {
      if (error instanceof DataError) return false;
      throw error;
    }
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.socketId !== socketId) continue;
      if (attachment.principal !== principal) return false;
      if (deadline <= Date.now()) {
        socket.close(4001, "renew");
        return false;
      }
      socket.serializeAttachment({ ...attachment, deadline } satisfies Attachment);
      this.#scheduleAlarm(deadline);
      return true;
    }
    return false;
  }

  #live(socket: WebSocket, now: number): Attachment | null {
    const attachment = socket.deserializeAttachment() as Attachment;
    if (attachment.deadline <= now) {
      socket.close(4001, "renew");
      return null;
    }
    const window = minute(now);
    return window === attachment.window
      ? attachment
      : { ...attachment, window, messagesIn: 0, bytesOut: 0 };
  }

  /**
   * Every message, acknowledgements and errors included, spends bytes the connection reserved
   * against the artifact's day and the owner's lease. Reservations are taken in chunks
   * (LIVE.reserveChunk), so the counters are written once per chunk, not once per message. A
   * refused reservation closes the connection with 4029; past the minute's bytes, 4009.
   */
  #send(socket: WebSocket, attachment: Attachment, text: string, now: number): Attachment | null {
    const bytes = utf8(text);
    if (attachment.bytesOut + bytes > LIVE.bytesOutPerMinute) {
      socket.close(4009, "slow down");
      return null;
    }
    let reserved = attachment.reserved;
    if (reserved < bytes) {
      const want = Math.max(bytes, LIVE.reserveChunk);
      const allowed = this.ctx.storage.transactionSync(() => {
        if (!this.#hasSchema()) return false;
        const [row] = this.#all<{ live_bytes: number }>(
          `insert into pf_day (day, live_bytes) values (?, ?)
           on conflict (day) do update set live_bytes = live_bytes + excluded.live_bytes returning live_bytes`,
          day(now),
          want,
        );
        if ((row as { live_bytes: number }).live_bytes > attachment.liveBytesPerDay) return false;
        return !this.#spendLease("live_bytes", want);
      });
      if (!allowed) {
        socket.close(4029, "live data limit reached for today");
        return null;
      }
      reserved += want;
    }
    const next = {
      ...attachment,
      bytesOut: attachment.bytesOut + bytes,
      reserved: reserved - bytes,
    };
    socket.serializeAttachment(next satisfies Attachment);
    socket.send(text);
    return next;
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const now = Date.now();
    const current = this.#live(socket, now);
    if (current === null) return;
    const size = typeof message === "string" ? utf8(message) : message.byteLength;
    const attachment = { ...current, messagesIn: current.messagesIn + 1 };
    if (size > LIVE.messageBytes || attachment.messagesIn > LIVE.messagesPerMinute) {
      socket.close(4008, "too many or too large messages");
      return;
    }
    socket.serializeAttachment(attachment satisfies Attachment);
    let name: unknown;
    try {
      name = (JSON.parse(String(message)) as { subscribe?: unknown }).subscribe;
    } catch {
      name = undefined;
    }
    const caller: Caller =
      attachment.author === null
        ? { kind: "reader" }
        : { kind: "visitor", author: attachment.author, canWrite: false };
    try {
      if (!this.#hasSchema()) throw new DataError("not_found", "no such collection");
      const target = this.#collection(String(name));
      if (readScope(target.mode, caller) === "none")
        throw new DataError("not_found", "no such collection");
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
      this.#send(socket, attachment, JSON.stringify({ error: error.code }), now);
      return;
    }
    const subscriptions = [...new Set([...attachment.subscriptions, String(name)])].slice(
      0,
      LIVE.subscriptions,
    );
    this.#send(socket, { ...attachment, subscriptions }, JSON.stringify({ subscribed: name }), now);
  }

  /** Fans a committed change out; a replay returns before this, so it never notifies twice. */
  #notify(collection: string, author: string, message: ChangeMessage): void {
    const now = Date.now();
    const { mode } = this.#collection(collection);
    const candidates =
      mode === "own" ? this.ctx.getWebSockets(`author:${author}`) : this.ctx.getWebSockets();
    const text = JSON.stringify(message);
    for (const socket of candidates) {
      const attachment = this.#live(socket, now);
      if (attachment === null || !attachment.subscriptions.includes(collection)) continue;
      this.#send(socket, attachment, text, now);
    }
  }
}

/** Room above the data cap for control records (counters, leases, operation records, barriers). */
export const CONTROL_RESERVE = 256 * 1024;

function OWNER_PEEK(now: number): CallContext {
  return {
    caller: { kind: "owner" },
    now,
    owner: {
      id: "owner_peek",
      allowances: {
        documents_read: 1e9,
        documents_written: 1e8,
        cleanup: 1e8,
        export: 1e9,
        live_bytes: 1e9,
      },
    },
    limits: {
      bytesPerArtifact: 10_000_000,
      documentBytes: 16 * 1024,
      documentsPerCollection: 1_000,
      collections: 10,
      indexedFields: 3,
      writesPerAuthorPerMinute: 30,
      deletesPerAuthorPerMinute: 60,
      readsPerCallerPerMinute: 300,
      rowsReadPerDay: 1_000_000,
      rowsWrittenPerDay: 100_000,
      connectionsPerArtifact: 25,
      connectionsPerAuthor: 4,
      connectsPerAuthorPerMinute: 6,
      liveBytesPerDay: 50_000_000,
      cleanupRowsPerDay: 100_000,
      exportRowsPerDay: 1_000_000,
    },
  };
}
