// What a regional scan or job needs to reach the global rows it decides with (decision 0005,
// "Two-region audit"). With one database (`sameDatabase`, production today) a scan keeps its
// statements exactly as they were, built on the one handle `bothSides` gives; with a separate
// regional database it reads the global rows from the global database and limits itself to the
// owners that live in its region.
import { DEFAULT_REGION } from "@portifact/contracts";
import { bothSides, type Db, type Region, type RegionalDb, schema } from "@portifact/db";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

/** The handle a regional scan reads global rows with: `bothSides` with one database, else global. */
export function globalReader(db: RegionalDb): Db {
  return bothSides(db) ?? db.global;
}

/**
 * For a statement on the global database: `owner` (a column or expression) is an owner whose
 * data lives in `region`. A personal space is always in the default region, a workspace in its
 * own `region`.
 */
export function ownerOfRegion(owner: SQLWrapper, region: Region): SQL {
  const w = schema.workspaces;
  return region === DEFAULT_REGION
    ? sql`(substr(${owner}, 1, 3) <> 'ws_' or ${owner} in (select ${w.id} from ${w} where ${w.region} = ${region}))`
    : sql`${owner} in (select ${w.id} from ${w} where ${w.region} = ${region})`;
}

/**
 * The values of a list as a subquery, in one parameter whatever its length (D1 allows at most 100
 * parameters per statement), for conditions a separate regional database cannot write as a
 * subquery of a global table.
 */
export function jsonValues(values: readonly string[]): SQL {
  return sql`(select value from json_each(${JSON.stringify(values)}))`;
}

/** Ids passed to one statement at a time through `jsonValues`, keeping it far below D1's size. */
export const JSON_CHUNK = 500;

/** `values` in chunks of `JSON_CHUNK`. */
export function chunked<T>(values: readonly T[], size = JSON_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}
