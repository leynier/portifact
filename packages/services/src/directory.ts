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
 * Claims `id` for `region` unless it was ever handed out or has a tombstone, and, with `owner`,
 * only while that owner has no deletion pending: an account or workspace being deleted gets no
 * new artifact, even from a request authorized just before (decision 0005, "Two-region audit").
 * True when this call won it: the primary key makes two concurrent claims of one ID resolve to
 * one winner.
 */
export async function claimArtifactId(
  global: GlobalDb,
  id: string,
  region: Region,
  now: number,
  owner?: string,
): Promise<boolean> {
  const d = schema.artifactDirectory;
  const t = schema.tombstones;
  const ad = schema.accountDeletions;
  const wd = schema.workspaceDeletions;
  const ownerLive =
    owner === undefined
      ? sql``
      : sql` and not exists (select 1 from ${ad} where ${ad.userId} = ${owner}) and not exists (select 1 from ${wd} where ${wd.workspaceId} = ${owner})`;
  const claimed = await global
    .insert(d)
    // Columns in schema order: id, region, created at.
    .select(
      sql`select ${id}, ${region}, ${now} where not exists (select 1 from ${t} where ${t.kind} = 'artifact' and ${t.id} = ${id})${ownerLive}`,
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
  /** The new artifact's owner: no ID is claimed while its deletion is pending. */
  owner?: string,
): Promise<string | null | "owner_deleting"> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const id = draw();
    if (await claimArtifactId(global, id, region, now, owner)) return id;
    // Only a refused claim asks why, so a publish that claims costs nothing more.
    if (owner !== undefined && (await deletionPending(global, owner))) return "owner_deleting";
  }
  return null;
}

async function deletionPending(global: GlobalDb, owner: string): Promise<boolean> {
  const ad = schema.accountDeletions;
  const wd = schema.workspaceDeletions;
  const [row] = await global.all<{ pending: number }>(
    sql`select exists (select 1 from ${ad} where ${ad.userId} = ${owner}) or exists (select 1 from ${wd} where ${wd.workspaceId} = ${owner}) as pending`,
  );
  return Number(row?.pending ?? 0) === 1;
}
