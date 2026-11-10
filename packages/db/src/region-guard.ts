// The region guard (decision 0005, "Two-region audit"). With one region the global database and
// the default region's database are the same D1 binding, so a query that joins a global table
// through a regional handle, or a batch that mixes both, works by accident and breaks the day a
// second region exists. The guard wraps each handle's binding and refuses what would break:
//
// - a statement through a regional handle that names a global table, or the reverse (TABLE_HOMES);
// - a batch whose statements were not all prepared through the handle that runs it, which is how
//   a batch would span two databases.
//
// Tests and the e2e Worker turn it on with `REGION_GUARD = "strict"`; deployed Workers never set
// it, so production pays nothing for it.
import { KNOWN_CROSS_DATABASE } from "./known-crossings.ts";
import { TABLE_HOMES, type TableName, tablesIn } from "./table-homes.ts";

export { KNOWN_CROSS_DATABASE };

/**
 * Which tables a handle may name: `global` or `regional` only their own; `both` every table, for
 * the one handle `bothSides` gives when a region's database is the global database.
 */
export type GuardSide = "global" | "regional" | "both";

export interface RegionGuardViolation {
  kind: "table" | "batch";
  side: GuardSide;
  region: string;
  tables: TableName[];
  sql: string;
}

export class RegionGuardError extends Error {
  constructor(readonly violation: RegionGuardViolation) {
    super(describeViolation(violation));
    this.name = "RegionGuardError";
  }
}

export function describeViolation(v: RegionGuardViolation): string {
  const where = v.side === "global" ? "the global database" : `region ${v.region}'s database`;
  if (v.kind === "batch") {
    return `A batch on ${where} carries statements prepared through another handle: ${v.sql.slice(0, 300)}`;
  }
  const other = v.side === "global" ? "regional" : "global";
  return `A statement through ${where} names ${other} tables (${v.tables.join(", ")}): ${v.sql.slice(0, 300)}`;
}

/** The tables of a statement that the handle on `side` must not touch. */
export function misplacedTables(side: GuardSide, sql: string): TableName[] {
  if (side === "both") return [];
  return tablesIn(sql).filter((table) => {
    const home = TABLE_HOMES[table];
    return home !== "every" && home !== side;
  });
}

const PREPARED_BY = new WeakMap<object, object>();
const REAL = new WeakMap<object, D1PreparedStatement>();

/** What each wrapping binding wraps: guards, and test proxies that say so (`aliasBinding`). */
const WRAPPED = new WeakMap<object, D1Database>();
/** How each guard was made, so `bothSides` can make the same guard for the other side. */
const GUARDS = new WeakMap<
  object,
  { region: string; onViolation: (violation: RegionGuardViolation) => void }
>();

/**
 * Says that `proxy` stands for `target` (a test's recording or racing proxy over a binding), so
 * `sameDatabase` sees through it.
 */
export function aliasBinding(proxy: D1Database, target: D1Database): D1Database {
  WRAPPED.set(proxy, target);
  return proxy;
}

/** The D1 binding under every guard and alias. */
export function underlyingBinding(d1: D1Database): D1Database {
  let current = d1;
  for (let next = WRAPPED.get(current); next; next = WRAPPED.get(current)) current = next;
  return current;
}

/**
 * The same binding, with the guard of `side` in place of the one `d1` carries (none when `d1`
 * carries none): what `bothSides` builds its handle on.
 */
export function guardedAs(d1: D1Database, side: GuardSide): D1Database {
  const guard = GUARDS.get(d1);
  const target = WRAPPED.get(d1);
  if (!guard || !target) return d1;
  return guardD1(target, side, guard.region, guard.onViolation);
}

/**
 * Wraps a D1 binding for one handle. `onViolation` decides what a violation does; the default
 * throws `RegionGuardError` before the statement reaches D1.
 */
