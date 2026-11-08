// Read queries used when serving artifacts. They run on every uncached request, so each is a
// single indexed lookup.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./index.ts";
import { artifacts, objects, trafficCounters, versionFiles, versions } from "./schema.ts";

export interface DeliveryArtifact {
  id: string;
  ownerId: string;
  type: "site" | "markdown" | "text";
  state: "draft" | "active" | "archived" | "suspended" | "purging" | "deleted";
  accessMode: "public" | "authenticated" | "restricted";
  policyGeneration: number;
  indexable: boolean;
  embeddable: boolean;
  currentVersionId: string | null;
  /** Entrypoint of the current version: the original of a document. */
  entrypoint: string | null;
  expiresAt: number | null;
  archivedAt: number | null;
  /** What the owner's artifacts served in the cycle asked for; zero without a counter yet. */
  traffic: { requests: number; bytes: number };
}

/**
 * The artifact, its current version's entrypoint and the owner's traffic counter for the cycle
 * that starts at `cycleStart`, in one lookup.
 */
export async function findDeliveryArtifact(
  db: Db,
  id: string,
  cycleStart: number,
): Promise<DeliveryArtifact | null> {
  const [row] = await db
    .select({
      id: artifacts.id,
      ownerId: artifacts.ownerId,
      type: artifacts.type,
      state: artifacts.state,
      accessMode: artifacts.accessMode,
      policyGeneration: artifacts.policyGeneration,
      indexable: artifacts.indexable,
      embeddable: artifacts.embeddable,
      currentVersionId: artifacts.currentVersionId,
      entrypoint: versions.entrypoint,
      expiresAt: artifacts.expiresAt,
      archivedAt: artifacts.archivedAt,
      requests: sql<number>`coalesce(${trafficCounters.requests}, 0)`,
      bytes: sql<number>`coalesce(${trafficCounters.bytes}, 0)`,
    })
    .from(artifacts)
    .leftJoin(versions, eq(versions.id, artifacts.currentVersionId))
    .leftJoin(
      trafficCounters,
      and(
        eq(trafficCounters.ownerId, artifacts.ownerId),
        eq(trafficCounters.cycleStart, cycleStart),
      ),
    )
    .where(eq(artifacts.id, id))
    .limit(1);
  if (!row) return null;
  const { requests, bytes, ...artifact } = row;
  return { ...artifact, traffic: { requests: Number(requests), bytes: Number(bytes) } };
}

export interface DeliveryFile {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
  r2Key: string;
}

/** A published file of a version together with the R2 key of its verified object. */
export function findPublishedFile(
  db: Db,
  versionId: string,
  path: string,
): Promise<DeliveryFile | null> {
  return findVersionFile(db, versionId, "published", path);
}

/** The rendered page of a document version, if it was rendered. */
export function findRenderedPage(
  db: Db,
  versionId: string,
  entrypoint: string,
): Promise<DeliveryFile | null> {
  return findVersionFile(db, versionId, "rendered", entrypoint);
}

async function findVersionFile(
  db: Db,
  versionId: string,
  kind: "published" | "rendered",
  path: string,
): Promise<DeliveryFile | null> {
  const [row] = await db
    .select({
      path: versionFiles.path,
      sha256: versionFiles.sha256,
      size: versionFiles.size,
      contentType: versionFiles.contentType,
      r2Key: objects.r2Key,
    })
    .from(versionFiles)
    .innerJoin(
      objects,
      and(eq(objects.ownerId, versionFiles.ownerId), eq(objects.sha256, versionFiles.sha256)),
    )
    .where(
      and(
        eq(versionFiles.versionId, versionId),
        eq(versionFiles.kind, kind),
        eq(versionFiles.path, path),
        eq(objects.state, "verified"),
      ),
    )
    .limit(1);
  return row ?? null;
}
