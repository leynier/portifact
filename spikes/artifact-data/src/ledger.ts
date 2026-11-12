// The owner's data budget (decision 0026, "Budgets"): one object per owner, in the owner's
// region. Each pool is a balance that refills by its daily allowance up to one day's worth and
// can go negative: work measured after the fact (a statement that did more than its lease, or one
// the platform stopped) is settled as debt, and no lease is granted while the balance is below
// zero, so later days pay the debt off before more work runs. Owner SQL and the documents have
// separate pools, so SQL can never spend what visitors' writes need. The ledger lives outside
// both artifacts' objects, so erasing or recreating them never clears a debt.
import { DurableObject } from "cloudflare:workers";

export const POOLS = [
  "documents_read",
  "documents_written",
  "sql_read",
  "sql_written",
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
    this.#ready = true;
  }

  /** The balance after refilling for the days since it was last touched, at most one day's worth. */
  #refill(pool: Pool, day: number, limit: number): number {
    const [row] = this.ctx.storage.sql
      .exec<{ balance: number; day: number }>("select balance, day from pools where pool = ?", pool)
      .toArray();
    if (row === undefined) return limit;
    const days = Math.max(0, day - row.day);
    return Math.min(limit, row.balance + days * limit);
  }

  #store(pool: Pool, day: number, balance: number): void {
    this.ctx.storage.sql.exec(
      "insert into pools (pool, balance, day) values (?, ?, ?) on conflict (pool) do update set balance = excluded.balance, day = excluded.day",
      pool,
      balance,
      day,
    );
  }

  /** Grants up to `want` while the balance is positive; nothing while it is spent or in debt. */
  async lease(pool: Pool, day: number, want: number, limit: number): Promise<number> {
    if (this.#latch !== null) {
      this.#latch.waiting = true;
      await this.#latch.promise;
    }
    this.#schema();
    return this.ctx.storage.transactionSync(() => {
      const balance = this.#refill(pool, day, limit);
      const granted = Math.max(0, Math.min(want, balance));
      this.#store(pool, day, balance - granted);
      return granted;
    });
  }

  /** Charges work measured after the fact; the balance may go negative (debt). */
  settle(pool: Pool, day: number, amount: number, limit: number): number {
    this.#schema();
    return this.ctx.storage.transactionSync(() => {
      const balance = this.#refill(pool, day, limit) - Math.max(0, amount);
      this.#store(pool, day, balance);
      return balance;
    });
  }

  balance(pool: Pool, day: number, limit: number): number {
    this.#schema();
    return this.#refill(pool, day, limit);
  }
}
