// Creating an artifact in its owner's region. Today `preparePublish` inserts the artifact in one
// batch and a trigger refuses a tombstoned ID. With regions the ID lives in two databases: the
// global directory (unique across regions, permanent) and the owner's regional database. No
// batch spans both, so the order carries the correctness:
//
// 1. Claim the ID in the directory, only if it has no tombstone. The primary key makes two
//    concurrent claims of one ID resolve to one winner; the loser draws another ID.
// 2. Write the artifact in the region, in the regional batch that also reserves quota.
//
// A failure between the two leaves a claimed ID with no artifact. That is harmless: the content
// Worker finds the region, finds no artifact there and answers 404 like for any unknown ID, and
// the ID is simply never used, which IDs already promise. The reverse (an artifact no directory
// row points to) cannot happen, because the regional write only runs after the claim.
import { ownerRegion, type Region, type Regions } from "./regions.ts";

export const ARTIFACT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 10;
/** Draws before giving up; a collision in 32^10 IDs is already improbable. */
export const CLAIM_ATTEMPTS = 5;

export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => void;

export function generateArtifactId(
  random: RandomBytes = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = new Uint8Array(ID_LENGTH);
  random(bytes);
  let id = "";
  for (const byte of bytes) id += ARTIFACT_ID_ALPHABET[byte % ARTIFACT_ID_ALPHABET.length];
  return id;
}

/** Claims `id` for `region` unless it was ever used or tombstoned. True when this call won it. */
export async function claimArtifactId(
  global: D1Database,
  id: string,
  region: Region,
  now: number,
): Promise<boolean> {
  const result = await global
    .prepare(
      `insert into artifact_directory (id, region, created_at)
       select ?1, ?2, ?3
       where not exists (select 1 from tombstones where kind = 'artifact' and id = ?1)
       on conflict (id) do nothing`,
    )
    .bind(id, region, now)
    .run();
  return result.meta.changes === 1;
}

export interface CreateInput {
  ownerId: string;
  name: string;
  now: number;
  random?: RandomBytes;
  /** Test hook: runs between the global claim and the regional write. */
  afterClaim?: (id: string) => Promise<void>;
}

export type CreateResult =
  | { ok: true; id: string; region: Region }
  | { ok: false; code: "not_found" | "id_exhausted" | "owner_fenced" };

export async function createArtifact(regions: Regions, input: CreateInput): Promise<CreateResult> {
  const region = await ownerRegion(regions.global, input.ownerId);
  if (!region) return { ok: false, code: "not_found" };
  const { db } = regions.get(region);
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const id = generateArtifactId(input.random);
    if (!(await claimArtifactId(regions.global, id, region, input.now))) continue;
    await input.afterClaim?.(id);
    try {
      // In production this is preparePublish's batch: usage, artifact, version, files, session.
      await db.batch([
        db
          .prepare("insert into artifacts (id, owner_id, name) values (?, ?, ?)")
          .bind(id, input.ownerId, input.name),
      ]);
    } catch (error) {
      if (String((error as Error).message).includes("owner_fenced")) {
        return { ok: false, code: "owner_fenced" };
      }
      throw error;
    }
    return { ok: true, id, region };
  }
  return { ok: false, code: "id_exhausted" };
}
