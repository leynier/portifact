// Database handles for the app Worker's adapters (decision 0005, section 1). Adapters never call
// `createDb(env.DB)` for product data: they take the region that holds what the request names.
// Roles are never decided here; the services resolve them from the user and the owner.

import type { OwnerView } from "@portifact/contracts";
import {
  type AccessDb,
  type RegionalDb,
  type RegionEnv,
  type RegionHandles,
  type Regions,
  regionsFromEnv,
  schema,
} from "@portifact/db";
import type { Actor, Result } from "@portifact/domain";
import {
  artifactHandles,
  ownerView,
  personalHandles,
  resolveOwnerScope,
} from "@portifact/services";
import { eq } from "drizzle-orm";

/** The regions this Worker is bound to. */
export function regionsOf(env: RegionEnv): Regions {
  return regionsFromEnv(env);
}

/**
 * The database of the region that holds an artifact. An ID the directory does not know is looked
 * up in the default region, where it is missing too, so it answers like any unknown artifact.
 */
export async function artifactDb(env: RegionEnv, artifactId: string): Promise<RegionalDb> {
  return (await artifactRegion(env, artifactId)).db;
}

/** The handles of the region that holds an artifact, found like `artifactDb`. */
export async function artifactRegion(env: RegionEnv, artifactId: string): Promise<RegionHandles> {
  const regions = regionsFromEnv(env);
  return (await artifactHandles(regions, artifactId)) ?? personalHandles(regions);
}

/**
 * The region that holds an upload session. Upload IDs carry no region, so with more than one
 * region every region is asked at once (one round trip, in parallel); with one region nothing is
 * read. An unknown ID is looked up in the default region, where it is missing too.
 */
export async function uploadRegion(env: RegionEnv, sessionId: string): Promise<RegionHandles> {
  const regions = regionsFromEnv(env);
  const all = regions.all();
  if (all.length === 1) return personalHandles(regions);
  const u = schema.uploadSessions;
  const found = await Promise.all(
    all.map(
      async (handles) =>
        (await handles.db.select({ id: u.id }).from(u).where(eq(u.id, sessionId)).limit(1)).length >
        0,
    ),
  );
  return all[found.indexOf(true)] ?? personalHandles(regions);
}

/** The database and bucket of the region that holds an artifact, for services that take both. */
export async function artifactStorage(
  env: RegionEnv,
  artifactId: string,
): Promise<[RegionalDb, R2Bucket]> {
  const handles = await artifactRegion(env, artifactId);
  return [handles.db, bucketOf(handles)];
}

/** The region's bucket; the app Worker is bound to every region's bucket. */
export function bucketOf(handles: RegionHandles): R2Bucket {
  if (!handles.bucket) throw new Error(`Region ${handles.region} has no bucket binding`);
  return handles.bucket;
}

/** The region's access log database; the app Worker is always bound to it. */
export function accessDbOf(handles: RegionHandles): AccessDb {
  if (!handles.accessDb) throw new Error(`Region ${handles.region} has no access log binding`);
  return handles.accessDb;
}

/**
 * The database of the default region: the personal space's, and where uploads and account data
 * are kept until a second region exists (E5).
 */
export function defaultDb(env: RegionEnv): RegionalDb {
  return personalHandles(regionsFromEnv(env)).db;
}

/** The user's actor on their personal space, with its region's database. */
export async function personalScope(
  env: RegionEnv,
  userId: string,
): Promise<{ actor: Actor; db: RegionalDb }> {
  const scope = await ownerScope(env, userId, undefined);
  // A user always has a role on their own personal space.
  if (!scope.ok) throw new Error("A user has no personal space");
  return { actor: scope.value.actor, db: scope.value.db };
}

/**
 * The actor on the space a request names (`?workspace=<slug>` on the API, the `workspace`
 * argument of MCP tools): the personal space without a slug. The role comes from the services; a
 * workspace the user is not a member of answers `not_found` like one that does not exist.
 */
export async function ownerScope(
  env: RegionEnv,
  userId: string,
  slug: string | undefined,
): Promise<Result<{ actor: Actor; db: RegionalDb; owner: OwnerView }>> {
  const regions = regionsFromEnv(env);
  const actor = await resolveOwnerScope(regions.global, userId, slug);
  if (!actor.ok) return actor;
  return {
    ok: true,
    value: {
      actor: actor.value,
      db: regions.get(actor.value.region).db,
      owner: await ownerView(regions.global, actor.value.ownerId),
    },
  };
}

/** Where an artifact lives, for its views. */
export async function ownerOf(env: RegionEnv, ownerId: string): Promise<OwnerView> {
  return ownerView(regionsFromEnv(env).global, ownerId);
}
