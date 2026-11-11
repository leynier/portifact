// The region resolver (decision 0005, sections 1 and 7). Identity, workspaces, memberships,
// plans and the artifact directory live in the global database; an owner's artifacts, usage and
// comments live in its region's database. Each Worker builds one `Regions` value from its
// bindings with `regionsFromEnv`, and adapters take their handles from it instead of calling
// `createDb(env.DB)`. With one region both handles wrap the same binding.
import { type RequestContext, UNKNOWN_REQUEST } from "@portifact/contracts";
import { drizzle } from "drizzle-orm/d1";
import * as accessSchema from "./access-schema.ts";
import type { AccessDb, Db } from "./index.ts";
import { guardedAs, guardFor, underlyingBinding } from "./region-guard.ts";
import * as schema from "./schema.ts";
import { REGIONS } from "./schema.ts";

export type Region = (typeof REGIONS)[number];

declare const globalBrand: unique symbol;
declare const regionalBrand: unique symbol;

/**
 * The global database: identity, workspaces, memberships, plans, the artifact directory. It
 * carries the request it answers (decision 0020): the role is decided only on this handle
 * (`actorOn` in @portifact/services), which applies a workspace's request policies to
 * `request`, so no use case can resolve a role without one. A handle built without a context gets
 * `UNKNOWN_REQUEST`, which every network allowlist refuses.
 */
export type GlobalDb = Db & { readonly [globalBrand]: true; readonly request: RequestContext };

/**
 * One region's control database: artifacts, versions, usage, comments. It carries the global
 * database of the same deployment, for the services that resolve a role or claim an ID while
 * working on regional data; passing a `GlobalDb` where a `RegionalDb` is expected (or the
 * reverse) does not compile.
 */
export type RegionalDb = Db & { readonly [regionalBrand]: true; readonly global: GlobalDb };

export function isRegion(value: string): value is Region {
  return (REGIONS as readonly string[]).includes(value);
}

/** Wraps a binding as the global database, for the request it answers. */
export function globalDb(d1: D1Database, request: RequestContext = UNKNOWN_REQUEST): GlobalDb {
  return Object.assign(drizzle(d1, { schema }), { request }) as unknown as GlobalDb;
}

/**
 * Where a Worker's entry puts the request context on its bindings, so every handle
 * `regionsFromEnv` builds for that request carries it (decision 0020). A symbol: no binding or
 * variable can be named like it, and nothing a client sends reaches it.
 */
export const REQUEST_CONTEXT: unique symbol = Symbol("portifact.request-context");

const BASE_ENV: unique symbol = Symbol("portifact.base-env");

/** The bindings with the request context of the request they answer. */
export function withRequestContext<E extends object>(
  env: E,
  request: RequestContext,
): E & { [REQUEST_CONTEXT]: RequestContext } {
  // A view over the bindings, not a copy: some runtimes expose bindings that a spread would drop.
  return Object.create(env, {
    [REQUEST_CONTEXT]: { value: request, enumerable: false },
    [BASE_ENV]: { value: baseEnv(env), enumerable: false },
  }) as E & { [REQUEST_CONTEXT]: RequestContext };
}

/**
 * The bindings with some replaced, keeping the request context: `{ ...env }` would drop both the
 * context and any binding that is not an own property.
 */
export function withBindings<E extends object>(env: E, replaced: Partial<E>): E {
  const descriptors: PropertyDescriptorMap = {};
  for (const [key, value] of Object.entries(replaced)) {
    descriptors[key] = { value, enumerable: true };
  }
  return Object.create(env, descriptors) as E;
}

/**
 * The Worker's own bindings object behind a per-request copy, for caches keyed by it (one Better
 * Auth instance per isolate): the copy `withRequestContext` makes is new on every request.
 */
export function baseEnv<E extends object>(env: E): E {
  return ((env as { [BASE_ENV]?: E })[BASE_ENV] ?? env) as E;
}

/** Wraps a binding as a region's database, attached to its deployment's global database. */
export function regionalDb(d1: D1Database, global: GlobalDb): RegionalDb {
  return Object.assign(drizzle(d1, { schema }), { global }) as unknown as RegionalDb;
}

/**
 * Whether a region's database is the global database: one D1 binding under both handles. True in
 * every deployment with one region (production today) and for the default region, which lives in
 * the control database; false for a region with its own database (the EU). The paths that span
 * both sides decide with this, never by a region's name: one database keeps everything in one
 * batch, as it always did, and only a separate database goes global first, then regional
 * (decision 0005, "Two-region audit").
 */
