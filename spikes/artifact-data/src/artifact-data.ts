// One artifact's database (decision 0026): a SQLite-backed Durable Object named by the artifact
// ID. The reserved `pf_` tables hold the document collections; the owner side may add its own
// tables with SQL. Every method takes the caller as the Worker decided it and the limits of the
// owner's plan; nothing here trusts the page. Each call returns the rows SQLite read and wrote,
// so the spike's cost table is measured.
import { DurableObject } from "cloudflare:workers";
import {
  buildQuery,
  type Caller,
  collectionName,
  DataError,
  type DataErrorCode,
  type DataLimits,
  documentBody,
  encodeCursor,
  type Mode,
  OWNER_AUTHOR,
  mode as parseMode,
  type QuerySpec,
  readScope,
  writeScope,
} from "./model.ts";
import { checkProgram, checkStatement, type ExplainRow } from "./sql-guard.ts";

/** What the Worker states about the artifact on every call; the object refuses a mismatch. */
export interface ArtifactRef {
  artifactId: string;
  region: string;
}

export interface Cost {
  rowsRead: number;
  rowsWritten: number;
}

export type Outcome<T> =
  | { ok: true; value: T; cost: Cost }
  | { ok: false; error: DataErrorCode; message: string; cost: Cost };

/**
 * A body field. Not a recursive JSON type: the RPC stub's mapped types give up on one ("excessively
 * deep"), and an `unknown` field drops the success branch of every outcome.
 */
export type Json = string | number | boolean | null | object;

export interface StoredDocument {
  _id: string;
  _by: string;
  _created: number;
  _updated: number;
  _seq: number;
  [field: string]: Json;
}

export interface Page {
  documents: StoredDocument[];
  next: string | null;
}

/** What a live connection learns about one change. */
export interface ChangeMessage {
  collection: string;
  kind: "created" | "updated" | "deleted";
  id: string;
  seq: number;
  document?: StoredDocument;
}

/** A connection's identity and subscriptions, kept across hibernation. */
interface Attachment {
  author: string | null;
  subscriptions: string[];
}

/** Rows and bytes an owner statement may return. */
export const SQL_RESULT_ROWS = 1_000;
export const SQL_RESULT_BYTES = 1024 * 1024;

const SCHEMA = [
  "create table if not exists pf_meta (key text primary key, value) without rowid",
  `create table if not exists pf_collections (
     name text primary key, mode text not null, unique_key text,
     documents integer not null default 0, bytes integer not null default 0) without rowid`,
  `create table if not exists pf_documents (
     collection text not null, id text not null, author text not null,
     created integer not null, updated integer not null, seq integer not null,
     unique_value text, body text not null, size integer not null,
     primary key (collection, id)) without rowid`,
  "create index if not exists pf_documents_author on pf_documents (collection, author, created, id)",
  "create index if not exists pf_documents_created on pf_documents (collection, created, id)",
  `create unique index if not exists pf_documents_unique
     on pf_documents (collection, author, unique_value) where unique_value is not null`,
  "create table if not exists pf_rate (author text primary key, window integer not null, count integer not null) without rowid",
];

/** The reserved objects' names, in `sqlite_schema`. */
const RESERVED = "(name like 'pf\\_%' escape '\\' or tbl_name like 'pf\\_%' escape '\\')";

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_");
}

export class ArtifactData extends DurableObject {
  #cost: Cost = { rowsRead: 0, rowsWritten: 0 };
  /** Kept in memory once seen, so a warm call reads neither `sqlite_schema` nor `pf_meta`. */
  #schemaReady = false;
  #verified: string | null = null;

