// One artifact's data (decision 0026): a SQLite-backed Durable Object named by the artifact ID
// that speaks only the document API, to the page and to the owner side.
//
// Every command is synchronous: it awaits nothing, so nothing can land between its admission
// and its work. A mutation runs in one transaction that admits the envelope, answers a replay,
// checks the operation's issue time, authorizes, refuses when the artifact's counter for its
// class is already spent, does the work and adds the rows it measured to that counter. A
// failure after the work began charges what it measured in a second transaction. Every limit is
// the artifact's own, from the plan the calling Worker sends with the command; there is no owner
// ledger and no lease (decision 45).
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
import { sha256Hex } from "./hash.ts";
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

/** What the calling Worker states besides the envelope: who calls, the plan's limits, the time. */
export interface CallContext {
  caller: Caller;
  limits: DataLimits;
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

export interface ExportPage {
  rows: ExportRow[];
  next: { collection: string; id: string } | null;
  revision: number;
  bytes: number;
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
  generation: number;
  subscriptions: string[];
  deadline: number;
  window: number;
  messagesIn: number;
  bytesOut: number;
  /** Messages already reserved against the artifact's day and not yet sent. */
  reserved: number;
  liveMessagesPerDay: number;
}

export const LIVE = {
  messageBytes: 1024,
  /** A page only subscribes; a few messages a minute is all it needs, and each is a billed request. */
  messagesPerMinute: 4,
  bytesOutPerMinute: 256 * 1024,
  subscriptions: 20,
  /** Messages reserved at a time: two rows written (the day's counter and the control record) per chunk. */
  reserveChunk: 100,
} as const;

/** Per-operation caps: the most one operation can overshoot a spent counter by. */
export const CAPS = {
  pageDocuments: 100,
  bulkDocuments: 100,
  indexStepDocuments: 500,
  eraseChunkDocuments: 500,
  exportRows: 500,
  exportBytes: 1024 * 1024,
  pruneRows: 500,
} as const;
/** The charge statement's own rows, added to what the cursors measured before it. */
export const CHARGE_SELF = { read: 2, written: 2 } as const;
/** Reads are counted in memory and persisted at most this often. */
export const READ_FLUSH = { rows: 10_000, ms: 30_000 } as const;
/** How long a mutation's record answers a retry. */
export const REPLAY_MS = 86_400_000;
/** Operation IDs carry their issue time; older ones are refused, so a pruned ID never applies again. */
export const HORIZON_MS = REPLAY_MS - 3_600_000;
export const CLOCK_SKEW_MS = 300_000;
/** Delivered audit obligations are kept for late settlement this long. */
export const DELIVERED_MS = 7 * 86_400_000;
/** The system actor that runs erasure jobs. */
export const ERASURE_ACTOR = "system:erasure";
/** Room above the data cap for control records. */
export const CONTROL_RESERVE = 256 * 1024;

const SCHEMA = [
  "create table if not exists pf_meta (key text primary key, value) without rowid",
  `create table if not exists pf_collections (name text primary key, mode text not null,
     unique_key text, documents integer not null default 0, bytes integer not null default 0) without rowid`,
  `create table if not exists pf_fields (name text primary key, state text not null,
     cursor_collection text not null default '', cursor_id text not null default '') without rowid`,
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
  `create table if not exists pf_values (collection text not null, field text not null, value,
     created integer not null, id text not null)`,
  "create unique index if not exists pf_values_seek on pf_values (collection, field, value, created, id)",
  "create index if not exists pf_values_doc on pf_values (collection, id)",
  `create table if not exists pf_author_counts (collection text not null, author text not null,
     documents integer not null, primary key (collection, author)) without rowid`,
  "create table if not exists pf_seq (scope text primary key, value integer not null) without rowid",
  `create table if not exists pf_rate (subject text not null, kind text not null, window integer not null,
     used integer not null, primary key (subject, kind, window)) without rowid`,
  "create index if not exists pf_rate_window on pf_rate (window)",
  `create table if not exists pf_day (day integer primary key, read_used integer not null default 0,
     written_used integer not null default 0, cleanup_used integer not null default 0,
     export_used integer not null default 0, rights_used integer not null default 0,
     live_messages integer not null default 0, refused integer not null default 0)`,
  `create table if not exists pf_ops (op_key text primary key, actor text not null, request_hash text not null,
     state text not null, kind text not null, target text not null, result text, at integer not null) without rowid`,
  "create index if not exists pf_ops_actor on pf_ops (actor)",
  "create index if not exists pf_ops_at on pf_ops (at)",
  `create table if not exists pf_audit (op_key text primary key, kind text not null, detail text not null,
     owner text not null, state text not null, at integer not null) without rowid`,
  "create index if not exists pf_audit_state on pf_audit (state, at)",
  `create table if not exists pf_barriers (author text primary key, at integer not null,
     complete integer not null default 0) without rowid`,
];

/** Tables of one generation's data; the rest is control and survives an erase. */
const PAYLOAD_TABLES = [
  "pf_documents",
  "pf_collections",
  "pf_fields",
  "pf_values",
  "pf_author_counts",
  "pf_seq",
  "pf_ops",
];

/** The pruning statements, each through an index that leads with the row's age (finding 10). */
export const PRUNE = {
  ops: "delete from pf_ops where op_key in (select op_key from pf_ops indexed by pf_ops_at where at < ? limit ?) returning 1",
  audit:
    "delete from pf_audit where op_key in (select op_key from pf_audit indexed by pf_audit_state where state = 'delivered' and at < ? limit ?) returning 1",
  rate: "delete from pf_rate where (subject, kind, window) in (select subject, kind, window from pf_rate indexed by pf_rate_window where window < ? limit ?) returning 1",
  days: "delete from pf_day where day in (select day from pf_day where day < ? limit ?) returning 1",
} as const;

/** Which daily counter an operation spends; each has its own limit and refusal. */
type Lane = "growth" | "read" | "cleanup" | "export" | "rights";

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

function hash(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
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

/** The time an operation ID was issued, which the ID carries as its prefix: `<ms>.<random>`. */
export function issuedAt(opId: string): number | null {
  const issued = Number(opId.split(".")[0]);
  return Number.isSafeInteger(issued) ? issued : null;
}

interface MutationSpec<T> {
  envelope: Envelope;
  context: CallContext;
  actor: string;
  request: unknown;
  /** Whether a first write may create the control record (declarations and erasure only). */
  create?: boolean;
  authorize: () => void;
  /** Which counter pays, decided inside the transaction (it can depend on the document). */
  lane: () => Lane;
  rate?: { subject: string; kind: string; limit: number } | undefined;
  /** Refused only by authorization, never by a spent counter (erasure). */
  protectedWork?: boolean;
  work: () => T;
}

export class ArtifactDocuments extends DurableObject<Env> {
  #cost: Cost = { rowsRead: 0, rowsWritten: 0 };
  #schemaReady = false;
  /** Reads counted in memory since the last flush; an eviction loses at most READ_FLUSH of them. */
  #reads = { day: 0, rows: 0, refused: 0, since: 0 };
  /** Per-caller read rates live in memory: they shape traffic; the spend is counted. */
  #readCounts = new Map<string, number>();

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

  /** Raises the storage sequence on every durable write, and the payload revision when documents changed. */
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
   * The one validator. The first durable write on an empty object binds its identity: only the
   * paths that may write first (a declaration, an erasure, maintenance) create the control record
   * from the envelope; everything else on an empty object finds nothing to do (finding 8).
   */
  #admit(envelope: Envelope, mode: AdmitMode, now: number, bind = false): Control | null {
    const stored = this.#control();
    const verdict = admit(stored, envelope, mode);
    if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
    if ("done" in verdict) return null;
    if (stored === null) {
      if (!bind) return null;
      this.#ensureSchema();
      const control = newControl(envelope, now);
      this.#saveControl(control);
      return control;
    }
    return stored;
  }

  // Counters.

  #dayRow(today: number): Record<string, number> {
    const [row] = this.#all<Record<string, number>>(
      "select read_used, written_used, cleanup_used, export_used, rights_used, live_messages from pf_day where day = ?",
      today,
    );
    return row ?? {};
  }

  #spent(lane: Lane, today: number): number {
    const row = this.#dayRow(today);
    switch (lane) {
      case "growth":
        return row.written_used ?? 0;
      case "read":
        return (row.read_used ?? 0) + (this.#reads.day === today ? this.#reads.rows : 0);
      case "cleanup":
        return row.cleanup_used ?? 0;
      case "export":
        return row.export_used ?? 0;
      case "rights":
        return row.rights_used ?? 0;
    }
  }

  static #limit(lane: Lane, limits: DataLimits): number {
    switch (lane) {
      case "growth":
        return limits.rowsWrittenPerDay;
      case "read":
        return limits.rowsReadPerDay;
      case "cleanup":
        return limits.cleanupRowsPerDay;
      case "export":
        return limits.exportRowsPerDay;
      case "rights":
        return limits.rightsRowsPerDay;
    }
  }

  /** Refuses work of a class whose counter is already spent; the refusal writes nothing. */
  #refuseIfSpent(lane: Lane, context: CallContext): void {
    if (this.#spent(lane, day(context.now)) < ArtifactDocuments.#limit(lane, context.limits))
      return;
    this.#countRefusal(context.now);
    if (lane === "growth" || lane === "read") {
      throw new DataError("quota_exceeded", "this artifact's data budget for today is spent");
    }
    throw new DataError("rate_limited", `this artifact's ${lane} allowance for today is spent`);
  }

  #countRefusal(now: number): void {
    this.#pendingReads(now).refused += 1;
  }

  #pendingReads(now: number) {
    const today = day(now);
    if (this.#reads.day !== today)
      this.#reads = { day: today, rows: 0, refused: 0, since: Date.now() };
    return this.#reads;
  }

  /**
   * Adds measured work to the day's counter for its lane, in the caller's transaction; reads
   * counted in memory are written with it, so a write never costs a second counter row.
   */
  #charge(lane: Lane, now: number, cost: Cost): void {
    const today = day(now);
    const pending = this.#pendingReads(now);
    const read = cost.rowsRead + CHARGE_SELF.read;
    const written = cost.rowsWritten + CHARGE_SELF.written;
    const columns: Record<Lane, [number, number, number, number, number]> = {
      growth: [read, written, 0, 0, 0],
      read: [read + written, 0, 0, 0, 0],
      cleanup: [0, 0, read + written, 0, 0],
      export: [0, 0, 0, read + written, 0],
      rights: [0, 0, 0, 0, read + written],
    };
    const [r, w, c, x, g] = columns[lane];
    this.#all(
      `insert into pf_day (day, read_used, written_used, cleanup_used, export_used, rights_used, refused)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (day) do update set read_used = read_used + excluded.read_used,
         written_used = written_used + excluded.written_used, cleanup_used = cleanup_used + excluded.cleanup_used,
         export_used = export_used + excluded.export_used, rights_used = rights_used + excluded.rights_used,
         refused = refused + excluded.refused`,
      today,
      r + pending.rows,
      w,
      c,
      x,
      g,
      pending.refused,
    );
    this.#reads = { day: today, rows: 0, refused: 0, since: Date.now() };
    this.#scheduleAt((today + 3) * 86_400_000);
  }

  /** Persists the reads counted in memory when enough have gathered (READ_FLUSH). */
  #maybeFlushReads(now: number, force = false): void {
    const pending = this.#pendingReads(now);
    if (!force && pending.rows < READ_FLUSH.rows && Date.now() - pending.since < READ_FLUSH.ms)
      return;
    if (pending.rows === 0 && pending.refused === 0) return;
    this.ctx.storage.transactionSync(() => {
      this.#charge("read", now, { rowsRead: -CHARGE_SELF.read, rowsWritten: -CHARGE_SELF.written });
      this.#touch();
    });
  }

  /** A per-subject rate: refuses at the limit without writing; counts an admitted attempt. */
  #rate(subject: string, kind: string, window: number, limit: number): void {
    const [row] = this.#all<{ used: number }>(
      "select used from pf_rate where subject = ? and kind = ? and window = ?",
      subject,
      kind,
      window,
    );
    if ((row?.used ?? 0) >= limit)
      throw new DataError("rate_limited", "too many requests, try again in a minute");
    this.#countRate(subject, kind, window);
  }

  #countRate(subject: string, kind: string, window: number): void {
    this.#all(
      `insert into pf_rate (subject, kind, window, used) values (?, ?, ?, 1)
       on conflict (subject, kind, window) do update set used = used + 1`,
      subject,
      kind,
      window,
    );
    this.#scheduleAt((window + 1441) * 60_000);
  }

  /** The measured cost so far, taken before the storage report reads the control record. */
  #answer(): { cost: Cost; storage: StorageReport } {
    const cost = { ...this.#cost };
    return { cost, storage: this.#storage() };
  }

  #run<T>(work: () => T, after?: (value: T) => void): Outcome<T> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      const value = work();
      if (value !== null && typeof value === "object" && "__replay" in value) {
        return {
          ok: true,
          replayed: (value as unknown as { __replay: Replay }).__replay,
          ...this.#answer(),
        };
      }
      const answer = this.#answer();
      after?.(value);
      return { ok: true, value, ...answer };
    } catch (error) {
      // A rolled-back first write may have dropped the schema it created.
      this.#schemaReady = false;
      if (error instanceof DataError)
        return { ok: false, error: error.code, message: error.message, ...this.#answer() };
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        return { ok: false, error: "conflict", message: "already exists", ...this.#answer() };
      }
      throw error;
    }
  }

  #opKey(envelope: Envelope, actor: string): string | null {
    return envelope.opId === undefined
      ? null
      : operationKey(actor, envelope.generation, envelope.opId);
  }

  /** Operation IDs older than the replay horizon, or from the future, are refused (finding 9). */
  static #checkHorizon(opId: string | undefined, now: number): void {
    if (opId === undefined) return;
    const issued = issuedAt(opId);
    if (issued === null)
      throw new DataError("invalid_input", "an operation ID starts with its issue time");
    if (now - issued > HORIZON_MS || issued - now > CLOCK_SKEW_MS) {
      throw new DataError("conflict", "this operation ID has expired; start a new operation");
    }
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
    if (key === null || !this.#hasSchema()) return null;
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
      "insert into pf_ops (op_key, actor, request_hash, state, kind, target, result, at) values (?, ?, ?, 'committed', ?, ?, ?, ?)",
      key,
      actor,
      requestHash,
      kind,
      target,
      result,
      now,
    );
    this.#scheduleAt(now + REPLAY_MS);
  }

  /** An owner-side mutation's audit obligation, under the operation's full identity. */
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

  /**
   * The shape of every mutation: one transaction with nothing awaited before it. A failure after
   * the work began is rolled back and then charged what it measured, with its rate attempt, in a
   * second transaction, so failed work is never free and a refusal before the work writes nothing.
   */
  #mutation<T>(spec: MutationSpec<T>, notify?: (value: T) => void): Outcome<T> {
    const { envelope, context } = spec;
    const key = this.#opKey(envelope, spec.actor);
    const requestHash = hash(spec.request);
    let lane: Lane | null = null;
    return this.#run(() => {
      try {
        return this.ctx.storage.transactionSync(() => {
          // Only an authorized first write binds an empty object's identity (finding 8).
          const bind = spec.create ?? false;
          if (
            this.#admit(envelope, { kind: "request", create: bind }, context.now) === null &&
            bind
          ) {
            spec.authorize();
            this.#admit(envelope, { kind: "request", create: bind }, context.now, true);
          }
          if (!this.#hasSchema()) throw new DataError("not_found", "no such collection");
          const replay = this.#replay(key, requestHash, spec.authorize);
          if (replay !== null) {
            if (replay.result !== null) return JSON.parse(replay.result) as T;
            return replay as unknown as T;
          }
          ArtifactDocuments.#checkHorizon(envelope.opId, context.now);
          spec.authorize();
          const chosen = spec.lane();
          if (!spec.protectedWork) this.#refuseIfSpent(chosen, context);
          if (spec.rate !== undefined)
            this.#rate(spec.rate.subject, spec.rate.kind, minute(context.now), spec.rate.limit);
          lane = chosen;
          const value = spec.work();
          this.#touch(true);
          this.#charge(chosen, context.now, this.#cost);
          return value;
        });
      } catch (error) {
        if (lane !== null) {
          this.#schemaReady = false;
          const measured = { ...this.#cost };
          const chosen: Lane = lane;
          this.ctx.storage.transactionSync(() => {
            if (spec.rate !== undefined)
              this.#countRate(spec.rate.subject, spec.rate.kind, minute(context.now));
            this.#touch();
            this.#charge(chosen, context.now, measured);
          });
        }
        throw error;
      }
    }, notify);
  }

  #nextSeq(scope: string): number {
    // An erased author's sequence is never recreated (finding 7).
    if (scope.startsWith("author:") && this.#barred(scope.slice("author:".length))) return 0;
    const [row] = this.#all<{ value: number }>(
      "insert into pf_seq (scope, value) values (?, 1) on conflict (scope) do update set value = value + 1 returning value",
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
   * always goes through.
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

  /** Keeps every indexed field's value for one document, built or still building. */
  #indexDocument(collection: string, id: string, created: number, body: string): void {
    this.#all(
      `insert or ignore into pf_values (collection, field, value, created, id)
       select ?, name, json_extract(?, '$.' || name), ?, ? from pf_fields
       where json_type(?, '$.' || name) in ('text', 'integer', 'real', 'true', 'false')`,
      collection,
      body,
      created,
      id,
      body,
    );
  }

  #unindexDocument(collection: string, id: string): void {
    this.#all("delete from pf_values where collection = ? and id = ?", collection, id);
  }

  #countAuthor(collection: string, author: string, delta: number): void {
    this.#all(
      `insert into pf_author_counts (collection, author, documents) values (?, ?, ?)
       on conflict (collection, author) do update set documents = documents + excluded.documents`,
      collection,
      author,
      delta,
    );
  }

  /**
   * One bounded step of every index being built (finding 3): the next CAPS.indexStepDocuments
   * documents in primary key order get their values; when a step finds fewer, the field is
   * ready for queries. Writes keep values for every field meanwhile.
   */
  #indexStep(): { building: number } {
    const fields = this.#all<{ name: string; cursor_collection: string; cursor_id: string }>(
      "select name, cursor_collection, cursor_id from pf_fields where state = 'building'",
    );
    for (const field of fields) {
      const batch = this.#all<{ collection: string; id: string }>(
        "select collection, id from pf_documents where (collection, id) > (?, ?) order by collection, id limit ?",
        field.cursor_collection,
        field.cursor_id,
        CAPS.indexStepDocuments,
      );
      const last = batch.at(-1);
      if (last !== undefined) {
        this.#all(
          `insert or ignore into pf_values (collection, field, value, created, id)
           select collection, ?, json_extract(body, '$.' || ?), created, id from pf_documents
           where (collection, id) > (?, ?) and (collection, id) <= (?, ?)
             and json_type(body, '$.' || ?) in ('text', 'integer', 'real', 'true', 'false')`,
          field.name,
          field.name,
          field.cursor_collection,
          field.cursor_id,
          last.collection,
          last.id,
          field.name,
        );
      }
      if (batch.length < CAPS.indexStepDocuments) {
        this.#all("update pf_fields set state = 'ready' where name = ?", field.name);
      } else if (last !== undefined) {
        this.#all(
          "update pf_fields set cursor_collection = ?, cursor_id = ? where name = ?",
          last.collection,
          last.id,
          field.name,
        );
      }
    }
    const [left] = this.#all<{ n: number }>(
      "select count(*) as n from pf_fields where state = 'building'",
    );
    return { building: (left as { n: number }).n };
  }

  declareCollection(
    envelope: Envelope,
    context: CallContext,
    input: { name: string; mode: string; uniqueKey?: string; indexed?: string[] },
  ): Outcome<{ name: string; mode: Mode; building: number }> {
    const actor = actorOf(context.caller);
    return this.#mutation({
      envelope,
      context,
      actor,
      request: ["declare", input],
      create: true,
      authorize: () => {
        if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      },
      lane: () => "growth",
      work: () => {
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
          "insert into pf_collections (name, mode, unique_key) values (?, ?, ?) on conflict (name) do update set mode = excluded.mode",
          name,
          chosen,
          uniqueKey,
        );
        for (const field of input.indexed ?? []) {
          fieldName(field);
          if (this.#all("select 1 from pf_fields where name = ?", field).length > 0) continue;
          const [present] = this.#all<{ n: number }>("select count(*) as n from pf_fields");
          if ((present as { n: number }).n >= context.limits.indexedFields) {
            throw new DataError("quota_exceeded", "too many indexed fields");
          }
          this.#all("insert into pf_fields (name, state) values (?, 'building')", field);
        }
        const { building } = this.#indexStep();
        const key = this.#opKey(envelope, actor);
        this.#record(key, actor, hash(["declare", input]), "collection", name, context.now);
        this.#audit(key, envelope.ownerId, "data.collection_set", { mode: chosen }, context.now);
        return { name, mode: chosen, building };
      },
    });
  }

  /** The owner side continues an index build, one bounded step a call, until nothing is building. */
  buildIndexStep(envelope: Envelope, context: CallContext): Outcome<{ building: number }> {
    return this.#mutation({
      envelope,
      context,
      actor: actorOf(context.caller),
      request: ["index_step"],
      authorize: () => {
        if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      },
      lane: () => "growth",
      work: () => this.#indexStep(),
    });
  }

  create(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    body: unknown,
  ): Outcome<StoredDocument> {
    const caller = context.caller;
    const actor = actorOf(caller);
    const author = caller.kind === "visitor" ? caller.author : OWNER_AUTHOR;
    return this.#mutation(
      {
        envelope,
        context,
        actor,
        request: ["create", collection, body],
        authorize: () => {
          if (caller.kind === "visitor" && this.#barred(author))
            throw new DataError("forbidden", "this author's data was erased");
          if (writeScope(this.#collection(collection).mode, caller) === "none") {
            throw new DataError("forbidden", "you cannot write to this collection");
          }
        },
        lane: () => "growth",
        rate:
          caller.kind === "visitor"
            ? { subject: author, kind: "writes", limit: context.limits.writesPerAuthorPerMinute }
            : undefined,
        work: () => {
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
          this.#indexDocument(collection, id, context.now, text);
          this.#countAuthor(collection, author, 1);
          this.#all(
            "update pf_collections set documents = documents + 1, bytes = bytes + ? where name = ?",
            size,
            collection,
          );
          this.#checkGrowth(before, context.limits, size);
          const key = this.#opKey(envelope, actor);
          this.#record(
            key,
            actor,
            hash(["create", collection, body]),
            "document",
            `${collection}/${id}`,
            context.now,
          );
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
        },
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
   * Replaces a body. One that grows the document is charged as growth; one that does not is
   * charged to cleanup, and both are under the author's write rate. A document whose creator is
   * being erased is not edited (finding 7).
   */
  replace(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
    body: unknown,
  ): Outcome<StoredDocument> {
    const caller = context.caller;
    const actor = actorOf(caller);
    let old: { size: number; author: string; created: number } | undefined;
    return this.#mutation(
      {
        envelope,
        context,
        actor,
        request: ["replace", collection, id, body],
        authorize: () => {
          if (caller.kind === "visitor" && this.#barred(caller.author))
            throw new DataError("forbidden", "this author's data was erased");
          const scope = writeScope(this.#collection(collection).mode, caller);
          if (scope === "none")
            throw new DataError("forbidden", "you cannot write to this collection");
          const own = scope === "own" ? " and author = ?" : "";
          const mine = scope === "own" && caller.kind === "visitor" ? [caller.author] : [];
          [old] = this.#all<{ size: number; author: string; created: number }>(
            `select size, author, created from pf_documents where collection = ? and id = ?${own}`,
            collection,
            id,
            ...mine,
          );
          if (old !== undefined && this.#barred(old.author))
            throw new DataError("conflict", "this document's creator is being erased");
        },
        lane: () =>
          old !== undefined && utf8(JSON.stringify(body)) <= old.size ? "cleanup" : "growth",
        rate:
          caller.kind === "visitor"
            ? {
                subject: caller.author,
                kind: "writes",
                limit: context.limits.writesPerAuthorPerMinute,
              }
            : undefined,
        work: () => {
          if (old === undefined) throw new DataError("not_found", "no such document");
          const before = this.ctx.storage.sql.databaseSize;
          const target = this.#collection(collection);
          const { text, size } = documentBody(body, context.limits.documentBytes);
          const unique =
            target.uniqueKey === null
              ? null
              : uniqueValue(body as Record<string, unknown>, target.uniqueKey);
          const editorId = caller.kind === "visitor" ? caller.author : OWNER_AUTHOR;
          const editor = editorId === old.author ? null : editorId;
          const seq = this.#nextSeq(
            target.mode === "own" ? `author:${old.author}` : `collection:${collection}`,
          );
          this.#all(
            "update pf_documents set body = ?, size = ?, updated = ?, seq = ?, unique_value = ?, editor = ? where collection = ? and id = ?",
            text,
            size,
            context.now,
            seq,
            unique,
            editor,
            collection,
            id,
          );
          this.#unindexDocument(collection, id);
          this.#indexDocument(collection, id, old.created, text);
          this.#all(
            "update pf_collections set bytes = bytes + ? where name = ?",
            size - old.size,
            collection,
          );
          this.#checkGrowth(before, context.limits, size - old.size);
          const key = this.#opKey(envelope, actor);
          this.#record(
            key,
            actor,
            hash(["replace", collection, id, body]),
            "document",
            `${collection}/${id}`,
            context.now,
          );
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
        },
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

  /** Deletes one document and everything kept for it, returning what fan-out needs. */
  #deleteDocument(
    collection: string,
    id: string,
    restrictAuthor: string | null,
  ): { author: string; seq: number; mode: Mode } | null {
    const own = restrictAuthor === null ? "" : " and author = ?";
    const [gone] = this.#all<{ size: number; author: string }>(
      `delete from pf_documents where collection = ? and id = ?${own} returning size, author`,
      collection,
      id,
      ...(restrictAuthor === null ? [] : [restrictAuthor]),
    );
    if (gone === undefined) return null;
    this.#unindexDocument(collection, id);
    this.#countAuthor(collection, gone.author, -1);
    this.#all(
      "update pf_collections set documents = documents - 1, bytes = bytes - ? where name = ?",
      gone.size,
      collection,
    );
    const { mode } = this.#collection(collection);
    const seq = this.#nextSeq(
      mode === "own" ? `author:${gone.author}` : `collection:${collection}`,
    );
    return { author: gone.author, seq, mode };
  }

  /**
   * Deletes a document. A visitor deleting what they created spends the reserved rights
   * allowance, so nobody else's use can block it (finding 12); every other delete spends cleanup.
   * Never refused by growth or the terms.
   */
  remove(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
  ): Outcome<{ id: string; author: string; seq: number }> {
    const caller = context.caller;
    const actor = actorOf(caller);
    let creator: string | undefined;
    return this.#mutation(
      {
        envelope,
        context,
        actor,
        request: ["remove", collection, id],
        authorize: () => {
          if (deleteScope(this.#collection(collection).mode, caller) === "none") {
            throw new DataError("forbidden", "you cannot delete in this collection");
          }
          creator = this.#all<{ author: string }>(
            "select author from pf_documents where collection = ? and id = ?",
            collection,
            id,
          )[0]?.author;
        },
        lane: () => (caller.kind === "visitor" && creator === caller.author ? "rights" : "cleanup"),
        rate:
          caller.kind === "visitor"
            ? {
                subject: caller.author,
                kind: "deletes",
                limit: context.limits.deletesPerAuthorPerMinute,
              }
            : undefined,
        work: () => {
          const scope = deleteScope(this.#collection(collection).mode, caller);
          const restrict = scope === "own" && caller.kind === "visitor" ? caller.author : null;
          const gone = this.#deleteDocument(collection, id, restrict);
          if (gone === null) throw new DataError("not_found", "no such document");
          const key = this.#opKey(envelope, actor);
          this.#record(
            key,
            actor,
            hash(["remove", collection, id]),
            "deleted",
            `${collection}/${id}`,
            context.now,
          );
          if (caller.kind === "owner")
            this.#audit(key, envelope.ownerId, "data.document_deleted", {}, context.now);
          return { id, author: gone.author, seq: gone.seq };
        },
      },
      (gone) =>
        this.#notify(collection, gone.author, { collection, kind: "deleted", id, seq: gone.seq }),
    );
  }

  /** The owner side deletes up to CAPS.bulkDocuments of one collection in one operation. */
  bulkRemove(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    ids: string[],
  ): Outcome<{ removed: number }> {
    const actor = actorOf(context.caller);
    const notices: { author: string; message: ChangeMessage }[] = [];
    return this.#mutation(
      {
        envelope,
        context,
        actor,
        request: ["bulk_remove", collection, ids],
        authorize: () => {
          if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
          if (ids.length === 0 || ids.length > CAPS.bulkDocuments) {
            throw new DataError("invalid_input", `between 1 and ${CAPS.bulkDocuments} documents`);
          }
          this.#collection(collection);
        },
        lane: () => "cleanup",
        work: () => {
          let removed = 0;
          for (const id of ids) {
            const gone = this.#deleteDocument(collection, id, null);
            if (gone === null) continue;
            removed += 1;
            notices.push({
              author: gone.author,
              message: { collection, kind: "deleted", id, seq: gone.seq },
            });
          }
          const key = this.#opKey(envelope, actor);
          this.#record(
            key,
            actor,
            hash(["bulk_remove", collection, ids]),
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
        },
      },
      () => {
        for (const notice of notices) this.#notify(collection, notice.author, notice.message);
      },
    );
  }

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
   * Reads: admitted, refused when the day's reads are spent, done, and counted in memory; the
   * count reaches storage with the next write or every READ_FLUSH, so a read writes no row of its
   * own. An eviction loses at most READ_FLUSH of them.
   */
  #read<T>(envelope: Envelope, context: CallContext, work: () => T): Outcome<T> {
    return this.#run(() => {
      if (!this.#hasSchema()) return work();
      this.#admit(envelope, { kind: "request", create: false }, context.now);
      if (this.#readLimited(context)) {
        this.#countRefusal(context.now);
        throw new DataError("rate_limited", "too many reads, try again in a minute");
      }
      this.#refuseIfSpent("read", context);
      const value = work();
      this.#pendingReads(context.now).rows += this.#cost.rowsRead + this.#cost.rowsWritten;
      this.#maybeFlushReads(context.now);
      return value;
    });
  }

  get(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    id: string,
  ): Outcome<StoredDocument> {
    return this.#read(envelope, context, () => {
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

  query(envelope: Envelope, context: CallContext, spec: QuerySpec): Outcome<Page> {
    return this.#read(envelope, context, () => {
      if (!this.#hasSchema()) return { documents: [], next: null };
      const target = this.#collection(spec.collection);
      const scope = readScope(target.mode, context.caller);
      if (scope === "none") return { documents: [], next: null };
      const caller = context.caller;
      const author = caller.kind === "visitor" ? caller.author : null;
      const ready = this.#all<{ name: string }>(
        "select name from pf_fields where state = 'ready'",
      ).map((row) => row.name);
      const { sql, params, limit } = buildQuery(spec, scope, author, ready);
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

  /** The owner side's counts: from the collection's counter, or one author's maintained counter. */
  count(
    envelope: Envelope,
    context: CallContext,
    collection: string,
    by?: string,
  ): Outcome<{ documents: number }> {
    return this.#read(envelope, context, () => {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      if (!this.#hasSchema()) return { documents: 0 };
      const target = this.#collection(collection);
      if (by === undefined) return { documents: target.documents };
      const [row] = this.#all<{ documents: number }>(
        "select documents from pf_author_counts where collection = ? and author = ?",
        collection,
        by,
      );
      return { documents: row?.documents ?? 0 };
    });
  }

  explainQuery(spec: QuerySpec, scope: "all" | "own", ready: string[]): string[] {
    this.#ensureSchema();
    const { sql, params } = buildQuery(spec, scope, "v_x", ready);
    return this.ctx.storage.sql
      .exec<{ detail: string }>(`explain query plan ${sql}`, ...params)
      .toArray()
      .map((row) => row.detail);
  }

  /**
   * Erases one author in bounded, replayable chunks (finding 7). The first chunk sets the barrier
   * (on an empty object too), closes the author's connections and deletes their sequence; every
   * chunk deletes at most CAPS.eraseChunkDocuments of the author's documents and marks as many of
   * their edits on other people's documents `erased`, each through the sequence and live
   * invalidation, and deletes their operation and rate rows; the chunk that finds nothing left
   * checks and cleans the rest atomically and marks the barrier complete. Counted against cleanup,
   * never refused for it.
   */
  eraseAuthorChunk(
    envelope: Envelope,
    author: string,
    chunk: number,
    context?: CallContext,
  ): Outcome<{ erased: number; more: boolean }> {
    const take = Math.min(Math.max(chunk, 1), CAPS.eraseChunkDocuments);
    const now = context?.now ?? Date.now();
    const notices: { collection: string; author: string; message: ChangeMessage }[] = [];
    const call: CallContext = context ?? {
      caller: { kind: "owner", actor: "erasure" },
      limits: OWNER_PEEK(now).limits,
      now,
    };
    return this.#mutation(
      {
        envelope,
        context: call,
        actor: ERASURE_ACTOR,
        request: ["erase_author", author, take],
        create: true,
        authorize: () => {},
        lane: () => "cleanup",
        protectedWork: true,
        work: () => {
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
          const gone = this.#all<{ collection: string; id: string }>(
            "select collection, id from pf_documents indexed by pf_documents_by_author where author = ? limit ?",
            author,
            take,
          );
          for (const row of gone) {
            const deleted = this.#deleteDocument(row.collection, row.id, null);
            if (deleted !== null && deleted.mode !== "own") {
              notices.push({
                collection: row.collection,
                author,
                message: {
                  collection: row.collection,
                  kind: "deleted",
                  id: row.id,
                  seq: deleted.seq,
                },
              });
            }
          }
          const edits = this.#all<{ collection: string; id: string; author: string }>(
            "select collection, id, author from pf_documents indexed by pf_documents_by_editor where editor = ? limit ?",
            author,
            take,
          );
          for (const row of edits) {
            const { mode } = this.#collection(row.collection);
            const seq = this.#nextSeq(
              mode === "own" ? `author:${row.author}` : `collection:${row.collection}`,
            );
            this.#all(
              "update pf_documents set editor = 'erased', seq = ? where collection = ? and id = ?",
              seq,
              row.collection,
              row.id,
            );
            notices.push({
              collection: row.collection,
              author: row.author,
              message: { collection: row.collection, kind: "updated", id: row.id, seq },
            });
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
          let more =
            gone.length === take ||
            edits.length === take ||
            ops.length === take ||
            rates.length === take;
          if (!more) {
            // The atomic terminal check: nothing of the author remains, so finish in this transaction.
            const left =
              this.#all(
                "select 1 from pf_documents indexed by pf_documents_by_author where author = ? limit 1",
                author,
              ).length +
              this.#all(
                "select 1 from pf_documents indexed by pf_documents_by_editor where editor = ? limit 1",
                author,
              ).length;
            more = left > 0;
            if (!more) {
              this.#all("delete from pf_seq where scope = ?", `author:${author}`);
              this.#all("delete from pf_author_counts where author = ?", author);
              this.#all("update pf_barriers set complete = 1 where author = ?", author);
            }
          }
          const result = { erased: gone.length, more };
          const key = this.#opKey(envelope, ERASURE_ACTOR);
          this.#record(
            key,
            ERASURE_ACTOR,
            hash(["erase_author", author, take]),
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
        },
      },
      () => {
        for (const notice of notices)
          this.#notify(notice.collection, notice.author, notice.message);
      },
    );
  }

  /**
   * A fence: validated against the generation and the owner, idempotent by the transition's ID
   * and contents, persisted before it is acknowledged, on an empty object too.
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
        const moved = stored !== null && applied.control.ownerId !== stored.ownerId;
        if (applied.control.hold !== null || moved) this.closeConnections(4003);
        this.#reschedule();
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
  quarantine(envelope: Envelope, reason: "owner" | "hold" | "orphan" | "generation"): boolean {
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
   * The operator's exit from a quarantine: `adopt` when the envelope names the owner the object
   * recorded; `erase` moves to the next generation, and is refused while a hold stands: a hold
   * keeps the evidence until a separately authorized release was acknowledged (finding 1).
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
        if (stored.hold !== null)
          return { ok: false, message: "held: a release must be acknowledged before erasing" };
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
      this.#reschedule();
      return { ok: true };
    });
  }

  controlRecord(): Control | null {
    return this.#control();
  }

  /**
   * Erase, step one, under a durable erase ID (finding 2): the same ID and target repeat; another
   * ID while one is prepared is a conflict; an ID that already ended answers how. On an empty
   * object it binds the identity. Connections close here, at the barrier (finding 11).
   */
  prepareErase(envelope: Envelope, eraseId: string): Outcome<{ prepared: boolean }> {
    return this.#run(() =>
      this.ctx.storage.transactionSync(() => {
        const stored = this.#control();
        if (stored?.lastErase?.id === eraseId) return { prepared: false };
        const verdict = admit(stored, envelope, { kind: "erase" });
        if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
        if ("done" in verdict) return { prepared: false };
        this.#ensureSchema();
        const base = stored ?? newControl(envelope, Date.now());
        if (base.erasing !== null) {
          if (base.erasing.id === eraseId && base.erasing.generation === envelope.generation)
            return { prepared: true };
          throw new DataError("conflict", "another erase is prepared");
        }
        this.#saveControl({
          ...base,
          erasing: { id: eraseId, generation: envelope.generation, epoch: envelope.epoch },
          storageSeq: base.storageSeq + 1,
        });
        this.closeConnections(4404);
        return { prepared: true };
      }),
    );
  }

  #erasePayload(): void {
    for (const table of PAYLOAD_TABLES) this.#all(`delete from ${table}`);
    this.closeConnections(4404);
  }

  /**
   * Erase, step two: only the prepared ID commits. One transaction deletes the payload and writes
   * the next generation; budgets, barriers and audit obligations stay. A retry of a committed ID
   * answers that it was erased. Counted against cleanup, never refused for it.
   */
  commitErase(envelope: Envelope, eraseId: string): Outcome<{ erased: boolean }> {
    return this.#run(() =>
      this.ctx.storage.transactionSync(() => {
        const stored = this.#control();
        if (stored?.lastErase?.id === eraseId)
          return { erased: stored.lastErase.outcome === "committed" };
        const verdict = admit(stored, envelope, { kind: "erase" });
        if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
        if ("done" in verdict || stored === null) return { erased: false };
        if (
          stored.erasing === null ||
          stored.erasing.id !== eraseId ||
          stored.erasing.generation !== envelope.generation
        ) {
          throw new DataError("conflict", "this erase is not the prepared one");
        }
        this.#erasePayload();
        this.#saveControl({
          ...stored,
          generation: stored.generation + 1,
          erasing: null,
          lastErase: { id: eraseId, outcome: "committed" },
          storageSeq: stored.storageSeq + 1,
          payloadRevision: stored.payloadRevision + 1,
        });
        this.#charge("cleanup", Date.now(), this.#cost);
        return { erased: true };
      }),
    );
  }

  cancelErase(envelope: Envelope, eraseId: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#control();
      const verdict = admit(stored, envelope, { kind: "erase" });
      if (!verdict.ok || "done" in verdict || stored === null || stored.erasing?.id !== eraseId)
        return false;
      this.#saveControl({
        ...stored,
        erasing: null,
        lastErase: { id: eraseId, outcome: "cancelled" },
        storageSeq: stored.storageSeq + 1,
      });
      return true;
    });
  }

  /**
   * The audit relay's question: the operation's full identity is the actor, the generation and
   * its ID. Maintenance admission; on an empty object the first write binds its identity. An
   * erased author's late settlement writes nothing about them (finding 7).
   */
  settle(
    envelope: Envelope,
    actor: string,
    opId: string,
  ):
    | { state: "committed"; kind: string; detail: string; delivered: boolean }
    | { state: "aborted" }
    | { state: "refused" } {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    return this.ctx.storage.transactionSync(() => {
      try {
        this.#admit(envelope, { kind: "maintenance" }, Date.now(), true);
      } catch {
        return { state: "refused" as const };
      }
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
      if (record === undefined && !this.#barred(actor)) {
        this.#touch();
        this.#all(
          "insert into pf_ops (op_key, actor, request_hash, state, kind, target, at) values (?, ?, '', 'aborted', 'aborted', '', ?)",
          key,
          actor,
          Date.now(),
        );
        this.#scheduleAt(Date.now() + REPLAY_MS);
      }
      return { state: "aborted" as const };
    });
  }

  /** Marks an obligation delivered; kept for late settlement, pruned after DELIVERED_MS. */
  acknowledge(envelope: Envelope, actor: string, opId: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (!this.#hasSchema()) return false;
      try {
        this.#admit(envelope, { kind: "maintenance" }, Date.now());
      } catch {
        return false;
      }
      const key = operationKey(actor, envelope.generation, opId);
      const updated = this.#all(
        "update pf_audit set state = 'delivered', at = ? where op_key = ? and state = 'pending' returning 1",
        Date.now(),
        key,
      );
      if (updated.length > 0) {
        this.#touch();
        this.#scheduleAt(Date.now() + DELIVERED_MS);
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
      .exec<Record<string, number>>(
        "select read_used, written_used, cleanup_used, export_used, rights_used, live_messages, refused from pf_day where day = ?",
        day(now),
      )
      .toArray();
    const pending = this.#reads.day === day(now) ? this.#reads : { rows: 0, refused: 0 };
    return {
      rows_read: (today?.read_used ?? 0) + pending.rows,
      rows_written: today?.written_used ?? 0,
      cleanup: today?.cleanup_used ?? 0,
      export: today?.export_used ?? 0,
      rights: today?.rights_used ?? 0,
      live_messages: today?.live_messages ?? 0,
      refused: (today?.refused ?? 0) + pending.refused,
    };
  }

  size(): StorageReport {
    return this.#storage();
  }

  #exportRows(
    sql: string,
    params: unknown[],
    take: number,
  ): { rows: ExportRow[]; cut: boolean; bytes: number } {
    const cursor = this.ctx.storage.sql.exec<DocumentRow & { collection: string }>(sql, ...params);
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
      if (rows.length >= take || (rows.length > 0 && bytes + size > CAPS.exportBytes)) {
        cut = true;
        break;
      }
      rows.push(exported);
      bytes += size;
    }
    this.#cost.rowsRead += cursor.rowsRead;
    return { rows, cut, bytes };
  }

  /** Runs an export page in one transaction and charges its lane what it measured. */
  #exportPage(
    envelope: Envelope,
    context: CallContext,
    lane: Lane,
    operator: boolean,
    page: () => ExportPage,
  ): Outcome<ExportPage> {
    return this.#run(() => {
      if (!this.#hasSchema()) return { rows: [], next: null, revision: 0, bytes: 0 };
      return this.ctx.storage.transactionSync(() => {
        this.#admit(
          envelope,
          operator ? { kind: "operator" } : { kind: "request", create: false },
          context.now,
        );
        if (!operator) this.#refuseIfSpent(lane, context);
        const value = page();
        this.#touch();
        this.#charge(lane, context.now, this.#cost);
        return value;
      });
    });
  }

  /**
   * One export page: documents in primary key order after `after`, bodies exactly as stored,
   * at most CAPS.exportRows rows or CAPS.exportBytes, with the payload revision. The owner side,
   * or the operator under a hold or quarantine (counted, never refused).
   */
  exportPage(
    envelope: Envelope,
    context: CallContext,
    after: { collection: string; id: string } | null,
    limit: number,
    operator = false,
  ): Outcome<ExportPage> {
    if (!operator && context.caller.kind !== "owner") {
      return {
        ok: false,
        error: "forbidden",
        message: "owner side only",
        cost: { rowsRead: 0, rowsWritten: 0 },
        storage: this.#storage(),
      };
    }
    const take = Math.min(Math.max(limit, 1), CAPS.exportRows);
    return this.#exportPage(envelope, context, "export", operator, () => {
      const { rows, cut, bytes } = this.#exportRows(
        `select collection, id, author, editor, created, updated, seq, body from pf_documents
         where (collection, id) > (?, ?) order by collection, id limit ?`,
        [after?.collection ?? "", after?.id ?? "", take + 1],
        take,
      );
      const last = rows.at(-1);
      return {
        rows,
        next: cut && last !== undefined ? { collection: last.collection, id: last.id } : null,
        revision: this.#control()?.payloadRevision ?? 0,
        bytes,
      };
    });
  }

  /**
   * A visitor's export of the documents they created, through the author index, byte-bounded,
   * from the rights allowance; it needs neither write permission nor the current terms (finding 12).
   */
  exportMine(
    envelope: Envelope,
    context: CallContext,
    after: { collection: string; id: string } | null,
  ): Outcome<ExportPage> {
    const caller = context.caller;
    if (caller.kind !== "visitor") {
      return {
        ok: false,
        error: "forbidden",
        message: "a grant holder's own export",
        cost: { rowsRead: 0, rowsWritten: 0 },
        storage: this.#storage(),
      };
    }
    return this.#exportPage(envelope, context, "rights", false, () => {
      const { rows, cut, bytes } = this.#exportRows(
        `select collection, id, author, editor, created, updated, seq, body from pf_documents indexed by pf_documents_by_author
         where author = ? and (collection, id) > (?, ?) order by collection, id limit ?`,
        [caller.author, after?.collection ?? "", after?.id ?? "", CAPS.exportRows + 1],
        CAPS.exportRows,
      );
      const last = rows.at(-1);
      return {
        rows,
        next: cut && last !== undefined ? { collection: last.collection, id: last.id } : null,
        revision: this.#control()?.payloadRevision ?? 0,
        bytes,
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
      this.#admit(envelope, { kind: "request", create: true }, now, true);
      for (let index = 0; index < count; index++) {
        this.#all(
          "insert into pf_documents (collection, id, author, created, updated, seq, body, size) values (?, ?, ?, ?, ?, ?, ?, 40)",
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
      this.#all("delete from pf_author_counts where collection = ?", collection);
      this.#all(
        "insert into pf_author_counts (collection, author, documents) select collection, author, count(*) from pf_documents where collection = ? group by author",
        collection,
      );
    });
    return count;
  }

  /** Spike only: backdates replay records, to test pruning. */
  backdateReplays(at: number): void {
    if (!this.#hasSchema()) return;
    this.ctx.storage.sql.exec("update pf_ops set at = ?", at);
  }

  // Housekeeping (finding 10): one alarm closes expired connections and prunes every retained
  // class in bounded, age-ordered batches through age-leading indexes. Under a hold or a
  // quarantine nothing is pruned and no pruning alarm is set (finding 6); a release re-arms it.

  #scheduleAt(at: number): void {
    void this.ctx.storage.getAlarm().then((current) => {
      if (current === null || current > at) return this.ctx.storage.setAlarm(at);
      return undefined;
    });
  }

  /** The earliest moment any eligible maintenance can run, or null. */
  #nextDeadline(now: number, more: boolean): number | null {
    const candidates: number[] = [];
    for (const socket of this.ctx.getWebSockets())
      candidates.push((socket.deserializeAttachment() as Attachment).deadline);
    const control = this.#control();
    if (control !== null && control.hold === null && control.quarantine === null) {
      if (more) candidates.push(now + 60_000);
      const first = (sql: string) => {
        const [row] = this.ctx.storage.sql.exec<{ at: number | null }>(sql).toArray();
        return row?.at ?? null;
      };
      const op = first("select min(at) as at from pf_ops");
      if (op !== null) candidates.push(op + REPLAY_MS);
      const audit = first(
        "select min(at) as at from pf_audit indexed by pf_audit_state where state = 'delivered'",
      );
      if (audit !== null) candidates.push(audit + DELIVERED_MS);
      const rate = first("select min(window) as at from pf_rate indexed by pf_rate_window");
      if (rate !== null) candidates.push((rate + 1441) * 60_000);
      const old = first("select min(day) as at from pf_day");
      if (old !== null) candidates.push((old + 3) * 86_400_000);
    }
    return candidates.length === 0 ? null : Math.max(Math.min(...candidates), now + 1_000);
  }

  #reschedule(): void {
    const next = this.#nextDeadline(Date.now(), false);
    void (next === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(next));
  }

  /** Prunes one batch of each retained class; returns how many rows went. */
  pruneReplays(now: number): number {
    return this.#prune(now).pruned;
  }

  #prune(now: number): { pruned: number; more: boolean } {
    if (!this.#hasSchema()) return { pruned: 0, more: false };
    const control = this.#control();
    if (control === null || control.hold !== null || control.quarantine !== null)
      return { pruned: 0, more: false };
    return this.ctx.storage.transactionSync(() => {
      const counts = [
        this.#all(PRUNE.ops, now - REPLAY_MS, CAPS.pruneRows).length,
        this.#all(PRUNE.audit, now - DELIVERED_MS, CAPS.pruneRows).length,
        this.#all(PRUNE.rate, minute(now) - 1440, CAPS.pruneRows).length,
        this.#all(PRUNE.days, day(now) - 2, CAPS.pruneRows).length,
      ];
      const pruned = counts.reduce((sum, n) => sum + n, 0);
      if (pruned > 0) this.#touch();
      return { pruned, more: counts.some((n) => n === CAPS.pruneRows) };
    });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.deadline <= now) socket.close(4001, "renew");
    }
    const { more } = this.#prune(now);
    this.#maybeFlushReads(now, true);
    const next = this.#nextDeadline(now, more);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
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
      const page = this.query(envelope, OWNER_PEEK(Number(url.searchParams.get("now"))), {
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
    };
    let control: Control;
    try {
      this.#cost = { rowsRead: 0, rowsWritten: 0 };
      control = this.ctx.storage.transactionSync(() => {
        const admitted = this.#admit(envelope, { kind: "request", create: false }, caller.now);
        if (admitted === null) throw new DataError("not_found", "no data");
        if (caller.deadline <= caller.now) throw new DataError("forbidden", "expired");
        if (caller.author !== null && this.#barred(caller.author))
          throw new DataError("forbidden", "erased");
        this.#rate(
          caller.author ?? "readers",
          "connects",
          minute(caller.now),
          caller.limits.connectsPerAuthorPerMinute,
        );
        this.#touch();
        this.#charge("growth", caller.now, this.#cost);
        return admitted;
      });
    } catch (error) {
      if (error instanceof DataError) {
        const status = error.code === "rate_limited" ? 429 : error.code === "not_found" ? 404 : 403;
        return new Response(null, { status });
      }
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
      generation: control.generation,
      subscriptions: [],
      deadline: caller.deadline,
      window: minute(caller.now),
      messagesIn: 0,
      bytesOut: 0,
      reserved: 0,
      liveMessagesPerDay: caller.limits.liveMessagesPerDay,
    } satisfies Attachment);
    this.#scheduleAt(caller.deadline);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "X-Portifact-Socket": socketId },
    });
  }

  /** Renewal by the same principal; it may shorten the deadline and carries the current plan's limit. */
  renew(
    envelope: Envelope,
    socketId: string,
    principal: string,
    deadline: number,
    limits?: DataLimits,
  ): boolean {
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
      socket.serializeAttachment({
        ...attachment,
        deadline,
        liveMessagesPerDay: limits?.liveMessagesPerDay ?? attachment.liveMessagesPerDay,
      } satisfies Attachment);
      this.#scheduleAt(deadline);
      return true;
    }
    return false;
  }

  /** A connection is live only while its deadline holds and the control record still admits it. */
  #live(socket: WebSocket, now: number): Attachment | null {
    const attachment = socket.deserializeAttachment() as Attachment;
    if (attachment.deadline <= now) {
      socket.close(4001, "renew");
      return null;
    }
    const control = this.#control();
    if (
      control === null ||
      control.hold !== null ||
      control.quarantine !== null ||
      control.erasing !== null ||
      control.generation !== attachment.generation
    ) {
      socket.close(4003, "reconnect");
      return null;
    }
    const window = minute(now);
    return window === attachment.window
      ? attachment
      : { ...attachment, window, messagesIn: 0, bytesOut: 0 };
  }

  /**
   * Every message sent, acknowledgements and errors included, spends a message the connection
   * reserved against the artifact's day. Reservations are taken LIVE.reserveChunk at a time, two
   * rows written each (the day's counter and the control record's sequence). A refused
   * reservation closes the connection with 4029; past the minute's bytes, 4009.
   */
  #send(socket: WebSocket, attachment: Attachment, text: string, now: number): Attachment | null {
    const bytes = utf8(text);
    if (attachment.bytesOut + bytes > LIVE.bytesOutPerMinute) {
      socket.close(4009, "slow down");
      return null;
    }
    let reserved = attachment.reserved;
    if (reserved < 1) {
      const allowed = this.ctx.storage.transactionSync(() => {
        const [row] = this.#all<{ live_messages: number }>(
          `insert into pf_day (day, live_messages) values (?, ?)
           on conflict (day) do update set live_messages = live_messages + excluded.live_messages returning live_messages`,
          day(now),
          LIVE.reserveChunk,
        );
        if ((row as { live_messages: number }).live_messages > attachment.liveMessagesPerDay)
          return false;
        this.#touch();
        return true;
      });
      if (!allowed) {
        socket.close(4029, "live data limit reached for today");
        return null;
      }
      reserved += LIVE.reserveChunk;
    }
    const next = { ...attachment, bytesOut: attachment.bytesOut + bytes, reserved: reserved - 1 };
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
    let mode: Mode;
    try {
      mode = this.#collection(collection).mode;
    } catch {
      return;
    }
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

function OWNER_PEEK(now: number): CallContext {
  return {
    caller: { kind: "owner" },
    now,
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
      liveMessagesPerDay: 100_000,
      cleanupRowsPerDay: 100_000,
      exportRowsPerDay: 1_000_000,
      rightsRowsPerDay: 10_000,
    },
  };
}
