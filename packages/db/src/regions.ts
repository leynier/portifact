// The region resolver (decision 0005, sections 1 and 7). Identity, workspaces, memberships,
// plans and the artifact directory live in the global database; an owner's artifacts, usage and
// comments live in its region's database. Each Worker builds one `Regions` value from its
// bindings with `regionsFromEnv`, and adapters take their handles from it instead of calling
// `createDb(env.DB)`. With one region both handles wrap the same binding.
import { drizzle } from "drizzle-orm/d1";
import * as accessSchema from "./access-schema.ts";
import type { AccessDb, Db } from "./index.ts";
import * as schema from "./schema.ts";
import { REGIONS } from "./schema.ts";

export type Region = (typeof REGIONS)[number];

declare const globalBrand: unique symbol;
declare const regionalBrand: unique symbol;

/** The global database: identity, workspaces, memberships, plans, the artifact directory. */
export type GlobalDb = Db & { readonly [globalBrand]: true };

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

/** Wraps a binding as the global database. */
export function globalDb(d1: D1Database): GlobalDb {
  return drizzle(d1, { schema }) as GlobalDb;
}

/** Wraps a binding as a region's database, attached to its deployment's global database. */
export function regionalDb(d1: D1Database, global: GlobalDb): RegionalDb {
  return Object.assign(drizzle(d1, { schema }), { global }) as unknown as RegionalDb;
}

/** What one region stores. `accessDb` is there only in Workers bound to the access log. */
export interface RegionHandles {
  region: Region;
  db: RegionalDb;
  accessDb: AccessDb | undefined;
}

/** The global database plus every region. `get` never falls back: an unknown region throws. */
export interface Regions {
  global: GlobalDb;
  get(region: Region): RegionHandles;
  all(): readonly RegionHandles[];
}

/** The bindings a Worker needs for the regions; the default region is `DB` and `ACCESS_DB`. */
export interface RegionEnv {
  DB: D1Database;
  ACCESS_DB?: D1Database;
}

/** Builds the regions of a Worker from its bindings. Today the only region is `default`. */
export function regionsFromEnv(env: RegionEnv): Regions {
  const global = globalDb(env.DB);
  const handles = new Map<Region, RegionHandles>([
    [
      "default",
      {
        region: "default",
        db: regionalDb(env.DB, global),
        accessDb: env.ACCESS_DB ? drizzle(env.ACCESS_DB, { schema: accessSchema }) : undefined,
      },
    ],
  ]);
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
