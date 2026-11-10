// The reduced region resolver of decision 0005: the global control database, which also holds
// the default region, and one database per other region.

export const REGIONS = ["default", "eu"] as const;
export type Region = (typeof REGIONS)[number];

export function isRegion(value: string): value is Region {
  return (REGIONS as readonly string[]).includes(value);
}

export interface Regions {
  global: D1Database;
  db(region: Region): D1Database;
}

export function createRegions(global: D1Database, eu: D1Database): Regions {
  return { global, db: (region) => (region === "default" ? global : eu) };
}
