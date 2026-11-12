// The owner side's SQL sandbox for one artifact (decision 0026, "Owner SQL"): a second SQLite-
// backed Durable Object that never holds live documents, only the owner's tables and copies the
// owner side asked for. In production it lives in its own Worker with its own CPU limit.
//
// Its control state (the control record, budgets, leases, the in-flight marker, audit
// obligations) is in the object's key-value store, which SQL cannot reach. Payload state (the
// owner's tables, replay records, copy receipts, the revision) goes with each generation.
import { DurableObject } from "cloudflare:workers";
import {
  actorOf,
  type CallContext,
  type Cost,
  LEASE_CHUNK,
  type StorageReport,
} from "./documents.ts";
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
import { DataError, type DataErrorCode } from "./model.ts";
import {
  checkInsertSources,
  checkProgram,
  classify,
  type ExplainRow,
  MAX_INDEXES,
  type Shape,
  words,
} from "./sql-guard.ts";
import {
  type EncodedResult,
  type ExportValue,
  encodeRows,
  exportExpression,
  exportValue,
} from "./wire.ts";

export type SqlOutcome<T> =
  | { ok: true; value: T; cost: Cost; storage: StorageReport }
  | {
      ok: true;
      replayed: { kind: string; rowsWritten: number };
      cost: Cost;
      storage: StorageReport;
    }
  | { ok: false; error: DataErrorCode; message: string; cost: Cost; storage: StorageReport };

/** Owner statements per artifact per minute (a constant safety cap). */
export const STATEMENTS_PER_MINUTE = 30;
/** Rows a statement is charged before it runs; what it does above that is charged after. */
const ESTIMATE = { read: 1_000, written: 100 } as const;
/** Bounds of one copy page, checked inside the sandbox (finding 11). */
export const COPY_PAGE = { rows: 500, bytes: 1024 * 1024 } as const;
const REPLAY_MS = 86_400_000;

interface DayCounters {
  read: number;
  written: number;
  cleanup: number;
  export: number;
}

interface Lease {
  owner: string;
  ownerEpoch: number;
  day: number;
  granted: number;
  used: number;
}

interface OpRecord {
  hash: string;
  state: "committed" | "aborted";
  kind: string;
  rowsWritten: number;
  at: number;
}

export interface CopyJob {
  copyId: string;
  page: number;
  table: string;
  collection: string;
  sourceGeneration: number;
  sourceRevision: number;
}

export interface CopyRecord {
  copyId: string;
  table: string;
  collection: string;
  sourceGeneration: number;
  sourceRevision: number;
  pages: number;
  documents: number;
}

const ROLLBACK = Symbol("read-only rollback");
/** Keys of one generation's payload; everything else in the store is control. */
const PAYLOAD_PREFIXES = ["op:", "copy:", "receipt:", "revision"];

function day(now: number): number {
  return Math.floor(now / 86_400_000);
}

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function quoted(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name))
    throw new DataError("invalid_input", "invalid table name");
  return `"${name}"`;
}

