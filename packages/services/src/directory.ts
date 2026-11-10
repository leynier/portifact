// The global artifact directory (decision 0005, section 2). An artifact ID is claimed here, in
// the global database, before the artifact is written in its owner's region. No batch spans the
// two, so the order carries the correctness: a crash between the claim and the regional batch
// leaves a claimed ID with no artifact, which answers like any unknown ID and is never reused,
// while an artifact no directory row points to cannot exist.
import { type GlobalDb, type Region, schema } from "@portifact/db";
import { generateArtifactId } from "@portifact/domain";
import { sql } from "drizzle-orm";

/** Draws before giving up; a collision among 32^10 IDs is already improbable. */
export const CLAIM_ATTEMPTS = 5;

/**
 * Claims `id` for `region` unless it was ever handed out or has a tombstone. True when this
 * call won it: the primary key makes two concurrent claims of one ID resolve to one winner.
 */
export async function claimArtifactId(
  global: GlobalDb,
  id: string,
  region: Region,
  now: number,
): Promise<boolean> {
  const d = schema.artifactDirectory;
  const t = schema.tombstones;
  const claimed = await global
    .insert(d)
    // Columns in schema order: id, region, created at.
    .select(
      sql`select ${id}, ${region}, ${now} where not exists (select 1 from ${t} where ${t.kind} = 'artifact' and ${t.id} = ${id})`,
    )
    .onConflictDoNothing()
    .returning({ id: d.id });
  return claimed.length === 1;
}

/**
 * A new artifact ID claimed for `region`, or null when every draw was taken (the caller answers
 * `version_conflict`, as a lost race does). `draw` is only replaced by tests.
 */
export async function claimNewArtifactId(
  global: GlobalDb,
  region: Region,
  now: number,
  draw: () => string = () => generateArtifactId(),
): Promise<string | null> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const id = draw();
    if (await claimArtifactId(global, id, region, now)) return id;
  }
  return null;
}
