// The region resolver. Every operation gets its database and bucket from the owner (or, on the
// content Worker, from the artifact directory). Services keep taking handles as arguments; only
// the adapters build them, from the bindings of their Worker.

export const REGIONS = ["default", "eu"] as const;
export type Region = (typeof REGIONS)[number];

export function isRegion(value: string): value is Region {
  return (REGIONS as readonly string[]).includes(value);
}

/** What one region stores: its control database, its bucket and the S3 endpoint for presigning. */
export interface RegionHandles {
  region: Region;
  db: D1Database;
  bucket: R2Bucket;
  /** Base URL presigned uploads and downloads go to; the EU jurisdiction has its own host. */
  s3Endpoint: string;
}

/** The global database plus every region. `get` never falls back: an unknown region throws. */
export interface Regions {
  global: D1Database;
  get(region: Region): RegionHandles;
  all(): readonly RegionHandles[];
}

/** R2's S3 endpoint for a bucket in a region. Jurisdictional buckets answer only on their host. */
export function s3Endpoint(accountId: string, region: Region, bucket: string): string {
  const host =
    region === "eu"
      ? `${accountId}.eu.r2.cloudflarestorage.com`
      : `${accountId}.r2.cloudflarestorage.com`;
  return `https://${host}/${bucket}`;
}

export interface RegionBindings {
  global: D1Database;
  regions: Partial<Record<Region, { db: D1Database; bucket: R2Bucket; bucketName: string }>>;
  accountId: string;
}

export function createRegions(bindings: RegionBindings): Regions {
  const handles = new Map<Region, RegionHandles>();
  for (const region of REGIONS) {
    const binding = bindings.regions[region];
    if (!binding) continue;
    handles.set(region, {
      region,
      db: binding.db,
      bucket: binding.bucket,
      s3Endpoint: s3Endpoint(bindings.accountId, region, binding.bucketName),
    });
  }
  if (!handles.has("default")) throw new Error("The default region needs bindings");
  return {
    global: bindings.global,
    get(region) {
      const found = handles.get(region);
      if (!found) throw new Error(`Region ${region} has no bindings in this Worker`);
      return found;
    },
    all: () => [...handles.values()],
  };
}

/**
 * The region of an owner. A personal space is always in the default region; a workspace is in
 * the region it was created in. Null when the owner does not exist.
 */
export async function ownerRegion(global: D1Database, ownerId: string): Promise<Region | null> {
  const row = await global
    .prepare(
      `select region from organizations where id = ?1
       union all select 'default' from users where id = ?1
       limit 1`,
    )
    .bind(ownerId)
    .first<{ region: string }>();
  if (!row) return null;
  if (!isRegion(row.region)) throw new Error(`Unknown region ${row.region}`);
  return row.region;
}
