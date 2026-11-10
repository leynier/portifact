// Races for tests: a database handle whose first write (a statement or a batch that inserts,
// updates or deletes) first runs `before`, so another request's change commits between the
// service's reads and its writes, the way a concurrent request would.
import { env } from "cloudflare:test";
import { globalDb, type RegionalDb, regionalDb } from "@portifact/db";

const WRITE = /^\s*(insert|update|delete|with)\b/i;

export function raceBeforeFirstWrite(before: () => Promise<void>): RegionalDb {
  const d1 = env.DB;
  let fired = false;
  const fire = async () => {
    if (fired) return;
    fired = true;
    await before();
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        }
        if (prop === "run" || prop === "all" || prop === "raw" || prop === "first") {
          return async (...args: unknown[]) => {
            if (WRITE.test(query)) await fire();
            // biome-ignore lint/suspicious/noExplicitAny: forwarding the D1 call as is
            return (target as any)[prop](...args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(wrapped, statement);
    return wrapped;
  };
  const proxied = new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query), query);
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await fire();
          return target.batch(statements.map((s) => real.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return regionalDb(proxied, globalDb(d1));
}
