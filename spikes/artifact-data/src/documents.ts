// One artifact's documents (decision 0026): a SQLite-backed Durable Object named by the artifact
// ID that speaks only the document API. No SQL from anyone reaches it; owner SQL runs in the
// sandbox (`sandbox.ts`). Every command passes `admit` against the control record; mutations
// are idempotent per actor, generation and request; every command is charged before it runs
// against durable budgets, in pools that keep growth, cleanup and export apart; erasure keeps the
// control records; author erasure sets a barrier first.
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

/** The owner's daily allowances, per ledger pool. */
export type OwnerAllowances = Record<Pool, number>;

/** What the calling Worker states besides the envelope: who calls, the plan's limits, the owner. */
export interface CallContext {
  caller: Caller;
  limits: DataLimits;
  owner: { id: string; allowances: OwnerAllowances };
  now: number;
}

/** The object's storage, reported with every answer, refusals included (finding 13). */
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

export interface ChangeMessage {
  collection: string;
  kind: "created" | "updated" | "deleted";
  id: string;
  seq: number;
  document?: StoredDocument;
}

/** A live connection's state, kept across hibernation (at most 16 KiB). */
interface Attachment {
  socketId: string;
  author: string | null;
  /** The grant, link or read session that opened it; renewal must present the same. */
  principal: string;
  subscriptions: string[];
  deadline: number;
  window: number;
  messagesIn: number;
  bytesOut: number;
  liveBytesPerDay: number;
}

export const LIVE = {
  messageBytes: 1024,
  messagesPerMinute: 20,
  bytesOutPerMinute: 256 * 1024,
  subscriptions: 20,
} as const;

/** Rows a command is charged before it runs; actual work above it is charged after. */
const ESTIMATE = { read: { read: 110, written: 0 }, write: { read: 20, written: 14 } } as const;
/** Owner allowance is leased in chunks: 5% of a day, at most these. */
export const LEASE_CHUNK = {
  share: 0.05,
  read: 100_000,
  written: 1_000,
  bytes: 1_000_000,
} as const;
/** Replay records are kept a day (finding 5). */
export const REPLAY_MS = 86_400_000;
/** Bounded work per author-erasure call (finding 17). */
export const ERASE_CHUNK_MAX = 500;

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
  `create unique index if not exists pf_documents_unique
     on pf_documents (collection, author, unique_value) where unique_value is not null`,
  "create table if not exists pf_seq (scope text primary key, value integer not null) without rowid",
  `create table if not exists pf_rate (subject text not null, kind text not null, window integer not null,
     used integer not null, primary key (subject, kind, window)) without rowid`,
  `create table if not exists pf_day (day integer primary key, read_used integer not null default 0,
     written_used integer not null default 0, cleanup_used integer not null default 0,
     export_used integer not null default 0, live_bytes integer not null default 0)`,
  `create table if not exists pf_lease (pool text primary key, owner text not null,
     owner_epoch integer not null, day integer not null, granted integer not null, used integer not null) without rowid`,
  `create table if not exists pf_ops (op_key text primary key, op_id text not null, actor text not null,
     request_hash text not null, state text not null, kind text not null, target text not null,
     at integer not null) without rowid`,
  "create index if not exists pf_ops_actor on pf_ops (actor)",
  "create index if not exists pf_ops_at on pf_ops (at)",
  `create table if not exists pf_audit (op_id text primary key, kind text not null,
     detail text not null, at integer not null) without rowid`,
  "create table if not exists pf_barriers (author text primary key, at integer not null) without rowid",
];

/** Tables that hold the data of one generation; everything else is control and survives an erase. */
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

