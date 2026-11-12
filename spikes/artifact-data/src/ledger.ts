// The owner's data budget (decision 0026, "Budgets"): one object per owner, in the owner's
// region, that leases rows read and written to the owner's artifact objects in chunks. An
// artifact asks only when its lease runs out, so the owner's daily total is exact up to the
// chunks its artifacts hold, and no request pays a call here in the common case.
import { DurableObject } from "cloudflare:workers";

export class OwnerLedger extends DurableObject<Env> {
  #ready = false;

  #schema(): void {
    if (this.#ready) return;
    this.ctx.storage.sql.exec(
      `create table if not exists leases (day integer not null, kind text not null,
         used integer not null, primary key (day, kind)) without rowid`,
    );
    this.#ready = true;
  }

  /** Grants up to `want` rows of `kind` for `day`, never past `limit` in total; 0 when spent. */
  lease(day: number, kind: "read" | "written", want: number, limit: number): number {
    this.#schema();
    return this.ctx.storage.transactionSync(() => {
      const [row] = this.ctx.storage.sql
        .exec<{ used: number }>("select used from leases where day = ? and kind = ?", day, kind)
        .toArray();
      const used = row?.used ?? 0;
      const granted = Math.max(0, Math.min(want, limit - used));
      this.ctx.storage.sql.exec(
        `insert into leases (day, kind, used) values (?, ?, ?)
         on conflict (day, kind) do update set used = used + excluded.used`,
        day,
        kind,
        granted,
      );
      this.ctx.storage.sql.exec("delete from leases where day < ?", day - 1);
      return granted;
    });
  }

  used(day: number, kind: "read" | "written"): number {
    this.#schema();
    const [row] = this.ctx.storage.sql
      .exec<{ used: number }>("select used from leases where day = ? and kind = ?", day, kind)
      .toArray();
    return row?.used ?? 0;
  }
}
