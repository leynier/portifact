// One artifact's documents (decision 0026): a SQLite-backed Durable Object named by the artifact
// ID that speaks only the document API. No SQL from anyone reaches it, so nothing an owner builds
// can depend on, block or rewrite the documents; owner SQL runs in the artifact's sandbox
// (`sandbox.ts`), which reads documents only through an explicit copy. Every command carries an
// envelope (`envelope.ts`) the object checks first; every operation is charged, before it runs,
// against durable budgets of rows read and written per author, per artifact and (by lease) per
// owner, so refused attempts cost the caller as well.
import { DurableObject } from "cloudflare:workers";
import { checkFence, type Envelope, type Fence, type ObjectState } from "./envelope.ts";
import {
  buildQuery,
  type Caller,
  collectionName,
  DataError,
  type DataErrorCode,
  type DataLimits,
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

/** What the calling Worker states besides the envelope: who calls, the plan's limits, the owner. */
export interface CallContext {
  caller: Caller;
  limits: DataLimits;
  owner: { id: string; rowsReadPerDay: number; rowsWrittenPerDay: number };
  now: number;
}

export type Outcome<T> =
  | { ok: true; value: T; cost: Cost; size: number; revision: number }
  | { ok: false; error: DataErrorCode; message: string; cost: Cost };

/** A body field: shallow, so the RPC stub's mapped types stay usable. */
export type Json = string | number | boolean | null | object;

export interface StoredDocument {
  _id: string;
  /** The session that created it: attribution, not proof of who typed it (decision 0026). */
  _by: string;
  /** The last session that changed it, when it is not the creator (`shared` mode). */
  _editedBy: string | null;
  _created: number;
  _updated: number;
  /** A counter of the document's own scope: the author's in `own`, the collection's otherwise. */
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
  subscriptions: string[];
  /** Absolute authorization deadline (ms): never past what the grant or link session allows. */
  deadline: number;
  window: number;
  messagesIn: number;
  bytesOut: number;
}

/** Live channel bounds (constants; the plan sets connections and daily bytes). */
export const LIVE = {
  messageBytes: 1024,
  messagesPerMinute: 20,
  bytesOutPerMinute: 256 * 1024,
  subscriptions: 20,
} as const;

/** Rows a command is charged before it runs; actual work above it is charged after. */
const ESTIMATE = { read: { read: 110, written: 2 }, write: { read: 16, written: 12 } } as const;
/**
 * Owner budget is leased to an artifact in chunks: 5% of the owner's day, at most these rows, so
 * idle leases held by many artifacts cannot use up the owner's day.
 */
export const LEASE_CHUNK = { share: 0.05, read: 100_000, written: 1_000 } as const;

const SCHEMA = [
  "create table if not exists pf_meta (key text primary key, value) without rowid",
  `create table if not exists pf_collections (name text primary key, mode text not null,
     unique_key text, documents integer not null default 0, bytes integer not null default 0)
     without rowid`,
  "create table if not exists pf_fields (name text primary key) without rowid",
  `create table if not exists pf_documents (collection text not null, id text not null,
     author text not null, editor text, created integer not null, updated integer not null,
     seq integer not null, unique_value text, body text not null, size integer not null,
     primary key (collection, id)) without rowid`,
  "create index if not exists pf_documents_author on pf_documents (collection, author, created, id)",
  "create index if not exists pf_documents_created on pf_documents (collection, created, id)",
  `create unique index if not exists pf_documents_unique
     on pf_documents (collection, author, unique_value) where unique_value is not null`,
  "create table if not exists pf_seq (scope text primary key, value integer not null) without rowid",
  `create table if not exists pf_budget (scope text not null, window integer not null,
     used integer not null, primary key (scope, window)) without rowid`,
  `create table if not exists pf_day (day integer primary key, read_used integer not null default 0,
     written_used integer not null default 0, read_granted integer not null default 0,
     written_granted integer not null default 0, live_bytes integer not null default 0)`,
  "create table if not exists pf_ops (op_id text primary key, outcome text not null, at integer not null) without rowid",
  "create table if not exists pf_audit (op_id text primary key, kind text not null, detail text not null, at integer not null) without rowid",
];

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

  #meta(key: string): SqlStorageValue | undefined {
    if (!this.#hasSchema()) return undefined;
    return this.#all<{ value: SqlStorageValue }>("select value from pf_meta where key = ?", key)[0]
      ?.value;
  }

  #setMeta(key: string, value: SqlStorageValue): void {
    this.#all(
      "insert into pf_meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
      key,
      value,
    );
  }

  #fence(): Fence | null {
    const artifactId = this.#meta("artifact");
    if (artifactId === undefined) return null;
    return {
      artifactId: artifactId as string,
      region: this.#meta("region") as string,
      generation: this.#meta("generation") as number,
      epoch: this.#meta("epoch") as number,
      state: this.#meta("state") as ObjectState,
    };
  }

  /**
   * Checks the envelope; on a first write records it; adopts a newer epoch. `create` decides
   * whether a missing database may be created (only writes and declarations create storage).
   */
  #admit(envelope: Envelope, create: boolean, operator = false): Fence | null {
    const stored = this.#fence();
    const verdict = checkFence(stored, envelope, operator);
    if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
    if (stored?.state === "erasing") throw new DataError("stale", "the data is being erased");
    if (stored === null) {
      if (!create) return null;
      this.#ensureSchema();
      this.#setMeta("artifact", envelope.artifactId);
      this.#setMeta("region", envelope.region);
      this.#setMeta("generation", envelope.generation);
      this.#setMeta("epoch", envelope.epoch);
      this.#setMeta("state", "open");
      this.#setMeta("revision", 0);
      return this.#fence();
    }
    if (verdict.adopt) this.#setMeta("epoch", envelope.epoch);
    return stored;
  }

  /** Adds to a durable counter and says whether it is now past `limit`; never rolled back. */
  #count(scope: string, window: number, amount: number, limit: number): boolean {
    const [row] = this.#all<{ used: number }>(
      `insert into pf_budget (scope, window, used) values (?, ?, ?)
       on conflict (scope, window) do update set used = used + excluded.used
       returning used`,
      scope,
      window,
      amount,
    );
    return (row as { used: number }).used > limit;
  }

  /**
   * Owner budget: rows are leased from the owner's ledger object in chunks, so the owner's daily
   * total is exact up to the chunks outstanding in its artifacts. The artifact's day, its lease
   * and its live bytes are one row (`pf_day`), so charging a command writes one row.
   */
  async #lease(context: CallContext, kind: "read" | "written", need: number): Promise<void> {
    if (!this.#hasSchema()) return;
    const today = day(context.now);
    const [row] = this.#all<{ used: number; granted: number }>(
      `select ${kind}_used as used, ${kind}_granted as granted from pf_day where day = ?`,
      today,
    );
    if (row !== undefined && row.granted - row.used >= need) return;
    const limit = kind === "read" ? context.owner.rowsReadPerDay : context.owner.rowsWrittenPerDay;
    const deficit = Math.max(0, (row?.used ?? 0) - (row?.granted ?? 0));
    const want =
      deficit + Math.max(need, Math.min(Math.ceil(limit * LEASE_CHUNK.share), LEASE_CHUNK[kind]));
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName(context.owner.id));
    const granted = await ledger.lease(today, kind, want, limit);
    this.ctx.storage.transactionSync(() => {
      this.#all(
        `insert into pf_day (day, ${kind}_granted) values (?, ?)
         on conflict (day) do update set ${kind}_granted = ${kind}_granted + excluded.${kind}_granted`,
        today,
        granted,
      );
      this.#all("delete from pf_day where day < ?", today - 1);
    });
  }

  /** Per-caller read rates live in memory: they shape traffic; the spend budget is durable. */
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

  /**
   * Charges a command before it runs, in its own committed transaction: the writer's rate (a
   * durable row per author and minute, writes only), the artifact's day and the owner's lease
   * (one row). A refusal is charged too, so failing attempts cost as much as succeeding ones and
   * cannot be repeated for free.
   */
  #charge(
    context: CallContext,
    rate: { scope: string; limit: number } | null,
    estimate: { read: number; written: number },
  ): void {
    if (!this.#hasSchema()) return;
    const refused = this.ctx.storage.transactionSync(() => {
      const now = context.now;
      if (rate !== null && this.#count(rate.scope, minute(now), 1, rate.limit)) {
        return {
          code: "rate_limited" as const,
          message: "too many requests, try again in a minute",
        };
      }
      const [row] = this.#all<{
        read_used: number;
        written_used: number;
        read_granted: number;
        written_granted: number;
      }>(
        `insert into pf_day (day, read_used, written_used) values (?, ?, ?)
         on conflict (day) do update set read_used = read_used + excluded.read_used,
           written_used = written_used + excluded.written_used
         returning read_used, written_used, read_granted, written_granted`,
        day(now),
        estimate.read,
        estimate.written,
      );
      const spent = row as NonNullable<typeof row>;
      if (
        spent.read_used > context.limits.rowsReadPerDay ||
        spent.written_used > context.limits.rowsWrittenPerDay
      ) {
        return {
          code: "quota_exceeded" as const,
          message: "this artifact's data budget for today is spent",
        };
      }
      if (spent.read_used > spent.read_granted || spent.written_used > spent.written_granted) {
        return {
          code: "quota_exceeded" as const,
          message: "the owner's data budget for today is spent",
        };
      }
      return null;
    });
    if (refused !== null) throw new DataError(refused.code, refused.message);
  }

  /** Charges what a command actually did above its estimate, so a large one pays in full. */
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
  }

  #revision(): number {
    return (this.#meta("revision") as number | undefined) ?? 0;
  }

  async #run<T>(work: () => T | Promise<T>, after?: (value: T) => void): Promise<Outcome<T>> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      const value = await work();
      after?.(value);
      return {
        ok: true,
        value,
        cost: this.#cost,
        size: this.ctx.storage.sql.databaseSize,
        revision: this.#revision(),
      };
    } catch (error) {
      if (error instanceof DataError) {
        return { ok: false, error: error.code, message: error.message, cost: this.#cost };
      }
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        return { ok: false, error: "conflict", message: "already exists", cost: this.#cost };
      }
      throw error;
    }
  }

  /** A replayed mutation returns its first outcome; otherwise runs `work` and records it. */
  #once<T>(envelope: Envelope, work: () => T): T {
    if (envelope.opId === undefined) return work();
    const [done] = this.#all<{ outcome: string }>(
      "select outcome from pf_ops where op_id = ?",
      envelope.opId,
    );
    if (done !== undefined) return JSON.parse(done.outcome) as T;
    const value = work();
    this.#all(
      "insert into pf_ops (op_id, outcome, at) values (?, ?, ?)",
      envelope.opId,
      JSON.stringify(value ?? null),
      Date.now(),
    );
    return value;
  }

  #bumpRevision(): void {
    this.#setMeta("revision", this.#revision() + 1);
  }

  #nextSeq(scope: string): number {
    const [row] = this.#all<{ value: number }>(
      `insert into pf_seq (scope, value) values (?, 1)
       on conflict (scope) do update set value = value + 1 returning value`,
      scope,
    );
    return (row as { value: number }).value;
  }

  /** Owner-side mutations leave an audit obligation in their own transaction (finding 21). */
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

  /** Over the plan's size, only changes that do not grow the database go through (finding 12). */
  #checkGrowth(before: number, limits: DataLimits): void {
    const after = this.ctx.storage.sql.databaseSize;
    if (after > limits.bytesPerArtifact && after > before) {
      throw new DataError("quota_exceeded", "this artifact's data is full");
    }
  }

  async declareCollection(
    envelope: Envelope,
    context: CallContext,
    input: { name: string; mode: string; uniqueKey?: string; indexed?: string[] },
  ): Promise<Outcome<{ name: string; mode: Mode }>> {
    return this.#run(async () => {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      await this.#lease(context, "written", ESTIMATE.write.written);
      await this.#lease(context, "read", ESTIMATE.write.read);
      this.#charge(context, null, ESTIMATE.write);
      return this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, true);
        return this.#once(envelope, () => {
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
            const known = this.#all("select 1 from pf_fields where name = ?", field).length;
            if (known === 0) {
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
          this.#audit(envelope, context, "data.collection_set", { mode: chosen });
          this.#bumpRevision();
          this.#trueUp(context, ESTIMATE.write);
          return { name, mode: chosen };
        });
      });
    });
  }

  async create(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    body: unknown,
  ): Promise<Outcome<StoredDocument>> {
    return this.#run(
      async () => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such collection");
        await this.#lease(context, "written", ESTIMATE.write.written);
        await this.#lease(context, "read", ESTIMATE.write.read);
        const author = context.caller.kind === "visitor" ? context.caller.author : OWNER_AUTHOR;
        this.#charge(
          context,
          context.caller.kind === "visitor"
            ? { scope: `writes:${author}`, limit: context.limits.writesPerAuthorPerMinute }
            : null,
          ESTIMATE.write,
        );
        return this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, false);
          return this.#once(envelope, () => {
            const before = this.ctx.storage.sql.databaseSize;
            const target = this.#collection(collection);
            if (writeScope(target.mode, context.caller) === "none") {
              throw new DataError("forbidden", "you cannot write to this collection");
            }
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
            this.#audit(envelope, context, "data.document_created", { bytes: size });
            this.#bumpRevision();
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
   * Replaces a body. The author condition is part of the read and the UPDATE in `own` and
   * `append`; the unique key is recomputed and checked again (finding 13); a replacement that
   * does not grow the database goes through over quota (finding 12).
   */
  async replace(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
    body: unknown,
  ): Promise<Outcome<StoredDocument>> {
    return this.#run(
      async () => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
        await this.#lease(context, "written", ESTIMATE.write.written);
        await this.#lease(context, "read", ESTIMATE.write.read);
        const caller = context.caller;
        this.#charge(
          context,
          caller.kind === "visitor"
            ? { scope: `writes:${caller.author}`, limit: context.limits.writesPerAuthorPerMinute }
            : null,
          ESTIMATE.write,
        );
        return this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, false);
          return this.#once(envelope, () => {
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
            const editorId =
              caller.kind === "visitor"
                ? caller.author
                : caller.kind === "owner"
                  ? OWNER_AUTHOR
                  : null;
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
            this.#audit(envelope, context, "data.document_replaced", { bytes: size });
            this.#bumpRevision();
            this.#trueUp(context, ESTIMATE.write);
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
   * Deletes a document. Deletes have their own allowance (cleanup must work when writing is
   * spent) and never meet the size check; they are still charged, attempts included.
   */
  async remove(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
  ): Promise<Outcome<{ id: string; author: string; seq: number }>> {
    return this.#run(
      async () => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
        const caller = context.caller;
        // Cleanup is charged to its own counter only: a spent daily budget never blocks it.
        const limited = this.ctx.storage.transactionSync(
          () =>
            caller.kind === "visitor" &&
            this.#count(
              `deletes:${caller.author}`,
              minute(context.now),
              1,
              context.limits.deletesPerAuthorPerMinute,
            ),
        );
        if (limited) throw new DataError("rate_limited", "too many deletes, try again in a minute");
        return this.ctx.storage.transactionSync(() => {
          this.#admit(envelope, false);
          return this.#once(envelope, () => {
            const target = this.#collection(collection);
            const scope = writeScope(target.mode, caller);
            if (scope === "none")
              throw new DataError("forbidden", "you cannot write to this collection");
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
            this.#audit(envelope, context, "data.document_deleted", {});
            this.#bumpRevision();
            // Cleanup is never refused by the day's budget, but what it wrote is counted in it.
            this.#all(
              `insert into pf_day (day, written_used) values (?, ?)
               on conflict (day) do update set written_used = written_used + excluded.written_used`,
              day(context.now),
              this.#cost.rowsWritten + 1,
            );
            return { id, author: gone.author, seq };
          });
        });
      },
      (gone) =>
        this.#notify(collection, gone.author, { collection, kind: "deleted", id, seq: gone.seq }),
    );
  }

  async get(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
  ): Promise<Outcome<StoredDocument>> {
    return this.#run(async () => {
      if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
      await this.#lease(context, "read", ESTIMATE.read.read);
      await this.#lease(context, "written", ESTIMATE.read.written);
      if (this.#readLimited(context)) {
        throw new DataError("rate_limited", "too many reads, try again in a minute");
      }
      this.#charge(context, null, ESTIMATE.read);
      this.#admit(envelope, false);
      const target = this.#collection(collection);
      const scope = readScope(target.mode, context.caller);
      if (scope === "none") throw new DataError("not_found", "no such document");
      const own = scope === "own" ? " and author = ?" : "";
      const caller = context.caller;
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
      await this.#lease(context, "read", ESTIMATE.read.read);
      await this.#lease(context, "written", ESTIMATE.read.written);
      if (this.#readLimited(context)) {
        throw new DataError("rate_limited", "too many reads, try again in a minute");
      }
      this.#charge(context, null, ESTIMATE.read);
      this.#admit(envelope, false);
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
   * Erases one author's documents, at most `chunk` per call, so a large erasure runs as
   * repeated bounded jobs (finding 5). Returns how many went and whether more remain.
   */
  async eraseAuthorChunk(
    envelope: Envelope,
    author: string,
    chunk: number,
  ): Promise<Outcome<{ erased: number; more: boolean }>> {
    return this.#run(() => {
      if (!this.#hasSchema()) return { erased: 0, more: false };
      return this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, false);
        let erased = 0;
        const collections = this.#all<{ name: string }>("select name from pf_collections");
        for (const { name } of collections) {
          if (erased >= chunk) break;
          const gone = this.#all<{ size: number }>(
            `delete from pf_documents where collection = ? and id in
               (select id from pf_documents indexed by pf_documents_author where collection = ? and author = ? limit ?)
             returning size`,
            name,
            name,
            author,
            chunk - erased,
          );
          if (gone.length > 0) {
            const bytes = gone.reduce((sum, row) => sum + row.size, 0);
            this.#all(
              "update pf_collections set documents = documents - ?, bytes = bytes - ? where name = ?",
              gone.length,
              bytes,
              name,
            );
            erased += gone.length;
          }
        }
        this.#all("delete from pf_budget where scope like ?", `%:${author}`);
        if (erased > 0) this.#bumpRevision();
        const [left] = this.#all<{ n: number }>(
          "select count(*) as n from (select 1 from pf_documents where author = ? limit 1)",
          author,
        );
        return { erased, more: (left as { n: number }).n > 0 };
      });
    });
  }

  /**
   * The barrier (finding 4): a hold, release, transfer or suspension raises the epoch in D1,
   * then this call makes the object refuse anything older and records the state. The caller
   * treats the change as in force only once this answers.
   */
  fence(
    envelope: Envelope,
    state: "open" | "held",
  ): Outcome<{ epoch: number; state: ObjectState }> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#fence();
      if (stored === null) {
        return {
          ok: true as const,
          value: { epoch: envelope.epoch, state },
          cost: this.#cost,
          size: 0,
          revision: 0,
        };
      }
      if (stored.artifactId !== envelope.artifactId || envelope.epoch < stored.epoch) {
        return {
          ok: false as const,
          error: "stale" as const,
          message: "older than the object's epoch",
          cost: this.#cost,
        };
      }
      this.#setMeta("epoch", envelope.epoch);
      // A hold cancels an erase that was prepared and not yet committed.
      this.#setMeta(
        "state",
        state === "held" ? "held" : stored.state === "held" ? "open" : stored.state,
      );
      if (state === "held") this.closeConnections(4003);
      return {
        ok: true as const,
        value: { epoch: envelope.epoch, state: this.#fence()?.state ?? state },
        cost: this.#cost,
        size: this.ctx.storage.sql.databaseSize,
        revision: this.#revision(),
      };
    });
  }

  /**
   * Erase, step one: marks the object as erasing for the envelope's generation and epoch. The
   * job then re-reads D1 (a hold may have started) and commits or cancels.
   */
  prepareErase(envelope: Envelope): Outcome<{ prepared: boolean }> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#fence();
      if (stored === null)
        return {
          ok: true as const,
          value: { prepared: false },
          cost: this.#cost,
          size: 0,
          revision: 0,
        };
      const verdict = checkFence(stored, envelope);
      if (!verdict.ok) {
        // An erase of an older generation is done already: nothing to prepare, not an error.
        if (envelope.generation < stored.generation) {
          return {
            ok: true as const,
            value: { prepared: false },
            cost: this.#cost,
            size: 0,
            revision: 0,
          };
        }
        return {
          ok: false as const,
          error: verdict.error,
          message: verdict.message,
          cost: this.#cost,
        };
      }
      this.#setMeta("state", "erasing");
      return {
        ok: true as const,
        value: { prepared: true },
        cost: this.#cost,
        size: 0,
        revision: 0,
      };
    });
  }

  /**
   * Erase, step two: deletes everything only if the object is still erasing the same
   * generation at the same epoch (no fence came in between), then records the next generation,
   * so a retry of this erase finds nothing to do and data created afterwards survives it.
   */
  async commitErase(envelope: Envelope): Promise<Outcome<{ erased: boolean }>> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    const stored = this.#fence();
    if (
      stored === null ||
      stored.state !== "erasing" ||
      stored.generation !== envelope.generation ||
      stored.epoch !== envelope.epoch ||
      stored.artifactId !== envelope.artifactId
    ) {
      return {
        ok: true,
        value: { erased: false },
        cost: this.#cost,
        size: this.ctx.storage.sql.databaseSize,
        revision: this.#revision(),
      };
    }
    this.closeConnections(4404);
    await this.ctx.storage.deleteAll();
    this.#schemaReady = false;
    this.ctx.storage.transactionSync(() => {
      this.#ensureSchema();
      this.#setMeta("artifact", envelope.artifactId);
      this.#setMeta("region", envelope.region);
      this.#setMeta("generation", envelope.generation + 1);
      this.#setMeta("epoch", envelope.epoch);
      this.#setMeta("state", "open");
      this.#setMeta("revision", 0);
    });
    return {
      ok: true,
      value: { erased: true },
      cost: this.#cost,
      size: this.ctx.storage.sql.databaseSize,
      revision: 0,
    };
  }

  /** Cancels a prepared erase (the job found a hold). */
  cancelErase(envelope: Envelope): boolean {
    const stored = this.#fence();
    if (stored?.state !== "erasing" || stored.generation !== envelope.generation) return false;
    this.#setMeta("state", "open");
    return true;
  }

  /** Audit obligations the caller has not relayed yet (finding 21). */
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

  /** The budget counters, for tests and the owner's usage view. */
  budget(now: number): Record<string, number> {
    if (!this.#hasSchema()) return {};
    const rows = this.ctx.storage.sql
      .exec<{ scope: string; used: number }>(
        "select scope, used from pf_budget where window = ?",
        minute(now),
      )
      .toArray();
    const [today] = this.ctx.storage.sql
      .exec<{ read_used: number; written_used: number; live_bytes: number }>(
        "select read_used, written_used, live_bytes from pf_day where day = ?",
        day(now),
      )
      .toArray();
    return {
      ...Object.fromEntries(rows.map((row) => [row.scope, row.used])),
      rows_read: today?.read_used ?? 0,
      rows_written: today?.written_used ?? 0,
      live_bytes: today?.live_bytes ?? 0,
    };
  }

  size(): { bytes: number; revision: number; generation: number } {
    return {
      bytes: this.ctx.storage.sql.databaseSize,
      revision: this.#revision(),
      generation: (this.#meta("generation") as number | undefined) ?? 0,
    };
  }

  /**
   * A page of raw documents for the owner side's export and copies, in primary key order, at
   * most `limit`, with the revision it was read at.
   */
  async exportPage(
    envelope: Envelope,
    context: CallContext,
    after: { collection: string; id: string } | null,
    limit: number,
  ): Promise<
    Outcome<{
      rows: { collection: string; document: StoredDocument }[];
      next: { collection: string; id: string } | null;
    }>
  > {
    return this.#run(async () => {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      if (!this.#hasSchema()) return { rows: [], next: null };
      const take = Math.min(Math.max(limit, 1), 500);
      await this.#lease(context, "read", take + 10);
      await this.#lease(context, "written", 4);
      this.#charge(context, null, { read: take + 10, written: 4 });
      this.#admit(envelope, false);
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
      this.#admit(envelope, true);
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

  // The live channel.

  closeConnections(code: number): number {
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) socket.close(code, "reconnect");
    return sockets.length;
  }

  /**
   * Opens a live connection. The Worker sets `X-Portifact-Envelope` and `X-Portifact-Caller`
   * after authorization on a request it builds; the caller holds an absolute deadline the grant
   * or link session allows (at most 60 seconds ahead). Connects are charged durably per author.
   */
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
      deadline: number;
      limits: DataLimits;
      now: number;
    };
    try {
      this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, false);
        if (caller.deadline <= caller.now) throw new DataError("forbidden", "expired");
        const who = caller.author ?? "readers";
        if (
          this.#hasSchema() &&
          this.#count(
            `connects:${who}`,
            minute(caller.now),
            1,
            caller.limits.connectsPerAuthorPerMinute,
          )
        ) {
          throw new DataError("rate_limited", "too many connections");
        }
      });
    } catch (error) {
      if (error instanceof DataError) {
        return new Response(null, { status: error.code === "rate_limited" ? 429 : 403 });
      }
      throw error;
    }
    if (this.ctx.getWebSockets().length >= caller.limits.connectionsPerArtifact) {
      return new Response(null, { status: 429 });
    }
    const tag = caller.author === null ? "reader" : `author:${caller.author}`;
    if (this.ctx.getWebSockets(tag).length >= caller.limits.connectionsPerAuthor) {
      return new Response(null, { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [tag]);
    const socketId = newId();
    server.serializeAttachment({
      socketId,
      author: caller.author,
      subscriptions: [],
      deadline: caller.deadline,
      window: minute(caller.now),
      messagesIn: 0,
      bytesOut: 0,
    } satisfies Attachment);
    await this.#scheduleExpiry(caller.deadline);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "X-Portifact-Socket": socketId },
    });
  }

  /** An alarm, not a timer: a stored wake-up does not keep the object billable (finding 25). */
  async #scheduleExpiry(deadline: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > deadline) await this.ctx.storage.setAlarm(deadline);
  }

  /** Closes every connection past its deadline, then waits for the next deadline. */
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

  /** Extends one connection's deadline after the Worker renewed the grant or link session. */
  async renew(envelope: Envelope, socketId: string, deadline: number): Promise<boolean> {
    try {
      this.#admit(envelope, false);
    } catch (error) {
      if (error instanceof DataError) return false;
      throw error;
    }
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.socketId !== socketId) continue;
      socket.serializeAttachment({
        ...attachment,
        deadline: Math.max(attachment.deadline, deadline),
      } satisfies Attachment);
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

  /** `{"subscribe": "<collection>"}`, bounded in size and rate; checked against the deadline. */
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const now = Date.now();
    const current = this.#live(socket, now);
    if (current === null) return;
    const size =
      typeof message === "string" ? new TextEncoder().encode(message).length : message.byteLength;
    const attachment = { ...current, messagesIn: current.messagesIn + 1 };
    if (size > LIVE.messageBytes || attachment.messagesIn > LIVE.messagesPerMinute) {
      socket.close(4008, "too many or too large messages");
      return;
    }
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
      socket.serializeAttachment(attachment satisfies Attachment);
      socket.send(JSON.stringify({ error: error.code }));
      return;
    }
    const subscriptions = [...new Set([...attachment.subscriptions, String(name)])].slice(
      0,
      LIVE.subscriptions,
    );
    socket.serializeAttachment({ ...attachment, subscriptions } satisfies Attachment);
    socket.send(JSON.stringify({ subscribed: name }));
  }

  /**
   * Sends a change to the connections allowed to see it, each checked against its deadline and
   * its per-minute byte allowance before the send. In `own` mode only the author's own
   * connections are candidates. What is sent is added to the day's live bytes (traffic).
   */
  #notify(collection: string, author: string, message: ChangeMessage): void {
    const now = Date.now();
    const { mode } = this.#collection(collection);
    const candidates =
      mode === "own" ? this.ctx.getWebSockets(`author:${author}`) : this.ctx.getWebSockets();
    const visible: ChangeMessage = mode === "own" ? message : { ...message, seq: message.seq };
    const text = JSON.stringify(visible);
    let sent = 0;
    for (const socket of candidates) {
      const attachment = this.#live(socket, now);
      if (attachment === null || !attachment.subscriptions.includes(collection)) continue;
      if (attachment.bytesOut + text.length > LIVE.bytesOutPerMinute) {
        socket.close(4009, "slow down");
        continue;
      }
      socket.serializeAttachment({
        ...attachment,
        bytesOut: attachment.bytesOut + text.length,
      } satisfies Attachment);
      socket.send(text);
      sent += text.length;
    }
    if (sent > 0) {
      this.ctx.storage.sql.exec(
        `insert into pf_day (day, live_bytes) values (?, ?)
         on conflict (day) do update set live_bytes = live_bytes + excluded.live_bytes`,
        day(now),
        sent,
      );
    }
  }
}

/** The owner-side context the spike's cross-Worker probe uses. */
function OWNER_PEEK(now: number): CallContext {
  return {
    caller: { kind: "owner" },
    now,
    owner: { id: "owner_peek", rowsReadPerDay: 1_000_000, rowsWrittenPerDay: 100_000 },
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
    },
  };
}