export function sameDatabase(regional: RegionalDb, global: GlobalDb = regional.global): boolean {
  return underlyingBinding(regional.$client) === underlyingBinding(global.$client);
}

const BOTH = new WeakMap<object, Db>();

/**
 * One handle over both of two handles' sides when they reach one database, null otherwise:
 * `bothSides` for any two handles (a scan given its regional and global handles separately).
 */
export function sharedHandle(one: Db, other: Db): Db | null {
  if (underlyingBinding(one.$client) !== underlyingBinding(other.$client)) return null;
  let handle = BOTH.get(one);
  if (!handle) {
    handle = drizzle(guardedAs(one.$client, "both"), { schema });
    BOTH.set(one, handle);
  }
  return handle;
}

/**
 * One handle that reaches both sides, when `sameDatabase` holds; null otherwise. The paths that
 * must stay atomic with one database (deletion, the joins of a plan on the write paths, a
 * transfer's domain condition) build their statements and their batch on it; the region guard
 * lets it name every table.
 */
export function bothSides(regional: RegionalDb): Db | null {
  return sharedHandle(regional, regional.global);
}

/**
 * What one region stores. `accessDb` is there only in Workers bound to the access log, `bucket`
 * only in Workers bound to the region's R2 bucket.
 */
export interface RegionHandles {
  region: Region;
  db: RegionalDb;
  accessDb: AccessDb | undefined;
  bucket: R2Bucket | undefined;
}

/** The global database plus every region. `get` never falls back: an unknown region throws. */
export interface Regions {
  global: GlobalDb;
  get(region: Region): RegionHandles;
  all(): readonly RegionHandles[];
}

/**
 * The bindings a Worker needs for the regions. The default region is `DB`, `ACCESS_DB` and
 * `ARTIFACTS`; the EU region exists only in a Worker bound to `DB_EU`, with `ACCESS_DB_EU` and
 * `ARTIFACTS_EU` next to it (docs/releasing.md, "EU region"). `REGION_GUARD` is set only by tests
 * and the e2e Worker (`./region-guard.ts`).
 */
export interface RegionEnv {
  DB: D1Database;
  ACCESS_DB?: D1Database;
  ARTIFACTS?: R2Bucket;
  DB_EU?: D1Database;
  ACCESS_DB_EU?: D1Database;
  ARTIFACTS_EU?: R2Bucket;
  REGION_GUARD?: string;
  /** Set by the Worker's entry with `withRequestContext`; absent is `UNKNOWN_REQUEST`. */
  [REQUEST_CONTEXT]?: RequestContext;
}

/** The bindings of a region other than the default one, by region. */
const REGION_BINDINGS = {
  eu: { db: "DB_EU", accessDb: "ACCESS_DB_EU", bucket: "ARTIFACTS_EU" },
} as const satisfies Record<Exclude<Region, "default">, Record<string, keyof RegionEnv>>;

/**
 * Builds the regions of a Worker from its bindings: always the default region, plus every other
 * region whose control database is bound. With only `DB` bound it behaves exactly as with one
 * region.
 */
export function regionsFromEnv(env: RegionEnv): Regions {
  const guard = guardFor(env.REGION_GUARD);
  const global = globalDb(guard(env.DB, "global", "global"), env[REQUEST_CONTEXT]);
  const access = (d1: D1Database | undefined) =>
    d1 ? drizzle(d1, { schema: accessSchema }) : undefined;
  const handles = new Map<Region, RegionHandles>([
    [
      "default",
      {
        region: "default",
        db: regionalDb(guard(env.DB, "regional", "default"), global),
        accessDb: access(env.ACCESS_DB),
        bucket: env.ARTIFACTS,
      },
    ],
  ]);
  for (const [region, names] of Object.entries(REGION_BINDINGS) as [
    Exclude<Region, "default">,
    (typeof REGION_BINDINGS)[keyof typeof REGION_BINDINGS],
  ][]) {
    const d1 = env[names.db];
    if (!d1) continue;
    handles.set(region, {
      region,
      db: regionalDb(guard(d1, "regional", region), global),
      accessDb: access(env[names.accessDb]),
      bucket: env[names.bucket],
    });
  }
  return {
    global,
    get(region) {
      const found = handles.get(region);
      if (!found) throw new Error(`Region ${region} has no bindings in this Worker`);
      return found;
    },
    all: () => [...handles.values()],
  };
}
