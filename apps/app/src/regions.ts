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
} from "@portifact/db";
import type { Actor, Result } from "@portifact/domain";
import {
  artifactHandles,
  ownerView,
  personalHandles,
  resolveOwnerScope,
} from "@portifact/services";

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