  /** Runs one statement, consumes its rows and adds what SQLite read and wrote to the call. */
  #all<T extends Record<string, SqlStorageValue>>(sql: string, ...params: unknown[]): T[] {
    const cursor = this.ctx.storage.sql.exec<T>(sql, ...params);
    const rows = cursor.toArray();
    this.#cost.rowsRead += cursor.rowsRead;
    this.#cost.rowsWritten += cursor.rowsWritten;
    return rows;
  }

  #hasSchema(): boolean {
    if (!this.#schemaReady) {
      this.#schemaReady =
        this.#all("select 1 as found from sqlite_schema where name = 'pf_documents'").length === 1;
    }
    return this.#schemaReady;
  }

  /** Creates the reserved tables on the first write, so a read of an empty artifact stores nothing. */
  #ensureSchema(ref: ArtifactRef): void {
    if (!this.#hasSchema()) {
      for (const statement of SCHEMA) this.#all(statement);
      this.#schemaReady = true;
    }
    if (this.#verified === `${ref.artifactId}\u0000${ref.region}`) return;
    const stored = this.#all<{ key: string; value: string }>(
      "select key, value from pf_meta where key in ('artifact', 'region')",
    );
    if (stored.length === 0) {
      this.#all(
        "insert into pf_meta (key, value) values ('artifact', ?), ('region', ?), ('seq', 0)",
        ref.artifactId,
        ref.region,
      );
      return;
    }
    this.#checkRef(ref, stored);
  }

  /** Checks the reference against `pf_meta`, once per instance. */
  #verifyRef(ref: ArtifactRef): void {
    if (this.#verified === `${ref.artifactId}\u0000${ref.region}`) return;
    this.#checkRef(
      ref,
      this.#all("select key, value from pf_meta where key in ('artifact', 'region')"),
    );
  }

  #checkRef(ref: ArtifactRef, stored: { key: string; value: string }[]): void {
    for (const row of stored) {
      const expected = row.key === "artifact" ? ref.artifactId : ref.region;
      // A wrong name or jurisdiction would mean the Worker resolved the wrong object: refuse
      // rather than mix two artifacts' data.
      if (row.value !== expected) throw new DataError("forbidden", "artifact reference mismatch");
    }
    this.#verified = `${ref.artifactId}\u0000${ref.region}`;
  }

  #run<T>(work: () => T): Outcome<T> {
    this.#cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      const value = work();
      return { ok: true, value, cost: this.#cost };
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

  #collection(name: string): { mode: Mode; uniqueKey: string | null; documents: number } {
    const rows = this.#all<{ mode: string; unique_key: string | null; documents: number }>(
      "select mode, unique_key, documents from pf_collections where name = ?",
      collectionName(name),
    );
    const row = rows[0];
    if (row === undefined) throw new DataError("not_found", "no such collection");
    return { mode: row.mode as Mode, uniqueKey: row.unique_key, documents: row.documents };
  }

  #nextSeq(): number {
    const [row] = this.#all<{ value: number }>(
      "update pf_meta set value = value + 1 where key = 'seq' returning value",
    );
    return (row as { value: number }).value;
  }

  /** Counts one write against the author's per-minute budget, inside the write's transaction. */
  #countWrite(author: string, limit: number, now: number): void {
    const window = Math.floor(now / 60_000);
    const [row] = this.#all<{ count: number }>(
      `insert into pf_rate (author, window, count) values (?, ?, 1)
       on conflict (author) do update set
         count = case when window = excluded.window then count + 1 else 1 end,
         window = excluded.window
       returning count`,
      author,
      window,
    );
    if ((row as { count: number }).count > limit) {
      throw new DataError("rate_limited", "too many writes, try again in a minute");
    }
  }

  /** The object's whole database must stay within the plan's size, checked before commit. */
  #checkSize(limits: DataLimits): void {
    if (this.ctx.storage.sql.databaseSize > limits.bytesPerArtifact) {
      throw new DataError("quota_exceeded", "this artifact's data is full");
    }
  }

  #document(row: {
    id: string;
    author: string;
    created: number;
    updated: number;
    seq: number;
    body: string;
  }): StoredDocument {
    return {
      ...(JSON.parse(row.body) as Record<string, Json>),
      _id: row.id,
      _by: row.author,
      _created: row.created,
      _updated: row.updated,
      _seq: row.seq,
    };
  }

  /** Owner side: declares a collection or changes its mode. */
  declareCollection(
    ref: ArtifactRef,
    input: { name: string; mode: string; uniqueKey?: string },
    limits: DataLimits,
  ): Outcome<{ name: string; mode: Mode }> {
    return this.#run(() =>
      this.ctx.storage.transactionSync(() => {
        this.#ensureSchema(ref);
        const name = collectionName(input.name);
        const chosen = parseMode(input.mode);
        const [count] = this.#all<{ n: number }>("select count(*) as n from pf_collections");
        const exists = this.#all("select 1 from pf_collections where name = ?", name).length;
        if (exists === 0 && (count as { n: number }).n >= limits.collections) {
          throw new DataError("quota_exceeded", `at most ${limits.collections} collections`);
        }
        this.#all(
          `insert into pf_collections (name, mode, unique_key) values (?, ?, ?)
           on conflict (name) do update set mode = excluded.mode`,
          name,
          chosen,
          input.uniqueKey ?? null,
        );
        return { name, mode: chosen };
      }),
    );
  }

  create(
    ref: ArtifactRef,
    caller: Caller,
    collection: string,
    body: unknown,
    limits: DataLimits,
    now: number,
  ): Outcome<StoredDocument> {
    const outcome = this.#run(() =>
      this.ctx.storage.transactionSync(() => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such collection");
        this.#ensureSchema(ref);
        const target = this.#collection(collection);
        if (writeScope(target.mode, caller) === "none") {
          throw new DataError("forbidden", "you cannot write to this collection");
        }
        const author = caller.kind === "visitor" ? caller.author : OWNER_AUTHOR;
        if (caller.kind === "visitor")
          this.#countWrite(author, limits.writesPerAuthorPerMinute, now);
        if (target.documents >= limits.documentsPerCollection) {
          throw new DataError(
            "quota_exceeded",
            `a collection holds at most ${limits.documentsPerCollection} documents`,
          );
        }
        const { text, size } = documentBody(body, limits.documentBytes);
        let unique: string | null = null;
        if (target.uniqueKey !== null) {
          const value = (body as Record<string, unknown>)[target.uniqueKey];
          if (value === undefined) throw new DataError("invalid_input", "missing unique field");
          unique = JSON.stringify(value);
        }
        const id = newId();
        const seq = this.#nextSeq();
        this.#all(
          `insert into pf_documents (collection, id, author, created, updated, seq, unique_value, body, size)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          collection,
          id,
          author,
          now,
          now,
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
        this.#checkSize(limits);
        return this.#document({ id, author, created: now, updated: now, seq, body: text });
      }),
    );
    if (outcome.ok) this.#broadcast(collection, "created", outcome.value);
    return outcome;
  }

  /**
   * Replaces a document's body. In `own` and `append` the author condition is part of both the
   * read and the UPDATE, so another author's ID is simply not found.
   */
  update(
    ref: ArtifactRef,
    caller: Caller,
    collection: string,
    id: string,
    body: unknown,
    limits: DataLimits,
    now: number,
  ): Outcome<StoredDocument> {
    const outcome = this.#run(() =>
      this.ctx.storage.transactionSync(() => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
        this.#ensureSchema(ref);
        const target = this.#collection(collection);
        const scope = writeScope(target.mode, caller);
        if (scope === "none")
          throw new DataError("forbidden", "you cannot write to this collection");
        if (caller.kind === "visitor") {
          this.#countWrite(caller.author, limits.writesPerAuthorPerMinute, now);
        }
        const { text, size } = documentBody(body, limits.documentBytes);
        const own = scope === "own" ? " and author = ?" : "";
        const mine = scope === "own" && caller.kind === "visitor" ? [caller.author] : [];
        const [old] = this.#all<{ size: number; author: string; created: number }>(
          `select size, author, created from pf_documents where collection = ? and id = ?${own}`,
          collection,
          id,
          ...mine,
        );
        if (old === undefined) throw new DataError("not_found", "no such document");
        const seq = this.#nextSeq();
        this.#all(
          `update pf_documents set body = ?, size = ?, updated = ?, seq = ? where collection = ? and id = ?${own}`,
          text,
          size,
          now,
          seq,
          collection,
          id,
          ...mine,
        );
        this.#all(
          "update pf_collections set bytes = bytes + ? where name = ?",
          size - old.size,
          collection,
        );
        this.#checkSize(limits);
        return this.#document({
          id,
          author: old.author,
          created: old.created,
          updated: now,
          seq,
          body: text,
        });
      }),
    );
    if (outcome.ok) this.#broadcast(collection, "updated", outcome.value);
    return outcome;
  }

  remove(
    ref: ArtifactRef,
    caller: Caller,
    collection: string,
    id: string,
    limits: DataLimits,
    now: number,
  ): Outcome<{ id: string; author: string; seq: number }> {
    const outcome = this.#run(() =>
      this.ctx.storage.transactionSync(() => {
        if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
        this.#ensureSchema(ref);
        const target = this.#collection(collection);
        const scope = writeScope(target.mode, caller);
        if (scope === "none")
          throw new DataError("forbidden", "you cannot write to this collection");
        if (caller.kind === "visitor") {
          this.#countWrite(caller.author, limits.writesPerAuthorPerMinute, now);
        }
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
        return { id, author: gone.author, seq: this.#nextSeq() };
      }),
    );
    if (outcome.ok) {
      this.#notify(collection, outcome.value.author, {
        collection,
        kind: "deleted",
        id,
        seq: outcome.value.seq,
      });
    }
    return outcome;
  }

  get(ref: ArtifactRef, caller: Caller, collection: string, id: string): Outcome<StoredDocument> {
    return this.#run(() => {
      if (!this.#hasSchema()) throw new DataError("not_found", "no such document");
      this.#verifyRef(ref);
      const target = this.#collection(collection);
      const scope = readScope(target.mode, caller);
      if (scope === "none") throw new DataError("not_found", "no such document");
      const own = scope === "own" ? " and author = ?" : "";
      const mine = scope === "own" && caller.kind === "visitor" ? [caller.author] : [];
      const [row] = this.#all<{
        id: string;
        author: string;
        created: number;
        updated: number;
        seq: number;
        body: string;
      }>(
        `select id, author, created, updated, seq, body from pf_documents where collection = ? and id = ?${own}`,
        collection,
        id,
        ...mine,
      );
      if (row === undefined) throw new DataError("not_found", "no such document");
      return this.#document(row);
    });
  }

  query(ref: ArtifactRef, caller: Caller, spec: QuerySpec): Outcome<Page> {
    return this.#run(() => {
      if (!this.#hasSchema()) return { documents: [], next: null };
      this.#verifyRef(ref);
      const target = this.#collection(spec.collection);
      const scope = readScope(target.mode, caller);
      if (scope === "none") return { documents: [], next: null };
      const author = caller.kind === "visitor" ? caller.author : null;
      const { sql, params, limit } = buildQuery(spec, scope, author);
      const rows = this.#all<{
        id: string;
        author: string;
        created: number;
        updated: number;
        seq: number;
        body: string;
      }>(sql, ...params);
      const documents = rows.slice(0, limit).map((row) => this.#document(row));
      const last = documents.at(-1);
      const next =
        rows.length > limit && last !== undefined ? encodeCursor(last._created, last._id) : null;
      return { documents, next };
    });
  }

  /**
   * Owner SQL, read or write, one statement. The text is checked by the lexer; what it writes
   * is checked by SQLite's own program (`EXPLAIN`) against the reserved tables' root pages; a
   * write runs in a transaction that is rolled back if the reserved schema changed, a trigger
   * appeared or the database outgrew the plan.
   */
  sql(
    ref: ArtifactRef,
    statement: string,
    params: (string | number | null)[],
    write: boolean,
    limits: DataLimits,
  ): Outcome<{ columns: string[]; rows: SqlStorageValue[][]; truncated: boolean }> {
    return this.#run(() => {
      const lexed = checkStatement(statement, params);
      if (!lexed.ok) throw new DataError("invalid_input", lexed.reason);
      if (write) this.ctx.storage.transactionSync(() => this.#ensureSchema(ref));
      const reserved = new Set(
        this.#all<{ rootpage: number }>(
          `select rootpage from sqlite_schema where ${RESERVED} and rootpage > 0`,
        ).map((row) => row.rootpage),
      );
      const program = this.#all<{ opcode: string; p1: number; p2: number }>(
        `explain ${statement}`,
        ...params,
      ) as ExplainRow[];
      const decided = checkProgram(program, reserved, write);
      if (!decided.ok) throw new DataError("forbidden", decided.reason);
      const execute = () => {
        const cursor = this.ctx.storage.sql.exec(statement, ...params);
        const rows: SqlStorageValue[][] = [];
        let bytes = 0;
        let truncated = false;
        for (const row of cursor.raw()) {
          bytes += JSON.stringify(row).length;
          if (rows.length >= SQL_RESULT_ROWS || bytes > SQL_RESULT_BYTES) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        this.#cost.rowsRead += cursor.rowsRead;
        this.#cost.rowsWritten += cursor.rowsWritten;
        return { columns: cursor.columnNames, rows, truncated };
      };
      if (!write) return execute();
      return this.ctx.storage.transactionSync(() => {
        const before = this.#schemaShape();
        const result = execute();
        const after = this.#schemaShape();
        if (after.reserved !== before.reserved) {
          throw new DataError("forbidden", "the reserved tables' schema cannot change");
        }
        if (after.triggers !== before.triggers) {
          throw new DataError("forbidden", "triggers are not allowed");
        }
        this.#checkSize(limits);
        return result;
      });
    });
  }

  #schemaShape(): { reserved: string; triggers: number } {
    const [shape] = this.#all<{ reserved: string | null; triggers: number }>(
      `select
         (select group_concat(type || ':' || name || ':' || coalesce(sql, ''), '|')
            from (select * from sqlite_schema where ${RESERVED} order by name)) as reserved,
         (select count(*) from sqlite_schema where type = 'trigger') as triggers`,
    );
    return { reserved: shape?.reserved ?? "", triggers: shape?.triggers ?? 0 };
  }

  /**
   * Spike only: which statements workerd's own authorizer refuses when nothing in front of it
   * checks them, run straight through the storage API.
   */
  platformRefusals(_ref: ArtifactRef): Record<string, "allowed" | "refused"> {
    const probes: Record<string, string> = {
      begin: "begin transaction",
      savepoint: "savepoint a",
      attach: "attach database ':memory:' as other",
      pragmaWritableSchema: "pragma writable_schema = 1",
      cfTable: "select * from __cf_kv",
      loadExtension: "select load_extension('x')",
      vacuum: "vacuum",
      explain: "explain select 1",
      sqliteSchemaRead: "select count(*) from sqlite_schema",
      pragmaTableInfo: "pragma table_info(pf_documents)",
    };
    const result: Record<string, "allowed" | "refused"> = {};
    for (const [name, statement] of Object.entries(probes)) {
      try {
        this.ctx.storage.sql.exec(statement).toArray();
        result[name] = "allowed";
      } catch {
        result[name] = "refused";
      }
    }
    return result;
  }

  /** Spike only: fills a collection quickly, to time queries at the largest proposed cap. */
  seedForMeasure(ref: ArtifactRef, collection: string, count: number, now: number): number {
    this.ctx.storage.transactionSync(() => {
      this.#ensureSchema(ref);
      for (let index = 0; index < count; index++) {
        this.#all(
          `insert into pf_documents (collection, id, author, created, updated, seq, body, size)
           values (?, ?, ?, ?, ?, ?, ?, 40)`,
          collection,
          newId(),
          `v_${index % 500}`,
          now + index,
          now + index,
          index,
          JSON.stringify({ index, text: "seeded" }),
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

  /** The database's size in bytes, for the reconciliation into the owner's storage usage. */
  size(): number {
    return this.ctx.storage.sql.databaseSize;
  }

  /** Erases one author's documents (an account deletion or a data subject request). */
  eraseAuthor(author: string): Outcome<number> {
    return this.#run(() => {
      if (!this.#hasSchema()) return 0;
      return this.ctx.storage.transactionSync(() => {
        const gone = this.#all<{ collection: string; size: number }>(
          "delete from pf_documents where author = ? returning collection, size",
          author,
        );
        for (const row of gone) {
          this.#all(
            "update pf_collections set documents = documents - 1, bytes = bytes - ? where name = ?",
            row.size,
            row.collection,
          );
        }
        this.#all("delete from pf_rate where author = ?", author);
        return gone.length;
      });
    });
  }

  /** Erases everything: the purge's outbox job. Idempotent: an empty object stays empty. */
  async erase(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) socket.close(4404, "gone");
    await this.ctx.storage.deleteAll();
    this.#schemaReady = false;
    this.#verified = null;
  }

  /** Closes every live connection, so each reconnects through the Worker's authorization. */
  closeConnections(code: number): number {
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) socket.close(code, "reconnect");
    return sockets.length;
  }

  /** The live channel and the cross-Worker probe used by the spike. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/peek") {
      const page = this.query(
        { artifactId: url.searchParams.get("artifact") ?? "", region: "default" },
        { kind: "owner" },
        { collection: url.searchParams.get("collection") ?? "" },
      );
      return Response.json(page);
    }
    if (url.pathname !== "/live" || request.headers.get("Upgrade") !== "websocket") {
      return new Response(null, { status: 404 });
    }
    // Set by the Worker after authorization; the page's own headers never reach the object.
    const caller = JSON.parse(request.headers.get("X-Portifact-Caller") ?? "null") as {
      author: string | null;
      limits: DataLimits;
    };
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
    server.serializeAttachment({ author: caller.author, subscriptions: [] } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** `{"subscribe": "<collection>"}`: only collections the connection may read. */
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = socket.deserializeAttachment() as Attachment;
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
      if (readScope(target.mode, caller) === "none") {
        throw new DataError("not_found", "no such collection");
      }
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
      socket.send(JSON.stringify({ error: error.code }));
      return;
    }
    const subscriptions = [...new Set([...attachment.subscriptions, String(name)])].slice(0, 50);
    socket.serializeAttachment({ ...attachment, subscriptions } satisfies Attachment);
    socket.send(JSON.stringify({ subscribed: name }));
  }

  #broadcast(collection: string, kind: "created" | "updated", document: StoredDocument): void {
    this.#notify(collection, document._by, {
      collection,
      kind,
      id: document._id,
      seq: document._seq,
      document,
    });
  }

  /**
   * Sends a change to the connections allowed to see it. In `own` mode only the author's own
   * connections are even looked at (by tag), so another visitor's socket is never a candidate.
   */
  #notify(collection: string, author: string, message: ChangeMessage): void {
    const { mode } = this.#collection(collection);
    const candidates =
      mode === "own" ? this.ctx.getWebSockets(`author:${author}`) : this.ctx.getWebSockets();
    const text = JSON.stringify(message);
    for (const socket of candidates) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.subscriptions.includes(collection)) socket.send(text);
    }
  }
}
