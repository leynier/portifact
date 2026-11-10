import { drizzle } from "drizzle-orm/d1";
import * as accessSchema from "./access-schema.ts";
import * as schema from "./schema.ts";

export { accessSchema, schema };

/** Drizzle client for the control database. */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;

/** Drizzle client for the access log database (`portifact-access`, ./access-schema.ts). */
export function createAccessDb(d1: D1Database) {
  return drizzle(d1, { schema: accessSchema });
}

export type AccessDb = ReturnType<typeof createAccessDb>;

export * from "./delivery.ts";
export * from "./rate-limits.ts";
export * from "./regions.ts";
