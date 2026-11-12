// The owner side's SQL sandbox for one artifact (decision 0026, "Owner SQL"): a second SQLite-
// backed Durable Object, separate from the documents. It holds only tables the owner creates and
// copies of collections the owner side asked for; it never sees the live documents, so no owner
// statement can read, block or rewrite what visitors wrote. In production it lives in its own
// Worker with its own CPU limit, so an expensive statement holds only sandboxes.
//
// Its control state (fence, budgets, the copies it holds) is in the object's key-value store,
// which SQL cannot read or reference, so the sandbox has no reserved SQL objects to protect.
import { DurableObject } from "cloudflare:workers";
import { type CallContext, type Cost, LEASE_CHUNK } from "./documents.ts";
import { checkFence, type Envelope, type Fence } from "./envelope.ts";
import { DataError, type DataErrorCode } from "./model.ts";
import { checkProgram, classify, type ExplainRow, type Shape } from "./sql-guard.ts";
import { type EncodedResult, encodeRows } from "./wire.ts";

export type SqlOutcome<T> =
  | { ok: true; value: T; cost: Cost; size: number }
  | { ok: false; error: DataErrorCode; message: string; cost: Cost };

/** Owner statements per artifact per minute (a constant safety cap). */
export const STATEMENTS_PER_MINUTE = 30;
/** Rows a statement is charged before it runs; what it does above that is charged after. */
const ESTIMATE = { read: 1_000, written: 100 } as const;

export interface CopyRecord {
  table: string;
  collection: string;
  documents: number;
  at: number;
}

const ROLLBACK = Symbol("read-only rollback");

function day(now: number): number {
  return Math.floor(now / 86_400_000);
}