export function guardD1(
  d1: D1Database,
  side: GuardSide,
  region: string,
  onViolation: (violation: RegionGuardViolation) => void = (violation) => {
    throw new RegionGuardError(violation);
  },
): D1Database {
  const owner = {};
  const check = (sql: string) => {
    const tables = misplacedTables(side, sql);
    if (tables.length > 0) onViolation({ kind: "table", side, region, tables, sql });
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        const real = Reflect.get(target, property, target);
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        }
        return typeof real === "function" ? real.bind(target) : real;
      },
    });
    PREPARED_BY.set(wrapped, owner);
    REAL.set(wrapped, statement);
    return wrapped;
  };
  const proxy = new Proxy(d1, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          check(sql);
          return wrap(target.prepare(sql), sql);
        };
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          const foreign = statements.find((s) => PREPARED_BY.get(s) !== owner);
          if (foreign) {
            onViolation({
              kind: "batch",
              side,
              region,
              tables: [],
              sql: "(statement from another handle)",
            });
          }
          return target.batch(statements.map((s) => REAL.get(s) ?? s));
        };
      }
      if (property === "exec") {
        return (sql: string) => {
          check(sql);
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  WRAPPED.set(proxy, d1);
  GUARDS.set(proxy, { region, onViolation });
  return proxy;
}

/** A test file prepares statements of its own to arrange rows or read results; they pass. */
const OWN_FRAMES = /node_modules|\/packages\/db\/src\/|^Error|^\s*at (new )?(Proxy|Object|Array)\./;
const TEST_FRAMES = /\/test\/|\.test\.ts|\/e2e\/|\/spikes\//;

/**
 * Who prepared a statement, from a stack: the nearest frame outside Drizzle and this package,
 * its function name, and whether it is a test file. Undefined when no frame is left.
 */
export function statementCaller(
  stack: string,
): { name: string; file: string; key: string; test: boolean } | undefined {
  const frame = stack.split("\n").find((line) => /\bat\b/.test(line) && !OWN_FRAMES.test(line));
  if (frame === undefined) return undefined;
  const match = /\bat (?:async )?([^\s(]+)/.exec(frame);
  const name = (match?.[1] ?? "").split(".").at(-1) ?? "";
  // The repository-relative path, for `KNOWN_CROSS_DATABASE`'s keys.
  const file = /((?:packages|apps)\/[^\s:()]+)/.exec(frame)?.[1] ?? "";
  return { name, file, key: `${file}#${name}`, test: TEST_FRAMES.test(frame) };
}

function currentStack(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  return stack;
}

/**
 * The guard a `REGION_GUARD` mode asks for. `strict` throws on a violation by product code that
 * `KNOWN_CROSS_DATABASE` does not list; `collect` records every product violation in
 * `globalThis.__regionGuard` instead (an inventory run: `REGION_GUARD=collect bun run test`);
 * anything else, and every deployed Worker, has no guard.
 */
export function guardFor(
  mode: string | undefined,
  /** Where a statement was prepared; tests of the guard itself stand a stack in. */
  stackOf: () => string = currentStack,
): (d1: D1Database, side: GuardSide, region: string) => D1Database {
  if (mode !== "strict" && mode !== "collect") return (d1) => d1;
  return (d1, side, region) => {
    // A test may stand a missing binding in for a failing one; there is nothing to guard.
    if (typeof d1 !== "object" || d1 === null) return d1;
    return guardD1(d1, side, region, (violation) => {
      const caller = statementCaller(stackOf());
      if (caller === undefined || caller.test) return;
      if (mode === "collect") {
        const store = globalThis as { __regionGuard?: Set<string> };
        store.__regionGuard ??= new Set();
        store.__regionGuard.add(
          `${caller.key} | ${violation.kind} ${violation.side}/${violation.region} ${violation.tables.join(",")}`,
        );
        return;
      }
      if (Object.hasOwn(KNOWN_CROSS_DATABASE, caller.key)) return;
      throw new RegionGuardError(violation);
    });
  };
}