/** Bytes of a string in UTF-8. */
export function utf8(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Who acts, as replay records and audit name them. */
export function actorOf(caller: Caller): string {
  if (caller.kind === "visitor") return caller.author;
  if (caller.kind === "owner") return `owner:${caller.actor ?? "owner"}`;
  return "reader";
}

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

  /** Raises the storage sequence: every transaction that may change storage calls it. */
  #touch(): void {
    const control = this.#control();
    if (control !== null) this.#saveControl({ ...control, storageSeq: control.storageSeq + 1 });
  }

  #storage(): StorageReport {
    const control = this.#control();
    return {
      generation: control?.generation ?? 0,
      seq: control?.storageSeq ?? 0,
      bytes: this.ctx.storage.sql.databaseSize,
    };
  }

  /** The one validator, for every command. Returns the control record after any adoption. */
  #admit(envelope: Envelope, mode: AdmitMode, now: number): Control | null {
    const stored = this.#control();
    const verdict = admit(stored, envelope, mode);
    if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
    if ("done" in verdict) return null;
    if (stored === null) {
      if (mode.kind !== "request" || !mode.create) return null;
      this.#ensureSchema();
      const control = newControl(envelope, "open", now);
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
   * Leases owner allowance for a pool. A lease belongs to the owner and the epoch at which that
   * owner took over (finding 12): after a transfer the old lease is never used.
   */
  async #lease(context: CallContext, pool: Pool, need: number): Promise<void> {
    const control = this.#control();
    if (control === null) return;
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
      lease.owner === control.ownerId &&
      lease.owner_epoch === control.ownerEpoch &&
      lease.day === today
        ? lease
        : undefined;
    if (current !== undefined && current.granted - current.used >= need) return;
    const limit = context.owner.allowances[pool];
    const chunk =
      pool === "live_bytes"
        ? LEASE_CHUNK.bytes
        : pool.endsWith("_read")
          ? LEASE_CHUNK.read
          : LEASE_CHUNK.written;
    const deficit = Math.max(0, (current?.used ?? 0) - (current?.granted ?? 0));
    const want = deficit + Math.max(need, Math.min(Math.ceil(limit * LEASE_CHUNK.share), chunk));
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName(context.owner.id));
    const granted = await ledger.lease(pool, today, want, limit);
    // Added to the row as it is now, not as it was before the await: concurrent top-ups add up.
    this.ctx.storage.transactionSync(() => {
      this.#all(
        `insert into pf_lease (pool, owner, owner_epoch, day, granted, used) values (?, ?, ?, ?, ?, 0)
         on conflict (pool) do update set
           granted = case when owner = excluded.owner and owner_epoch = excluded.owner_epoch and day = excluded.day
             then granted + excluded.granted else excluded.granted end,
           used = case when owner = excluded.owner and owner_epoch = excluded.owner_epoch and day = excluded.day
             then used else 0 end,
           owner = excluded.owner, owner_epoch = excluded.owner_epoch, day = excluded.day`,
        pool,
        control.ownerId,
        control.ownerEpoch,
        today,
        granted,
      );
    });
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
   * Charges a command before it runs, in its own committed transaction (a refusal keeps its
   * charge). Growth and reads spend the artifact's day and the owner's documents pools; cleanup
   * and export have their own daily allowances and never meet the growth budget (finding 10).
   */
  #charge(
    context: CallContext,
    kind: "grow" | "read" | "cleanup" | "export",
    rate: { subject: string; kind: string; limit: number } | null,
    estimate: { read: number; written: number },
  ): void {
    if (!this.#hasSchema()) return;
    const refusal = this.ctx.storage.transactionSync(() => {
      // Reads update fixed-size counters (one row a day), reported with the next write.
      if (kind !== "read") this.#touch();
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
        if ((row as { used: number }).used > limit) {
          return { code: "rate_limited" as const, message: `the day's ${kind} allowance is spent` };
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
      if (
        spent.read_used > context.limits.rowsReadPerDay ||
        spent.written_used > context.limits.rowsWrittenPerDay
      ) {
        return {
          code: "quota_exceeded" as const,
          message: "this artifact's data budget for today is spent",
        };
      }
      const overRead = this.#spendLease("documents_read", estimate.read);
      const overWritten = this.#spendLease("documents_written", estimate.written);
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

  #trueUp(context: CallContext, estimate: { read: number; written: number }): void {
    const read = Math.max(0, this.#cost.rowsRead - estimate.read);
    const written = Math.max(0, this.#cost.rowsWritten - estimate.written);
    if (read === 0 && written === 0) return;
    this.#all(
      "update pf_day set read_used = read_used + ?, written_used = written_used + ? where day = ?",
      read,
      written,
      day(context.now),
    );
    this.#spendLease("documents_read", read);
    this.#spendLease("documents_written", written);
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

  /** The replay key: the operation ID scoped to the actor and the generation (finding 1). */
  #opKey(envelope: Envelope, caller: Caller): string | null {
    if (envelope.opId === undefined) return null;
    return `${actorOf(caller)}|${envelope.generation}|${envelope.opId}`;
  }

  /**
   * A recorded operation for this actor and generation: the same request replays as "done"
   * (after the caller's current authorization was checked by `authorize`), another request
   * under the same ID is a conflict. Nothing recorded holds a body (finding 5).
   */
  #replay(
    key: string | null,
    requestHash: string,
    authorize: () => void,
  ): { __replay: Replay } | null {
    if (key === null) return null;
    const [prior] = this.#all<{
      request_hash: string;
      kind: string;
      target: string;
      state: string;
    }>("select request_hash, kind, target, state from pf_ops where op_key = ?", key);
    if (prior === undefined) return null;
    if (prior.state === "aborted") throw new DataError("conflict", "this operation was abandoned");
    if (prior.request_hash !== requestHash) {
      throw new DataError("conflict", "this operation ID was used for another request");
    }
    authorize();
    return { __replay: { kind: prior.kind, target: prior.target } };
  }

  #record(
    key: string | null,
    envelope: Envelope,
    caller: Caller,
    requestHash: string,
    kind: string,
    target: string,
    now: number,
  ): void {
    if (key === null) return;
    this.#all(
      "insert into pf_ops (op_key, op_id, actor, request_hash, state, kind, target, at) values (?, ?, ?, ?, 'committed', ?, ?, ?)",
      key,
      envelope.opId,
      actorOf(caller),
      requestHash,
      kind,
      target,
      now,
    );
  }

  #audit(envelope: Envelope, context: CallContext, kind: string, detail: object): void {
    if (context.caller.kind !== "owner" || envelope.opId === undefined) return;
    this.#all(
      "insert into pf_audit (op_id, kind, detail, at) values (?, ?, ?, ?) on conflict do nothing",
      envelope.opId,
      kind,
      JSON.stringify(detail),
      context.now,
    );
  }

  #nextSeq(scope: string): number {
    const [row] = this.#all<{ value: number }>(
      `insert into pf_seq (scope, value) values (?, 1)
       on conflict (scope) do update set value = value + 1 returning value`,
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

  #checkGrowth(before: number, limits: DataLimits): void {
    const after = this.ctx.storage.sql.databaseSize;
    if (after > limits.bytesPerArtifact && after > before) {
      throw new DataError("quota_exceeded", "this artifact's data is full");
    }
  }

  #barred(author: string): boolean {
    return this.#all("select 1 from pf_barriers where author = ?", author).length > 0;
  }

  async declareCollection(
    envelope: Envelope,
    context: CallContext,
    input: { name: string; mode: string; uniqueKey?: string; indexed?: string[] },
  ): Promise<Outcome<{ name: string; mode: Mode }>> {
    const key = this.#opKey(envelope, context.caller);
    const requestHash = await hash(["declare", input]);
    return this.#run(async () => {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      const replay = this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: true }, context.now);
        return this.#replay(key, requestHash, () => {});
      });
      if (replay !== null) return replay as never;
      await this.#lease(context, "documents_written", ESTIMATE.write.written);
      await this.#lease(context, "documents_read", ESTIMATE.write.read);
      this.#charge(context, "grow", null, ESTIMATE.write);
      return this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: true }, context.now);
        const again = this.#replay(key, requestHash, () => {});
        if (again !== null) return again as never;
        this.#touch();
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
          `insert into pf_collections (name, mode, unique_key) values (?, ?, ?)
           on conflict (name) do update set mode = excluded.mode`,
          name,
          chosen,
          uniqueKey,
        );
        for (const field of input.indexed ?? []) {
          fieldName(field);
          if (this.#all("select 1 from pf_fields where name = ?", field).length === 0) {
            const [fields] = this.#all<{ n: number }>("select count(*) as n from pf_fields");
            if ((fields as { n: number }).n >= context.limits.indexedFields) {
              throw new DataError("quota_exceeded", "too many indexed fields");
            }
            this.#all("insert into pf_fields (name) values (?)", field);
            this.#all(
              `create index ${fieldIndex(field)} on pf_documents (collection, json_extract(body, '$.${field}'), created, id)`,
            );
          }
        }
        this.#record(key, envelope, context.caller, requestHash, "collection", name, context.now);
        this.#audit(envelope, context, "data.collection_set", { mode: chosen });
        this.#trueUp(context, ESTIMATE.write);
        return { name, mode: chosen };
      });
    });
  }

  /**
   * Creates a document. The replay check runs before any charge, so a retry after a lost
   * acknowledgement needs no second allowance (finding 1); an author whose erasure began is
   * refused (finding 6); a refusal still moves the storage report (finding 13).
   */
  async create(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    body: unknown,
  ): Promise<Outcome<StoredDocument>> {
    const key = this.#opKey(envelope, context.caller);
    const requestHash = await hash(["create", collection, body]);
    const caller = context.caller;
    const author = caller.kind === "visitor" ? caller.author : OWNER_AUTHOR;
    const authorize = () => {
      if (writeScope(this.#collection(collection).mode, caller) === "none") {
        throw new DataError("forbidden", "you cannot write to this collection");
      }
    };
    return this.#run(
      async () => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such collection");
        const replay = this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          return this.#replay(key, requestHash, authorize);
        });
        if (replay !== null) return replay as never;
        await this.#lease(context, "documents_written", ESTIMATE.write.written);
        await this.#lease(context, "documents_read", ESTIMATE.write.read);
        if (this.ctx.getWebSockets().length > 0)
          await this.#lease(context, "live_bytes", 64 * 1024);
        this.#charge(
          context,
          "grow",
          caller.kind === "visitor"
            ? { subject: author, kind: "writes", limit: context.limits.writesPerAuthorPerMinute }
            : null,
          ESTIMATE.write,
        );
        return this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          const again = this.#replay(key, requestHash, authorize);
          if (again !== null) return again as never;
          if (caller.kind === "visitor" && this.#barred(author)) {
            throw new DataError("forbidden", "this author's data is being erased");
          }
          this.#touch();
          const before = this.ctx.storage.sql.databaseSize;
          const target = this.#collection(collection);
          authorize();
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
          this.#checkGrowth(before, context.limits);
          this.#record(
            key,
            envelope,
            caller,
            requestHash,
            "document",
            `${collection}/${id}`,
            context.now,
          );
          this.#audit(envelope, context, "data.document_created", { bytes: size });
          this.#trueUp(context, ESTIMATE.write);
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
   * Replaces a body. A replacement that does not grow the document is cleanup (its own allowance,
   * finding 10); one that grows is charged as growth. The unique key is recomputed.
   */
  async replace(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
    body: unknown,
  ): Promise<Outcome<StoredDocument>> {
    const key = this.#opKey(envelope, context.caller);
    const requestHash = await hash(["replace", collection, id, body]);
    const caller = context.caller;
    const authorize = () => {
      if (writeScope(this.#collection(collection).mode, caller) === "none") {
        throw new DataError("forbidden", "you cannot write to this collection");
      }
    };
    return this.#run(
      async () => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
        const shrinks = this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          const replay = this.#replay(key, requestHash, authorize);
          if (replay !== null) return replay;
          const [old] = this.#all<{ size: number }>(
            "select size from pf_documents where collection = ? and id = ?",
            collection,
            id,
          );
          return old !== undefined && utf8(JSON.stringify(body)) <= old.size;
        });
        if (typeof shrinks === "object") return shrinks as never;
        if (shrinks) {
          this.#charge(context, "cleanup", null, ESTIMATE.write);
        } else {
          await this.#lease(context, "documents_written", ESTIMATE.write.written);
          await this.#lease(context, "documents_read", ESTIMATE.write.read);
          this.#charge(
            context,
            "grow",
            caller.kind === "visitor"
              ? {
                  subject: caller.author,
                  kind: "writes",
                  limit: context.limits.writesPerAuthorPerMinute,
                }
              : null,
            ESTIMATE.write,
          );
        }
        if (this.ctx.getWebSockets().length > 0)
          await this.#lease(context, "live_bytes", 64 * 1024);
        return this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          const again = this.#replay(key, requestHash, authorize);
          if (again !== null) return again as never;
          if (caller.kind === "visitor" && this.#barred(caller.author)) {
            throw new DataError("forbidden", "this author's data is being erased");
          }
          this.#touch();
          const before = this.ctx.storage.sql.databaseSize;
          const target = this.#collection(collection);
          const scope = writeScope(target.mode, caller);
          if (scope === "none")
            throw new DataError("forbidden", "you cannot write to this collection");
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
          this.#checkGrowth(before, context.limits);
          this.#record(
            key,
            envelope,
            caller,
            requestHash,
            "document",
            `${collection}/${id}`,
            context.now,
          );
          this.#audit(envelope, context, "data.document_replaced", { bytes: size });
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
   * Deletes a document: cleanup, never refused by the growth budget or the terms; a visitor may
   * always delete what they created (finding 10).
   */
  async remove(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
  ): Promise<Outcome<{ id: string; author: string; seq: number }>> {
    const key = this.#opKey(envelope, context.caller);
    const requestHash = await hash(["remove", collection, id]);
    const caller = context.caller;
    const authorize = () => {
      if (deleteScope(this.#collection(collection).mode, caller) === "none") {
        throw new DataError("forbidden", "you cannot delete in this collection");
      }
    };
    return this.#run(
      async () => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
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
          ESTIMATE.write,
        );
        return this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, { kind: "request", create: false }, context.now);
          const again = this.#replay(key, requestHash, authorize);
          if (again !== null) return again as never;
          this.#touch();
          const target = this.#collection(collection);
          const scope = deleteScope(target.mode, caller);
          if (scope === "none")
            throw new DataError("forbidden", "you cannot delete in this collection");
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
          this.#record(
            key,
            envelope,
            caller,
            requestHash,
            "deleted",
            `${collection}/${id}`,
            context.now,
          );
          this.#audit(envelope, context, "data.document_deleted", {});
          return { id, author: gone.author, seq };
        });
      },
      (gone) =>
        this.#notify(collection, gone.author, { collection, kind: "deleted", id, seq: gone.seq }),
    );
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

  async #readCharge(context: CallContext): Promise<void> {
    await this.#lease(context, "documents_read", ESTIMATE.read.read);
    await this.#lease(context, "documents_written", ESTIMATE.read.written);
    if (this.#readLimited(context))
      throw new DataError("rate_limited", "too many reads, try again in a minute");
    this.#charge(context, "read", null, ESTIMATE.read);
  }

  async get(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
  ): Promise<Outcome<StoredDocument>> {
    return this.#run(async () => {
      if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
      this.#admit(envelope, { kind: "request", create: false }, context.now);
      await this.#readCharge(context);
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
    return this.#run(async () => {
      if (!this.#hasSchema()) return { documents: [], next: null };
      this.#admit(envelope, { kind: "request", create: false }, context.now);
      await this.#readCharge(context);
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
      const next =
        rows.length > limit && last !== undefined ? encodeCursor(last._created, last._id) : null;
      return { documents, next };
    });
  }

  /** Spike only: the plan SQLite chooses for a query, to prove every allowed shape seeks. */
  explainQuery(spec: QuerySpec, scope: "all" | "own", indexed: string[]): string[] {
    const { sql, params } = buildQuery(spec, scope, "v_x", indexed);
    return this.ctx.storage.sql
      .exec<{ detail: string }>(`explain query plan ${sql}`, ...params)
      .toArray()
      .map((row) => row.detail);
  }

  /**
   * Erases one author, in bounded steps (findings 6, 17). The first call sets the author's
   * barrier in the same transaction that deletes the first chunk, so from its answer on every
   * write by that author is refused. Each call deletes at most `chunk` documents and the same
   * number of the author's replay and rate rows, through author-first indexes, so a call's work
   * is bounded whether or not the author has anything. The job keeps the journal entry until a
   * call answers `more: false`.
   */
  async eraseAuthorChunk(
    envelope: Envelope,
    author: string,
    chunk: number,
  ): Promise<Outcome<{ erased: number; more: boolean }>> {
    const take = Math.min(Math.max(chunk, 1), ERASE_CHUNK_MAX);
    return this.#run(() => {
      if (!this.#hasSchema()) return { erased: 0, more: false };
      return this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: false }, Date.now());
        this.#touch();
        this.#all(
          "insert into pf_barriers (author, at) values (?, ?) on conflict do nothing",
          author,
          Date.now(),
        );
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
        if (envelope.opId !== undefined) {
          this.#all(
            "insert into pf_audit (op_id, kind, detail, at) values (?, 'data.author_erased', ?, ?) on conflict (op_id) do update set detail = excluded.detail",
            envelope.opId,
            JSON.stringify({ documents: gone.length }),
            Date.now(),
          );
        }
        const more =
          gone.length === take ||
          ops.length === take ||
          rates.length === take ||
          this.#all(
            "select 1 from pf_documents indexed by pf_documents_by_author where author = ? limit 1",
            author,
          ).length > 0;
        return { erased: gone.length, more };
      });
    });
  }

  /** Prunes replay records older than a day, at most 500 per call (finding 5). */
  pruneReplays(now: number): number {
    if (!this.#hasSchema()) return 0;
    return this.#all(
      "delete from pf_ops where op_key in (select op_key from pf_ops indexed by pf_ops_at where at < ? limit 500) returning 1",
      now - REPLAY_MS,
    ).length;
  }

  /**
   * The barrier (finding 2): persisted before it is acknowledged, on an empty object too. A hold
   * closes the live channel; a transfer also drops leases of the old owner.
   */
  fence(
    envelope: Envelope,
    change: FenceChange,
  ): Outcome<{ epoch: number; state: string; ownerId: string }> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    return this.ctx.storage.transactionSync(() => {
      this.#ensureSchema();
      const stored = this.#control();
      const applied = applyFence(stored, envelope, change, Date.now());
      if (!applied.ok) {
        return {
          ok: false as const,
          error: applied.error,
          message: applied.message,
          cost: this.#cost,
          storage: this.#storage(),
        };
      }
      this.#saveControl(applied.control);
      if (stored !== null && applied.control.ownerId !== stored.ownerId)
        this.#all("delete from pf_lease");
      if (
        applied.control.state === "held" ||
        (stored !== null && applied.control.ownerId !== stored.ownerId)
      ) {
        this.closeConnections(4003);
      }
      return {
        ok: true as const,
        value: {
          epoch: applied.control.epoch,
          state: applied.control.state,
          ownerId: applied.control.ownerId,
        },
        cost: this.#cost,
        storage: this.#storage(),
      };
    });
  }

  /** The operator's quarantine after an unreconcilable restore (finding 4). */
  quarantine(envelope: Envelope): boolean {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#control();
      if (
        stored === null ||
        stored.artifactId !== envelope.artifactId ||
        stored.region !== envelope.region
      )
        return false;
      this.#saveControl({ ...stored, state: "quarantined", storageSeq: stored.storageSeq + 1 });
      this.closeConnections(4003);
      return true;
    });
  }

  /** The control record, for reconciliation after a restore. */
  controlRecord(): Control | null {
    return this.#control();
  }

  /** Erase, step one: the shared validator; adopts the epoch it accepts (finding 3). */
  prepareErase(envelope: Envelope): Outcome<{ prepared: boolean }> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      return this.ctx.storage.transactionSync(() => {
        const stored = this.#control();
        const verdict = admit(stored, envelope, { kind: "erase" });
        if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
        if ("done" in verdict || stored === null) {
          return {
            ok: true as const,
            value: { prepared: false },
            cost: this.#cost,
            storage: this.#storage(),
          };
        }
        this.#saveControl({
          ...stored,
          epoch: envelope.epoch,
          state: "erasing",
          storageSeq: stored.storageSeq + 1,
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

  /**
   * Erase, step two: in one transaction, deletes every payload table and writes the next
   * generation into the control record, which survives with the budgets, leases, barriers and
   * audit obligations (finding 3). A retry finds the next generation and does nothing.
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
          stored.state !== "erasing" ||
          stored.epoch !== envelope.epoch
        ) {
          return {
            ok: true as const,
            value: { erased: false },
            cost: this.#cost,
            storage: this.#storage(),
          };
        }
        for (const { name } of this.#all<{ name: string }>("select name from pf_fields")) {
          this.#all(`drop index if exists ${fieldIndex(name)}`);
        }
        for (const table of PAYLOAD_TABLES) this.#all(`delete from ${table}`);
        this.closeConnections(4404);
        this.#saveControl({
          ...stored,
          generation: stored.generation + 1,
          state: "open",
          storageSeq: stored.storageSeq + 1,
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

  /** Cancels a prepared erase (the job found a hold), through the same validator. */
  cancelErase(envelope: Envelope): boolean {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#control();
      const verdict = admit(stored, envelope, { kind: "erase" });
      if (!verdict.ok || "done" in verdict || stored === null || stored.state !== "erasing")
        return false;
      this.#saveControl({ ...stored, state: "open", storageSeq: stored.storageSeq + 1 });
      return true;
    });
  }

  /**
   * The audit relay's question (finding 14): a committed obligation, or the operation marked
   * aborted now if it never committed, so a late arrival of it cannot commit afterwards.
   */
  settle(
    envelope: Envelope,
    actor: string,
    opId: string,
  ): { state: "committed"; kind: string; detail: string } | { state: "aborted" } {
    return this.ctx.storage.transactionSync(() => {
      this.#ensureSchema();
      const [obligation] = this.#all<{ kind: string; detail: string }>(
        "select kind, detail from pf_audit where op_id = ?",
        opId,
      );
      if (obligation !== undefined) return { state: "committed" as const, ...obligation };
      const key = `${actor}|${envelope.generation}|${opId}`;
      this.#all(
        "insert into pf_ops (op_key, op_id, actor, request_hash, state, kind, target, at) values (?, ?, ?, '', 'aborted', 'aborted', '', ?) on conflict do nothing",
        key,
        opId,
        actor,
        Date.now(),
      );
      return { state: "aborted" as const };
    });
  }

  auditFor(opId: string): { kind: string; detail: string } | null {
    if (!this.#hasSchema()) return null;
    const [row] = this.ctx.storage.sql
      .exec<{ kind: string; detail: string }>(
        "select kind, detail from pf_audit where op_id = ?",
        opId,
      )
      .toArray();
    return row ?? null;
  }

  ackAudit(opId: string): void {
    if (this.#hasSchema()) this.ctx.storage.sql.exec("delete from pf_audit where op_id = ?", opId);
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

  /** A page of documents for exports and copies, in primary key order; charged to the export allowance. */
  async exportPage(
    envelope: Envelope,
    context: CallContext,
    after: { collection: string; id: string } | null,
    limit: number,
  ): Promise<
    Outcome<{
      rows: { collection: string; document: StoredDocument }[];
      next: { collection: string; id: string } | null;
      revision: number;
    }>
  > {
    return this.#run(() => {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      if (!this.#hasSchema()) return { rows: [], next: null, revision: 0 };
      const take = Math.min(Math.max(limit, 1), 500);
      this.#admit(envelope, { kind: "request", create: false }, context.now);
      this.#charge(context, "export", null, { read: take + 10, written: 0 });
      const rows = this.#all<DocumentRow & { collection: string }>(
        `select collection, id, author, editor, created, updated, seq, body from pf_documents
         where (collection, id) > (?, ?) order by collection, id limit ?`,
        after?.collection ?? "",
        after?.id ?? "",
        take + 1,
      );
      const page = rows
        .slice(0, take)
        .map((row) => ({ collection: row.collection, document: this.#document(row) }));
      const last = page.at(-1);
      return {
        rows: page,
        next:
          rows.length > take && last
            ? { collection: last.collection, id: last.document._id }
            : null,
        revision: this.#control()?.storageSeq ?? 0,
      };
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
          `insert into pf_documents (collection, id, author, created, updated, seq, body, size)
           values (?, ?, ?, ?, ?, ?, ?, 40)`,
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

  /** Spike only: backdates replay records, to test pruning. */
  backdateReplays(at: number): void {
    if (this.#hasSchema()) this.ctx.storage.sql.exec("update pf_ops set at = ?", at);
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
    if (url.pathname !== "/live" || request.headers.get("Upgrade") !== "websocket") {
      return new Response(null, { status: 404 });
    }
    const envelope = JSON.parse(request.headers.get("X-Portifact-Envelope") ?? "null") as Envelope;
    const caller = JSON.parse(request.headers.get("X-Portifact-Caller") ?? "null") as {
      author: string | null;
      principal: string;
      deadline: number;
      limits: DataLimits;
      now: number;
    };
    try {
      this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: false }, caller.now);
        if (caller.deadline <= caller.now) throw new DataError("forbidden", "expired");
        const who = caller.author ?? "readers";
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
      liveBytesPerDay: caller.limits.liveBytesPerDay,
    } satisfies Attachment);
    await this.#scheduleExpiry(caller.deadline);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "X-Portifact-Socket": socketId },
    });
  }

  async #scheduleExpiry(deadline: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > deadline) await this.ctx.storage.setAlarm(deadline);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.deadline <= now) socket.close(4001, "renew");
      else next = next === null ? attachment.deadline : Math.min(next, attachment.deadline);
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  /**
   * Sets one connection's deadline after the Worker renewed the same grant or session that
   * opened it (finding 8): another principal is refused; the deadline may move earlier as well
   * as later; a deadline already past closes the connection.
   */
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
      await this.#scheduleExpiry(deadline);
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
   * Sends one message after reserving its UTF-8 bytes against the connection's minute, the
   * artifact's day and the owner's leased bytes (finding 16). A refused reservation sends
   * nothing: past the minute the connection is closed (4009); past the day or the owner's bytes
   * it is closed with 4029.
   */
  #send(
    socket: WebSocket,
    attachment: Attachment,
    text: string,
    now: number,
    fanOut = false,
  ): Attachment | null {
    const bytes = utf8(text);
    if (attachment.bytesOut + bytes > LIVE.bytesOutPerMinute) {
      socket.close(4009, "slow down");
      return null;
    }
    const allowed = this.ctx.storage.transactionSync(() => {
      if (!this.#hasSchema()) return false;
      const [row] = this.#all<{ live_bytes: number }>(
        `insert into pf_day (day, live_bytes) values (?, ?)
         on conflict (day) do update set live_bytes = live_bytes + excluded.live_bytes returning live_bytes`,
        day(now),
        bytes,
      );
      if ((row as { live_bytes: number }).live_bytes > attachment.liveBytesPerDay) return false;
      // Fan-out also spends the owner's leased bytes (the write that caused it leased them);
      // protocol answers count against the artifact's day only.
      return !fanOut || !this.#spendLease("live_bytes", bytes);
    });
    if (!allowed) {
      socket.close(4029, "live data limit reached for today");
      return null;
    }
    const next = { ...attachment, bytesOut: attachment.bytesOut + bytes };
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

  /**
   * Fans a committed change out to connections allowed to see it. Only fresh mutations reach
   * here: a replay returns before, so a retried operation never notifies twice.
   */
  #notify(collection: string, author: string, message: ChangeMessage): void {
    const now = Date.now();
    const { mode } = this.#collection(collection);
    const candidates =
      mode === "own" ? this.ctx.getWebSockets(`author:${author}`) : this.ctx.getWebSockets();
    const text = JSON.stringify(message);
    for (const socket of candidates) {
      const attachment = this.#live(socket, now);
      if (attachment === null || !attachment.subscriptions.includes(collection)) continue;
      this.#send(socket, attachment, text, now, true);
    }
  }
}

function OWNER_PEEK(now: number): CallContext {
  return {
    caller: { kind: "owner" },
    now,
    owner: {
      id: "owner_peek",
      allowances: {
        documents_read: 1e9,
        documents_written: 1e8,
        sql_read: 1e9,
        sql_written: 1e8,
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
      sandboxBytes: 1_000_000,
      sqlRowsReadPerDay: 1_000_000,
      sqlRowsWrittenPerDay: 10_000,
      sqlWorstRowsRead: 50_000_000,
      sqlWorstRowsWritten: 1_000_000,
    },
  };
}
