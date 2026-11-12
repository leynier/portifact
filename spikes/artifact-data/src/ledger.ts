// The owner's data budget (decision 0026, "Budgets"): one object per owner, in the owner's
// region. Each pool is a balance that refills by its daily allowance, up to one day's worth, and
// that leases hand out in chunks. Document work is charged at an upper bound before it runs, so
// a lease is never overdrawn and the balance never goes below zero. The accounting day only moves
// forward: a delayed request carrying an older day refills nothing (finding 3). A lease the
// artifact could not install (its owner changed during the call) is released back once.
import { DurableObject } from "cloudflare:workers";

export const POOLS = [
  "documents_read",
  "documents_written",
  "cleanup",
  "export",
  "live_bytes",
] as const;
export type Pool = (typeof POOLS)[number];

export class OwnerLedger extends DurableObject<Env> {
  #ready = false;
  /** Spike only: a latch that holds the next lease, so tests can act during that await. */
  #latch: { promise: Promise<void>; open: () => void; waiting: boolean } | null = null;

  arm(): void {
    let open = () => {};
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.#latch = { promise, open, waiting: false };
  }

  waiting(): boolean {
    return this.#latch?.waiting ?? false;
  }

  release(): void {
    this.#latch?.open();
    this.#latch = null;
  }

  #schema(): void {
    if (this.#ready) return;
    this.ctx.storage.sql.exec(
      `create table if not exists pools (pool text primary key, balance integer not null,
         day integer not null) without rowid`,
    );
    this.ctx.storage.sql.exec(
      "create table if not exists released (lease text primary key, at integer not null) without rowid",
    );
    this.#ready = true;
  }

  /** The balance on the ledger's own accounting day, which never moves backward. */
  #current(pool: Pool, day: number, limit: number): { balance: number; day: number } {
    const [row] = this.ctx.storage.sql
      .exec<{ balance: number; day: number }>("select balance, day from pools where pool = ?", pool)
      .toArray();
    if (row === undefined) return { balance: limit, day };
    const today = Math.max(row.day, day);
    const days = today - row.day;
    return { balance: Math.min(limit, row.balance + days * limit), day: today };
  }

  #store(pool: Pool, state: { balance: number; day: number }): void {
    this.ctx.storage.sql.exec(
      "insert into pools (pool, balance, day) values (?, ?, ?) on conflict (pool) do update set balance = excluded.balance, day = excluded.day",
      pool,
      state.balance,
      state.day,
    );
  }

  /** Grants up to `want` while the balance lasts; nothing when it is spent. */
  async lease(pool: Pool, day: number, want: number, limit: number): Promise<number> {
    if (this.#latch !== null) {
      this.#latch.waiting = true;
      await this.#latch.promise;
    }
    this.#schema();
    return this.ctx.storage.transactionSync(() => {
      const state = this.#current(pool, day, limit);
      const granted = Math.max(0, Math.min(want, state.balance));
      this.#store(pool, { ...state, balance: state.balance - granted });
      return granted;
    });
  }

  /** Gives back a lease the artifact could not use, once per lease ID. */
  giveBack(pool: Pool, day: number, amount: number, limit: number, leaseId: string): boolean {
    this.#schema();
    return this.ctx.storage.transactionSync(() => {
      const inserted = this.ctx.storage.sql
        .exec(
          "insert into released (lease, at) values (?, ?) on conflict do nothing returning 1",
          leaseId,
          day,
        )
        .toArray();
      if (inserted.length === 0) return false;
      const state = this.#current(pool, day, limit);
      this.#store(pool, {
        ...state,
        balance: Math.min(limit, state.balance + Math.max(0, amount)),
      });
      return true;
    });
  }

  balance(pool: Pool, day: number, limit: number): number {
    this.#schema();
    return this.#current(pool, day, limit).balance;
  }
}
