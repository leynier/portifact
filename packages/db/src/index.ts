import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

export { schema };

/** Drizzle client for the control database. */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;

export * from "./delivery.ts";
export * from "./rate-limits.ts";