export class ArtifactSandbox extends DurableObject<Env> {
  #kv<T>(key: string): T | undefined {
    return this.ctx.storage.kv.get<T>(key);
  }

  #put<T>(key: string, value: T): void {
    this.ctx.storage.kv.put(key, value);
  }

  #control(): Control | null {
    return this.#kv<Control>("control") ?? null;
  }

  #touch(): void {
    const control = this.#control();
    if (control !== null)
      this.#put<Control>("control", { ...control, storageSeq: control.storageSeq + 1 });
  }

  #storage(): StorageReport {
    const control = this.#control();
    return {
      generation: control?.generation ?? 0,
      seq: control?.storageSeq ?? 0,
      bytes: this.ctx.storage.sql.databaseSize,
    };
  }

  #admit(envelope: Envelope, mode: AdmitMode, now: number): Control | null {
    const stored = this.#control();
    const verdict = admit(stored, envelope, mode);
    if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
    if ("done" in verdict) return null;
    if (stored === null) {
      if (mode.kind !== "request" || !mode.create) return null;
      const control = newControl(envelope, "open", now);
      this.#put("control", control);
      return control;
    }
    if (verdict.adopt) {
      const adopted = { ...stored, epoch: envelope.epoch };
      this.#put("control", adopted);
      return adopted;
    }
    return stored;
  }

  #fail(error: unknown, cost: Cost): SqlOutcome<never> {
    if (error instanceof DataError)
      return {
        ok: false,
        error: error.code,
        message: error.message,
        cost,
        storage: this.#storage(),
      };
    if (error instanceof Error) {
      return {
        ok: false,
        error: "invalid_input",
        message: "the statement failed",
        cost,
        storage: this.#storage(),
      };
    }
    throw error;
  }

  /** Leases owner allowance from the SQL pools, bound to the owner and its epoch (finding 12). */
  async #lease(context: CallContext, pool: Pool, need: number): Promise<void> {
    const control = this.#control();
    if (control === null) return;
    const today = day(context.now);
    const stored = this.#kv<Lease>(`lease:${pool}`);
    const current =
      stored !== undefined &&
      stored.owner === control.ownerId &&
      stored.ownerEpoch === control.ownerEpoch &&
      stored.day === today
        ? stored
        : undefined;
    if (current !== undefined && current.granted - current.used >= need) return;
    const limit = context.owner.allowances[pool];
    const chunk = pool.endsWith("_read") ? LEASE_CHUNK.read : LEASE_CHUNK.written;
    const deficit = Math.max(0, (current?.used ?? 0) - (current?.granted ?? 0));
    const want = deficit + Math.max(need, Math.min(Math.ceil(limit * LEASE_CHUNK.share), chunk));
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName(context.owner.id));
    const granted = await ledger.lease(pool, today, want, limit);
    // Read again after the await, so concurrent top-ups add up instead of overwriting.
    this.ctx.storage.transactionSync(() => {
      const now = this.#kv<Lease>(`lease:${pool}`);
      const same =
        now !== undefined &&
        now.owner === control.ownerId &&
        now.ownerEpoch === control.ownerEpoch &&
        now.day === today;
      this.#put<Lease>(`lease:${pool}`, {
        owner: control.ownerId,
        ownerEpoch: control.ownerEpoch,
        day: today,
        granted: (same ? now.granted : 0) + granted,
        used: same ? now.used : 0,
      });
    });
  }

  /** Spends from a lease; returns how far past the lease the spend went (owed to the ledger). */
  #spendLease(pool: Pool, amount: number): number {
    const lease = this.#kv<Lease>(`lease:${pool}`);
    if (lease === undefined) return amount;
    const used = lease.used + amount;
    this.#put<Lease>(`lease:${pool}`, { ...lease, used });
    // Only the part of this spend past the lease is new debt.
    return Math.max(0, used - lease.granted) - Math.max(0, lease.used - lease.granted);
  }

  #day(now: number): DayCounters {
    return (
      this.#kv<DayCounters>(`day:${day(now)}`) ?? { read: 0, written: 0, cleanup: 0, export: 0 }
    );
  }

  /**
   * A statement the platform stopped never reported its work. Its in-flight marker remains; the
   * next statement charges the plan's worst case for it as debt, before anything else runs.
   */
  async #settleAbandoned(context: CallContext): Promise<void> {
    const marker = this.#kv<{ at: number }>("inflight");
    if (marker === undefined) return;
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName(context.owner.id));
    const today = day(context.now);
    await ledger.settle(
      "sql_read",
      today,
      context.limits.sqlWorstRowsRead,
      context.owner.allowances.sql_read,
    );
    await ledger.settle(
      "sql_written",
      today,
      context.limits.sqlWorstRowsWritten,
      context.owner.allowances.sql_written,
    );
    this.ctx.storage.transactionSync(() => {
      const counters = this.#day(context.now);
      this.#put(`day:${today}`, {
        ...counters,
        read: counters.read + context.limits.sqlWorstRowsRead,
        written: counters.written + context.limits.sqlWorstRowsWritten,
      });
      this.ctx.storage.kv.delete("inflight");
      // What the artifact still held of its leases is given up: from now on every statement asks
      // the ledger, which grants nothing while the debt lasts.
      this.ctx.storage.kv.delete("lease:sql_read");
      this.ctx.storage.kv.delete("lease:sql_written");
    });
  }

  /**
   * Charges before the statement runs, in its own committed transaction: the statement rate, the
   * artifact's SQL day (or its cleanup allowance for deletes and drops, finding 10) and the
   * owner's leased SQL rows; then sets the in-flight marker.
   */
  #charge(context: CallContext, cleanup: boolean): void {
    const refusal = this.ctx.storage.transactionSync(() => {
      this.#touch();
      const minuteKey = `rate:${Math.floor(context.now / 60_000)}`;
      const statements = (this.#kv<number>(minuteKey) ?? 0) + 1;
      this.#put(minuteKey, statements);
      if (statements > STATEMENTS_PER_MINUTE) {
        return {
          code: "rate_limited" as const,
          message: "too many statements, try again in a minute",
        };
      }
      const counters = this.#day(context.now);
      if (cleanup) {
        const next = { ...counters, cleanup: counters.cleanup + ESTIMATE.read + ESTIMATE.written };
        this.#put(`day:${day(context.now)}`, next);
        if (next.cleanup > context.limits.cleanupRowsPerDay) {
          return { code: "rate_limited" as const, message: "the day's cleanup allowance is spent" };
        }
      } else {
        const next = {
          ...counters,
          read: counters.read + ESTIMATE.read,
          written: counters.written + ESTIMATE.written,
        };
        this.#put(`day:${day(context.now)}`, next);
        if (
          next.read > context.limits.sqlRowsReadPerDay ||
          next.written > context.limits.sqlRowsWrittenPerDay
        ) {
          return {
            code: "quota_exceeded" as const,
            message: "this artifact's SQL budget for today is spent",
          };
        }
        const overRead = this.#spendLease("sql_read", ESTIMATE.read);
        const overWritten = this.#spendLease("sql_written", ESTIMATE.written);
        if (overRead > 0 || overWritten > 0) {
          return {
            code: "quota_exceeded" as const,
            message: "the owner's SQL budget is spent or in debt",
          };
        }
      }
      this.#put("inflight", { at: context.now });
      return null;
    });
    if (refusal !== null) throw new DataError(refusal.code, refusal.message);
  }

  /**
   * Charges what the statement actually did above its estimate, failed or not (finding 7), and
   * clears the in-flight marker. Spend past the lease goes to the ledger as debt.
   */
  async #trueUp(context: CallContext, cost: Cost, cleanup: boolean): Promise<void> {
    const read = Math.max(0, cost.rowsRead - ESTIMATE.read);
    const written = Math.max(0, cost.rowsWritten - ESTIMATE.written);
    const owed = this.ctx.storage.transactionSync(() => {
      const counters = this.#day(context.now);
      if (cleanup) {
        this.#put(`day:${day(context.now)}`, {
          ...counters,
          cleanup: counters.cleanup + read + written,
        });
        this.ctx.storage.kv.delete("inflight");
        return { read: 0, written: 0 };
      }
      this.#put(`day:${day(context.now)}`, {
        ...counters,
        read: counters.read + read,
        written: counters.written + written,
      });
      const owedRead = this.#spendLease("sql_read", read);
      const owedWritten = this.#spendLease("sql_written", written);
      this.ctx.storage.kv.delete("inflight");
      return { read: owedRead, written: owedWritten };
    });
    if (owed.read === 0 && owed.written === 0) return;
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName(context.owner.id));
    const today = day(context.now);
    if (owed.read > 0)
      await ledger.settle("sql_read", today, owed.read, context.owner.allowances.sql_read);
    if (owed.written > 0)
      await ledger.settle("sql_written", today, owed.written, context.owner.allowances.sql_written);
    // The ledger now holds what was owed (as debt): the lease covers it, so it is never leased twice.
    this.ctx.storage.transactionSync(() => {
      for (const [pool, amount] of [
        ["sql_read", owed.read],
        ["sql_written", owed.written],
      ] as const) {
        const lease = this.#kv<Lease>(`lease:${pool}`);
        if (lease !== undefined && amount > 0)
          this.#put<Lease>(`lease:${pool}`, { ...lease, granted: lease.granted + amount });
      }
    });
  }

  #program(statement: string, params: unknown[]): ExplainRow[] {
    return this.ctx.storage.sql
      .exec<{ opcode: string; p1: number; p2: number }>(`explain ${statement}`, ...params)
      .toArray();
  }

  #tableRoots(): Set<number> {
    return new Set(
      this.ctx.storage.sql
        .exec<{ rootpage: number }>(
          "select rootpage from sqlite_schema where type = 'table' and rootpage > 0",
        )
        .toArray()
        .map((row) => row.rootpage),
    );
  }

  /** No trigger, virtual table or more than MAX_INDEXES indexes may exist after a write. */
  #checkSchema(): void {
    const [shape] = this.ctx.storage.sql
      .exec<{ bad: number; indexes: number }>(
        `select
           (select count(*) from sqlite_schema where type = 'trigger' or sql like 'create virtual%' collate nocase) as bad,
           (select count(*) from sqlite_schema where type = 'index' and sql is not null) as indexes`,
      )
      .toArray();
    if ((shape?.bad ?? 0) > 0)
      throw new DataError("forbidden", "this kind of object is not supported");
    if ((shape?.indexes ?? 0) > MAX_INDEXES)
      throw new DataError("quota_exceeded", `at most ${MAX_INDEXES} indexes`);
  }

  /** Runs a read in a transaction that is always rolled back; refused if any row was written. */
  #readOnly(statement: string, params: unknown[]): { result: EncodedResult; cost: Cost } {
    let result: EncodedResult | null = null;
    let cost: Cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      this.ctx.storage.transactionSync(() => {
        const cursor = this.ctx.storage.sql.exec(statement, ...params);
        try {
          result = encodeRows(cursor.columnNames, cursor.raw());
        } finally {
          cost = { rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
        }
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw Object.assign(error as object, { cost });
    }
    if (cost.rowsWritten > 0)
      throw Object.assign(new DataError("forbidden", "this call only reads"), { cost });
    return { result: result as unknown as EncodedResult, cost };
  }

  #opKey(envelope: Envelope, context: CallContext): string | null {
    return envelope.opId === undefined
      ? null
      : `${actorOf(context.caller)}|${envelope.generation}|${envelope.opId}`;
  }

  async #statement(
    envelope: Envelope,
    context: CallContext,
    statement: string,
    params: (string | number | null)[],
    shape: Shape,
  ): Promise<SqlOutcome<EncodedResult>> {
    let cost: Cost = { rowsRead: 0, rowsWritten: 0 };
    let charged = false;
    let cleanup = false;
    try {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      const classified = classify(statement, params);
      if (!classified.ok) throw new DataError("invalid_input", classified.reason);
      if (classified.shape !== shape) {
        throw new DataError(
          shape === "read" ? "forbidden" : "invalid_input",
          shape === "read" ? "this call only reads" : "use the read call for SELECT",
        );
      }
      const lexed = words(statement);
      const first = "words" in lexed ? lexed.words[0] : undefined;
      cleanup = shape === "write" && (first === "DELETE" || first === "DROP");
      const key = this.#opKey(envelope, context);
      const requestHash = await hash([shape, statement, params]);
      const replay = this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: true }, context.now);
        if (key === null) return null;
        const prior = this.#kv<OpRecord>(`op:${key}`);
        if (prior === undefined) return null;
        if (prior.state === "aborted")
          throw new DataError("conflict", "this operation was abandoned");
        if (prior.hash !== requestHash)
          throw new DataError("conflict", "this operation ID was used for another request");
        return prior;
      });
      if (replay !== null) {
        return {
          ok: true,
          replayed: { kind: replay.kind, rowsWritten: replay.rowsWritten },
          cost,
          storage: this.#storage(),
        };
      }
      await this.#settleAbandoned(context);
      if (!cleanup) {
        await this.#lease(context, "sql_read", ESTIMATE.read);
        await this.#lease(context, "sql_written", ESTIMATE.written);
      }
      this.#charge(context, cleanup);
      charged = true;
      const program = this.#program(statement, params);
      const decided = checkProgram(program, shape);
      if (!decided.ok) throw new DataError("forbidden", decided.reason);
      const sources = checkInsertSources(program, this.#tableRoots(), first === "INSERT");
      if (!sources.ok) throw new DataError("forbidden", sources.reason);
      let result: EncodedResult;
      if (shape === "read") {
        try {
          ({ result, cost } = this.#readOnly(statement, params));
        } catch (error) {
          cost = (error as { cost?: Cost }).cost ?? cost;
          throw error;
        }
      } else {
        result = this.ctx.storage.transactionSync(() => {
          const before = this.ctx.storage.sql.databaseSize;
          const cursor = this.ctx.storage.sql.exec(statement, ...params);
          let encoded: EncodedResult;
          try {
            encoded = encodeRows(cursor.columnNames, cursor.raw());
          } finally {
            cost = { rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
          }
          this.#checkSchema();
          const after = this.ctx.storage.sql.databaseSize;
          if (after > context.limits.sandboxBytes && after > before) {
            throw new DataError("quota_exceeded", "this artifact's SQL storage is full");
          }
          this.#put("revision", (this.#kv<number>("revision") ?? 0) + 1);
          if (key !== null) {
            this.#put<OpRecord>(`op:${key}`, {
              hash: requestHash,
              state: "committed",
              kind: "sql",
              rowsWritten: cost.rowsWritten,
              at: context.now,
            });
          }
          if (envelope.opId !== undefined) {
            this.#put(`audit:${envelope.opId}`, {
              kind: "data.sql_executed",
              detail: JSON.stringify({ rows: cost.rowsWritten }),
            });
          }
          return encoded;
        });
      }
      await this.#trueUp(context, cost, cleanup);
      return { ok: true, value: result, cost, storage: this.#storage() };
    } catch (error) {
      if (charged) await this.#trueUp(context, cost, cleanup);
      return this.#fail(error, cost);
    }
  }

  query(
    envelope: Envelope,
    context: CallContext,
    statement: string,
    params: (string | number | null)[] = [],
  ) {
    return this.#statement(envelope, context, statement, params, "read");
  }

  execute(
    envelope: Envelope,
    context: CallContext,
    statement: string,
    params: (string | number | null)[] = [],
  ) {
    return this.#statement(envelope, context, statement, params, "write");
  }

  /** Spike only: a statement the platform stopped after the marker was set (finding 7). */
  async abandonStatement(envelope: Envelope, context: CallContext): Promise<void> {
    this.#admit(envelope, { kind: "request", create: true }, context.now);
    await this.#settleAbandoned(context);
    await this.#lease(context, "sql_read", ESTIMATE.read);
    await this.#lease(context, "sql_written", ESTIMATE.written);
    this.#charge(context, false);
  }

  /**
   * One page of a copy job (finding 11): at most COPY_PAGE rows and bytes, checked here; a page
   * already received is acknowledged again without writing; the work is measured and charged
   * like a statement; the job records its source generation and revision.
   */
  async importCopy(
    envelope: Envelope,
    context: CallContext,
    job: CopyJob,
    rows: {
      id: string;
      by: string;
      editedBy: string | null;
      created: number;
      updated: number;
      body: string;
    }[],
  ): Promise<SqlOutcome<{ inserted: number }>> {
    let cost: Cost = { rowsRead: 0, rowsWritten: 0 };
    let charged = false;
    try {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      if (!/^copy_[a-z][a-z0-9_]{0,40}$/.test(job.table))
        throw new DataError("invalid_input", "copy tables are named copy_<name>");
      if (rows.length > COPY_PAGE.rows)
        throw new DataError("invalid_input", `a copy page holds at most ${COPY_PAGE.rows} rows`);
      const bytes = new TextEncoder().encode(JSON.stringify(rows)).length;
      if (bytes > COPY_PAGE.bytes)
        throw new DataError("invalid_input", "a copy page holds at most 1 MiB");
      const receipt = this.ctx.storage.transactionSync(() => {
        this.#admit(envelope, { kind: "request", create: true }, context.now);
        return this.#kv<{ rows: number }>(`receipt:${job.copyId}:${job.page}`);
      });
      if (receipt !== undefined) {
        return {
          ok: true,
          replayed: { kind: "copy_page", rowsWritten: receipt.rows },
          cost,
          storage: this.#storage(),
        };
      }
      await this.#settleAbandoned(context);
      await this.#lease(context, "sql_read", ESTIMATE.read);
      await this.#lease(context, "sql_written", ESTIMATE.written);
      this.#charge(context, false);
      charged = true;
      const inserted = this.ctx.storage.transactionSync(() => {
        const before = this.ctx.storage.sql.databaseSize;
        this.ctx.storage.sql.exec(
          `create table if not exists ${job.table} (_id text primary key, _by text not null,
             _edited_by text, _created integer not null, _updated integer not null, body text not null)`,
        );
        for (const row of rows) {
          const cursor = this.ctx.storage.sql.exec(
            `insert into ${job.table} values (?, ?, ?, ?, ?, ?) on conflict (_id) do update set
               _edited_by = excluded._edited_by, _updated = excluded._updated, body = excluded.body`,
            row.id,
            row.by,
            row.editedBy,
            row.created,
            row.updated,
            row.body,
          );
          cursor.toArray();
          cost = {
            rowsRead: cost.rowsRead + cursor.rowsRead,
            rowsWritten: cost.rowsWritten + cursor.rowsWritten,
          };
        }
        const after = this.ctx.storage.sql.databaseSize;
        if (after > context.limits.sandboxBytes && after > before) {
          throw new DataError("quota_exceeded", "this artifact's SQL storage is full");
        }
        const record = this.#kv<CopyRecord>(`copy:${job.copyId}`) ?? {
          copyId: job.copyId,
          table: job.table,
          collection: job.collection,
          sourceGeneration: job.sourceGeneration,
          sourceRevision: job.sourceRevision,
          pages: 0,
          documents: 0,
        };
        this.#put<CopyRecord>(`copy:${job.copyId}`, { ...record, pages: record.pages + 1 });
        this.#put(`receipt:${job.copyId}:${job.page}`, { rows: rows.length });
        this.#put("revision", (this.#kv<number>("revision") ?? 0) + 1);
        if (envelope.opId !== undefined) {
          this.#put(`audit:${envelope.opId}`, {
            kind: "data.copied",
            detail: JSON.stringify({ rows: rows.length }),
          });
        }
        return rows.length;
      });
      await this.#trueUp(context, cost, false);
      return { ok: true, value: { inserted }, cost, storage: this.#storage() };
    } catch (error) {
      if (charged) await this.#trueUp(context, cost, false);
      return this.#fail(error, cost);
    }
  }

  /** The copies, with their documents counted from the table now (right after retries and owner edits). */
  copies(): CopyRecord[] {
    const records = [...this.ctx.storage.kv.list<CopyRecord>({ prefix: "copy:" })].map(
      ([, record]) => record,
    );
    return records.map((record) => {
      const exists =
        this.ctx.storage.sql
          .exec("select 1 from sqlite_schema where name = ?", record.table)
          .toArray().length > 0;
      const documents = exists
        ? (this.ctx.storage.sql
            .exec<{ n: number }>(`select count(*) as n from ${quoted(record.table)}`)
            .one().n ?? 0)
        : 0;
      return { ...record, documents };
    });
  }

  /**
   * A lossless export page of one table (finding 9): a statement the server builds from the
   * table's own columns returns each value's type and exact text, in rowid order after `after`.
   * The page carries the payload revision, so a reader can tell whether the whole was consistent.
   */
  exportTable(
    envelope: Envelope,
    context: CallContext,
    table: string,
    after: number,
    limit: number,
  ): SqlOutcome<{
    columns: string[];
    rows: { rowid: number; values: ExportValue[] }[];
    next: number | null;
    revision: number;
  }> {
    const cost: Cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      if (context.caller.kind !== "owner") throw new DataError("forbidden", "owner side only");
      this.#admit(envelope, { kind: "request", create: false }, context.now);
      const name = quoted(table);
      const columns = this.ctx.storage.sql
        .exec<{ name: string }>(`pragma table_info(${name})`)
        .toArray()
        .map((row) => row.name);
      if (columns.length === 0) throw new DataError("not_found", "no such table");
      const take = Math.min(Math.max(limit, 1), 500);
      const counters = this.#day(context.now);
      const next = { ...counters, export: counters.export + take };
      this.#put(`day:${day(context.now)}`, next);
      if (next.export > context.limits.exportRowsPerDay)
        throw new DataError("rate_limited", "the day's export allowance is spent");
      const expressions = columns
        .map((column) => exportExpression(`"${column.replaceAll('"', '""')}"`))
        .join(", ");
      const cursor = this.ctx.storage.sql.exec(
        `select rowid, ${expressions} from ${name} where rowid > ? order by rowid limit ?`,
        after,
        take + 1,
      );
      const raw = [...cursor.raw()];
      const rows = raw.slice(0, take).map((row) => {
        const values: ExportValue[] = [];
        for (let index = 0; index < columns.length; index++)
          values.push(exportValue(row[1 + index * 2], row[2 + index * 2]));
        return { rowid: Number(row[0]), values };
      });
      return {
        ok: true,
        value: {
          columns,
          rows,
          next: raw.length > take ? (rows.at(-1)?.rowid ?? null) : null,
          revision: this.#kv<number>("revision") ?? 0,
        },
        cost: { rowsRead: cursor.rowsRead, rowsWritten: 0 },
        storage: this.#storage(),
      };
    } catch (error) {
      return this.#fail(error, cost);
    }
  }

  auditFor(opId: string): { kind: string; detail: string } | null {
    return this.#kv<{ kind: string; detail: string }>(`audit:${opId}`) ?? null;
  }

  /** The relay's question: a committed obligation, or the operation marked aborted now. */
  settle(
    envelope: Envelope,
    actor: string,
    opId: string,
  ): { state: "committed"; kind: string } | { state: "aborted" } {
    return this.ctx.storage.transactionSync(() => {
      const obligation = this.#kv<{ kind: string }>(`audit:${opId}`);
      if (obligation !== undefined) return { state: "committed" as const, kind: obligation.kind };
      const key = `op:${actor}|${envelope.generation}|${opId}`;
      if (this.#kv(key) === undefined) {
        this.#put<OpRecord>(key, {
          hash: "",
          state: "aborted",
          kind: "aborted",
          rowsWritten: 0,
          at: Date.now(),
        });
      }
      return { state: "aborted" as const };
    });
  }

  budget(now: number): { rowsRead: number; rowsWritten: number; cleanup: number } {
    const counters = this.#day(now);
    return { rowsRead: counters.read, rowsWritten: counters.written, cleanup: counters.cleanup };
  }

  size(): StorageReport {
    return this.#storage();
  }

  controlRecord(): Control | null {
    return this.#control();
  }

  /** Prunes replay records older than a day, at most 500 per call. */
  pruneReplays(now: number): number {
    let pruned = 0;
    for (const [key, record] of this.ctx.storage.kv.list<OpRecord>({ prefix: "op:", limit: 500 })) {
      if (record.at < now - REPLAY_MS) {
        this.ctx.storage.kv.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }

  readOnlyProbe(statement: string): { refused: boolean; message: string } {
    try {
      this.#readOnly(statement, []);
      return { refused: false, message: "" };
    } catch (error) {
      return { refused: true, message: error instanceof Error ? error.message : String(error) };
    }
  }

  opcodes(statement: string): string[] {
    return [...new Set(this.#program(statement, []).map((row) => row.opcode))];
  }

  unsafeExec(statement: string): void {
    this.ctx.storage.sql.exec(statement);
  }

  /** The barrier, persisted before it is acknowledged, on an empty object too (finding 2). */
  fence(envelope: Envelope, change: FenceChange): boolean {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#control();
      const applied = applyFence(stored, envelope, change, Date.now());
      if (!applied.ok) return false;
      this.#put("control", applied.control);
      if (stored !== null && applied.control.ownerId !== stored.ownerId) {
        for (const [key] of this.ctx.storage.kv.list({ prefix: "lease:" }))
          this.ctx.storage.kv.delete(key);
      }
      return true;
    });
  }

  quarantine(envelope: Envelope): boolean {
    const stored = this.#control();
    if (
      stored === null ||
      stored.artifactId !== envelope.artifactId ||
      stored.region !== envelope.region
    )
      return false;
    this.#put<Control>("control", {
      ...stored,
      state: "quarantined",
      storageSeq: stored.storageSeq + 1,
    });
    return true;
  }

  /** Erase, step one, through the shared validator; adopts the epoch it accepts. */
  prepareErase(envelope: Envelope): { ok: true; prepared: boolean } | { ok: false; error: string } {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#control();
      const verdict = admit(stored, envelope, { kind: "erase" });
      if (!verdict.ok) return { ok: false as const, error: verdict.error };
      if ("done" in verdict || stored === null) return { ok: true as const, prepared: false };
      this.#put<Control>("control", {
        ...stored,
        epoch: envelope.epoch,
        state: "erasing",
        storageSeq: stored.storageSeq + 1,
      });
      return { ok: true as const, prepared: true };
    });
  }

  /**
   * Erase, step two: in one transaction, drops every owner object and deletes the payload keys,
   * and writes the next generation into the control record, which survives with budgets,
   * leases and audit obligations (finding 3). A retry finds the next generation.
   */
  commitErase(envelope: Envelope): { ok: true; erased: boolean } | { ok: false; error: string } {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#control();
      const verdict = admit(stored, envelope, { kind: "erase" });
      if (!verdict.ok) return { ok: false as const, error: verdict.error };
      if (
        "done" in verdict ||
        stored === null ||
        stored.state !== "erasing" ||
        stored.epoch !== envelope.epoch
      ) {
        return { ok: true as const, erased: false };
      }
      const objects = this.ctx.storage.sql
        .exec<{ type: string; name: string }>(
          "select type, name from sqlite_schema where type in ('view', 'table') and name not like 'sqlite\\_%' escape '\\' and name not like '\\_cf\\_%' escape '\\' order by type = 'table'",
        )
        .toArray();
      for (const object of objects)
        this.ctx.storage.sql.exec(`drop ${object.type} if exists ${quoted(object.name)}`);
      for (const prefix of PAYLOAD_PREFIXES) {
        for (const [key] of this.ctx.storage.kv.list({ prefix })) this.ctx.storage.kv.delete(key);
      }
      this.#put<Control>("control", {
        ...stored,
        generation: stored.generation + 1,
        state: "open",
        storageSeq: stored.storageSeq + 1,
      });
      return { ok: true as const, erased: true };
    });
  }

  cancelErase(envelope: Envelope): boolean {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.#control();
      const verdict = admit(stored, envelope, { kind: "erase" });
      if (!verdict.ok || "done" in verdict || stored === null || stored.state !== "erasing")
        return false;
      this.#put<Control>("control", {
        ...stored,
        state: "open",
        storageSeq: stored.storageSeq + 1,
      });
      return true;
    });
  }
}
