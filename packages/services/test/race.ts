// Races for tests: a database handle whose first write (a statement or a batch that inserts,
// updates or deletes) first runs `before`, so another request's change commits between the
// service's reads and its writes, the way a concurrent request would.
import { env } from "cloudflare:test";
import type { RequestContext } from "@portifact/contracts";
import { aliasBinding, type GlobalDb, globalDb, type RegionalDb, regionalDb } from "@portifact/db";

const WRITE = /^\s*(insert|update|delete|with)\b/i;

/**
 * The default region's handle over `env.DB`, racing; it stands for `env.DB` (`aliasBinding`), so
 * the services see one database, today's production shape. `binding` gives another region's
 * database instead (`env.DB_EU`), a separate one.
 */
export function raceBeforeFirstWrite(
  before: () => Promise<void>,
  binding: D1Database = env.DB,
  request?: RequestContext,
): RegionalDb {
  return regionalDb(aliasBinding(racedD1(before, binding), binding), globalDb(env.DB, request));
}

/** The same, for services that take the global database. */
export function raceGlobalBeforeFirstWrite(before: () => Promise<void>): GlobalDb {
  return globalDb(aliasBinding(racedD1(before), env.DB));
}

/**
 * The global database, running `before` right before the first statement whose SQL matches
 * `pattern`: a race placed after a scan's reads and before a given write.
 */
export function raceGlobalBeforeStatement(pattern: RegExp, before: () => Promise<void>): GlobalDb {
  return globalDb(aliasBinding(racedD1(before, env.DB, pattern), env.DB));
}

/**
 * The default region's handle over `env.DB`, running `before` right before the first statement
 * whose SQL matches `pattern`, whichever handle prepared it (one database: a path may run on the
 * handle `bothSides` gives).
 */
export function raceBeforeStatement(pattern: RegExp, before: () => Promise<void>): RegionalDb {
  return regionalDb(aliasBinding(racedD1(before, env.DB, pattern), env.DB), globalDb(env.DB));
}

function racedD1(
  before: () => Promise<void>,
  d1: D1Database = env.DB,
  pattern: RegExp = WRITE,
): D1Database {
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
            if (pattern.test(query)) await fire();
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
          if (pattern === WRITE) await fire();
          return target.batch(statements.map((s) => real.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxied;
}

/** A handle over another region's database (`env.DB_EU`), running `before` like the above. */
export function raceBeforeStatementIn(
  binding: D1Database,
  pattern: RegExp,
  before: () => Promise<void>,
): RegionalDb {
  return regionalDb(aliasBinding(racedD1(before, binding, pattern), binding), globalDb(env.DB));
}
