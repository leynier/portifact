// The recording proxy the cost tests share: every D1 call (one statement, or one batch) counted.
import { env } from "cloudflare:test";
import { globalDb, type RegionalDb, regionalDb } from "@portifact/db";

/** Counts every D1 call (one statement, or one batch) through one shared binding. */
export function recording(regionalBinding: D1Database = env.DB) {
  let calls = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        const real = Reflect.get(target, property, target);
        if (typeof real !== "function") return real;
        if (property === "bind") return (...args: unknown[]) => wrap(real.apply(target, args));
        if (["all", "raw", "run", "first"].includes(String(property))) {
          return (...args: unknown[]) => {
            calls += 1;
            return real.apply(target, args);
          };
        }
        return real.bind(target);
      },
    });
  const real = new WeakMap<object, D1PreparedStatement>();
  const record = (binding: D1Database) =>
    new Proxy(binding, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            const wrapped = wrap(statement);
            real.set(wrapped, statement);
            return wrapped;
          };
        }
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) => {
            calls += 1;
            return target.batch(statements.map((s) => real.get(s) ?? s));
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const global = record(env.DB);
  // One database: both handles share the one recorded binding. A separate regional database
  // (the EU's) gets its own, and the calls of both are counted together.
  const regional = regionalBinding === env.DB ? global : record(regionalBinding);
  const database: RegionalDb = regionalDb(regional, globalDb(global));
  return { database, count: () => calls };
}