export class ArtifactSandbox extends DurableObject<Env> {
  #kv<T>(key: string): T | undefined {
    return this.ctx.storage.kv.get<T>(key);
  }

  #admit(envelope: Envelope, create: boolean): void {
    const stored = this.#kv<Fence>("fence") ?? null;
    const verdict = checkFence(stored, envelope);
    if (!verdict.ok) throw new DataError(verdict.error, verdict.message);
    if (stored === null) {
      if (!create) return;
      this.ctx.storage.kv.put<Fence>("fence", {
        artifactId: envelope.artifactId,
        region: envelope.region,
        generation: envelope.generation,
        epoch: envelope.epoch,
        state: "open",
      });
      return;
    }
    if (verdict.adopt)
      this.ctx.storage.kv.put<Fence>("fence", { ...stored, epoch: envelope.epoch });
  }

  /** Adds to a durable counter and says whether it is past `limit`. */
  #count(key: string, amount: number, limit: number): boolean {
    const used = (this.#kv<number>(key) ?? 0) + amount;
    this.ctx.storage.kv.put(key, used);
    return used > limit;
  }

  /**
   * Charges a statement before it runs, committed even when refused: the statement rate, the
   * artifact's daily rows and the owner's leased rows (the same ledger the documents use).
   */
  async #charge(context: CallContext): Promise<void> {
    const today = day(context.now);
    const ledger = this.env.LEDGER.get(this.env.LEDGER.idFromName(context.owner.id));
    for (const [kind, need, limit] of [
      ["read", ESTIMATE.read, context.owner.rowsReadPerDay],
      ["written", ESTIMATE.written, context.owner.rowsWrittenPerDay],
    ] as const) {
      const key = `lease:${kind}:${today}`;
      const lease = this.#kv<{ granted: number; used: number }>(key) ?? { granted: 0, used: 0 };
      if (lease.granted - lease.used < need) {
        // A statement that did more than its estimate left the lease overdrawn: cover that too.
        const deficit = Math.max(0, lease.used - lease.granted);
        const want =
          deficit +
          Math.max(need, Math.min(Math.ceil(limit * LEASE_CHUNK.share), LEASE_CHUNK[kind]));
        const granted = await ledger.lease(today, kind, want, limit);
        this.ctx.storage.kv.put(key, { ...lease, granted: lease.granted + granted });
      }
    }
    const refused = this.ctx.storage.transactionSync(() => {
      if (this.#count(`statements:${Math.floor(context.now / 60_000)}`, 1, STATEMENTS_PER_MINUTE)) {
        return {
          code: "rate_limited" as const,
          message: "too many statements, try again in a minute",
        };
      }
      return this.#spend(context, ESTIMATE.read, ESTIMATE.written);
    });
    if (refused !== null) throw new DataError(refused.code, refused.message);
  }

  /** Spends rows against the artifact's day and the owner's lease; says what refused, if anything. */
  #spend(
    context: CallContext,
    read: number,
    written: number,
  ): { code: "quota_exceeded"; message: string } | null {
    const today = day(context.now);
    const overRead = this.#count(`rows_read:${today}`, read, context.limits.rowsReadPerDay);
    const overWritten = this.#count(
      `rows_written:${today}`,
      written,
      context.limits.rowsWrittenPerDay,
    );
    let overOwner = false;
    for (const [kind, amount] of [
      ["read", read],
      ["written", written],
    ] as const) {
      const key = `lease:${kind}:${today}`;
      const lease = this.#kv<{ granted: number; used: number }>(key) ?? { granted: 0, used: 0 };
      const next = { ...lease, used: lease.used + amount };
      this.ctx.storage.kv.put(key, next);
      if (next.used > next.granted) overOwner = true;
    }
    if (overRead || overWritten)
      return { code: "quota_exceeded", message: "this artifact's SQL budget for today is spent" };
    if (overOwner)
      return { code: "quota_exceeded", message: "the owner's data budget for today is spent" };
    return null;
  }

  #program(statement: string, params: unknown[]): ExplainRow[] {
    return this.ctx.storage.sql
      .exec<{ opcode: string }>(`explain ${statement}`, ...params)
      .toArray();
  }

  /** No trigger, virtual table or temporary object may exist after a statement. */
  #checkSchema(): void {
    const [bad] = this.ctx.storage.sql
      .exec<{ n: number }>(
        `select count(*) as n from sqlite_schema
         where type = 'trigger' or sql like 'create virtual%' collate nocase`,
      )
      .toArray();
    if ((bad?.n ?? 0) > 0) throw new DataError("forbidden", "this kind of object is not supported");
  }

  /**
   * Runs a read in a transaction that is always rolled back, so it can change nothing whatever
   * the classification said (finding 1), and refuses it if SQLite reports any row written.
   */
  #readOnly(statement: string, params: unknown[]): { result: EncodedResult; cost: Cost } {
    let result: EncodedResult | null = null;
    let cost: Cost = { rowsRead: 0, rowsWritten: 0 };
    try {
      this.ctx.storage.transactionSync(() => {
        const cursor = this.ctx.storage.sql.exec(statement, ...params);
        result = encodeRows(cursor.columnNames, cursor.raw());
        cost = { rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    }
    if (cost.rowsWritten > 0) throw new DataError("forbidden", "this call only reads");
    return { result: result as unknown as EncodedResult, cost };
  }

  async #statement(
    envelope: Envelope,
    context: CallContext,
    statement: string,
    params: (string | number | null)[],
    shape: Shape,
  ): Promise<SqlOutcome<EncodedResult>> {
    let cost: Cost = { rowsRead: 0, rowsWritten: 0 };
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
      await this.#charge(context);
      this.#admit(envelope, shape === "write");
      const decided = checkProgram(this.#program(statement, params), shape);
      if (!decided.ok) throw new DataError("forbidden", decided.reason);
      let result: EncodedResult;
      if (shape === "read") {
        ({ result, cost } = this.#readOnly(statement, params));
        this.ctx.storage.transactionSync(() =>
          this.#spend(
            context,
            Math.max(0, cost.rowsRead - ESTIMATE.read),
            Math.max(0, cost.rowsWritten - ESTIMATE.written),
          ),
        );
      } else {
        result = this.ctx.storage.transactionSync(() => {
          const before = this.ctx.storage.sql.databaseSize;
          const cursor = this.ctx.storage.sql.exec(statement, ...params);
          const encoded = encodeRows(cursor.columnNames, cursor.raw());
          cost = { rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
          this.#checkSchema();
          const after = this.ctx.storage.sql.databaseSize;
          // Over the plan's size, only statements that do not grow the database go through.
          if (after > context.limits.bytesPerArtifact && after > before) {
            throw new DataError("quota_exceeded", "this artifact's data is full");
          }
          this.#spend(
            context,
            Math.max(0, cost.rowsRead - ESTIMATE.read),
            Math.max(0, cost.rowsWritten - ESTIMATE.written),
          );
          if (envelope.opId !== undefined) {
            this.ctx.storage.kv.put(`audit:${envelope.opId}`, {
              kind: "data.sql_executed",
              rows: cost.rowsWritten,
            });
          }
          return encoded;
        });
      }
      return { ok: true, value: result, cost, size: this.ctx.storage.sql.databaseSize };
    } catch (error) {
      if (error instanceof DataError)
        return { ok: false, error: error.code, message: error.message, cost };
      if (error instanceof Error) {
        // SQLite's own refusals (syntax, constraints, workerd's authorizer) are input errors.
        return { ok: false, error: "invalid_input", message: "the statement failed", cost };
      }
      throw error;
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

  /**
   * Writes a page of copied documents into `table` (created on first use with fixed columns).
   * Only the owner side's copy job calls it, with rows the documents object exported; the
   * copy is listed so describe, export and erasure rules can name it.
   */
  async importCopy(
    envelope: Envelope,
    context: CallContext,
    table: string,
    collection: string,
    rows: {
      id: string;
      by: string;
      editedBy: string | null;
      created: number;
      updated: number;
      body: string;
    }[],
  ): Promise<SqlOutcome<{ inserted: number }>> {
    try {
      if (!/^copy_[a-z][a-z0-9_]{0,40}$/.test(table))
        throw new DataError("invalid_input", "copy tables are named copy_<name>");
      await this.#charge(context);
      this.#admit(envelope, true);
      const inserted = this.ctx.storage.transactionSync(() => {
        const before = this.ctx.storage.sql.databaseSize;
        this.ctx.storage.sql.exec(
          `create table if not exists ${table} (_id text primary key, _by text not null,
             _edited_by text, _created integer not null, _updated integer not null, body text not null)`,
        );
        for (const row of rows) {
          this.ctx.storage.sql.exec(
            `insert into ${table} values (?, ?, ?, ?, ?, ?) on conflict (_id) do update set
               _edited_by = excluded._edited_by, _updated = excluded._updated, body = excluded.body`,
            row.id,
            row.by,
            row.editedBy,
            row.created,
            row.updated,
            row.body,
          );
        }
        const after = this.ctx.storage.sql.databaseSize;
        if (after > context.limits.bytesPerArtifact && after > before) {
          throw new DataError("quota_exceeded", "this artifact's data is full");
        }
        this.#spend(context, 0, rows.length * 2);
        const copies = this.#kv<CopyRecord[]>("copies") ?? [];
        const others = copies.filter((copy) => copy.table !== table);
        const previous = copies.find((copy) => copy.table === table)?.documents ?? 0;
        this.ctx.storage.kv.put("copies", [
          ...others,
          { table, collection, documents: previous + rows.length, at: context.now },
        ]);
        return rows.length;
      });
      return {
        ok: true,
        value: { inserted },
        cost: { rowsRead: 0, rowsWritten: inserted },
        size: this.ctx.storage.sql.databaseSize,
      };
    } catch (error) {
      if (error instanceof DataError)
        return {
          ok: false,
          error: error.code,
          message: error.message,
          cost: { rowsRead: 0, rowsWritten: 0 },
        };
      throw error;
    }
  }

  copies(): CopyRecord[] {
    return this.#kv<CopyRecord[]>("copies") ?? [];
  }

  auditFor(opId: string): { kind: string; rows: number } | null {
    return this.#kv<{ kind: string; rows: number }>(`audit:${opId}`) ?? null;
  }

  budget(now: number): { rowsRead: number; rowsWritten: number } {
    return {
      rowsRead: this.#kv<number>(`rows_read:${day(now)}`) ?? 0,
      rowsWritten: this.#kv<number>(`rows_written:${day(now)}`) ?? 0,
    };
  }

  /** Spike only: runs a statement read-only without the classification, to show the rollback alone holds. */
  readOnlyProbe(statement: string): { refused: boolean; message: string } {
    try {
      this.#readOnly(statement, []);
      return { refused: false, message: "" };
    } catch (error) {
      return { refused: true, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Spike only: the opcodes of a statement's program, to build and check the allowlist. */
  opcodes(statement: string): string[] {
    return [...new Set(this.#program(statement, []).map((row) => row.opcode))];
  }

  /** Spike only: raw execution without any check, to set up states the checks would refuse. */
  unsafeExec(statement: string): void {
    this.ctx.storage.sql.exec(statement);
  }

  /** The barrier, as in the documents object: newer epoch, and the hold state. */
  fence(envelope: Envelope, state: "open" | "held"): boolean {
    const stored = this.#kv<Fence>("fence") ?? null;
    if (stored === null) return true;
    if (stored.artifactId !== envelope.artifactId || envelope.epoch < stored.epoch) return false;
    this.ctx.storage.kv.put<Fence>("fence", { ...stored, epoch: envelope.epoch, state });
    return true;
  }

  /** Erases the sandbox for one generation; a retry of an older generation does nothing. */
  async erase(envelope: Envelope): Promise<boolean> {
    const stored = this.#kv<Fence>("fence") ?? null;
    if (stored !== null && envelope.generation < stored.generation) return false;
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put<Fence>("fence", {
      artifactId: envelope.artifactId,
      region: envelope.region,
      generation: envelope.generation + 1,
      epoch: envelope.epoch,
      state: "open",
    });
    return true;
  }
}
