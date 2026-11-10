// The content Worker's lookup with regions: the directory says where, the regional database says
// what. With the directory entry cached (the common case) that is one D1 read, as today; a cold
// isolate pays one more read per artifact, once; an unknown ID costs one read, as today.
import type { Directory } from "./directory.ts";
import type { Region, Regions } from "./regions.ts";

export interface DeliveryArtifact {
  id: string;
  ownerId: string;
  state: string;
}

export interface Found {
  region: Region;
  artifact: DeliveryArtifact;
}

export async function findForDelivery(
  regions: Regions,
  directory: Directory,
  id: string,
): Promise<Found | null> {
  const region = await directory.regionOf(id);
  if (!region) return null;
  const row = await regions
    .get(region)
    .db.prepare("select id, owner_id as ownerId, state from artifacts where id = ?")
    .bind(id)
    .first<DeliveryArtifact>();
  return row ? { region, artifact: row } : null;
}

/** Reads an artifact's object from its region's bucket, and only from there. */
export async function readObject(
  regions: Regions,
  found: Found,
  key: string,
): Promise<string | null> {
  const object = await regions.get(found.region).bucket.get(`objects/${found.artifact.id}/${key}`);
  return object ? object.text() : null;
}
