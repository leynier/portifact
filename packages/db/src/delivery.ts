// Read queries used when serving artifacts. They run on every uncached request, so each is a
// single indexed lookup.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./index.ts";
import {
  artifacts,
  objects,
  ownerPlans,
  trafficCounters,
  versionFiles,
  versions,
} from "./schema.ts";

export interface DeliveryArtifact {
  id: string;
  ownerId: string;
  type: "site" | "markdown" | "text";
  state: "draft" | "active" | "archived" | "suspended" | "purging" | "deleted";
  accessMode: "public" | "authenticated" | "restricted" | "workspace" | "domain";
  policyGeneration: number;
  indexable: boolean;
  embeddable: boolean;
  /** Top-level page visits open in the viewer with the Portifact bar. */
  bar: boolean;
  /** The artifact's active custom host (decision 0006), or null. */
  customHost: string | null;
  currentVersionId: string | null;
  /** Entrypoint of the current version: the original of a document. */
  entrypoint: string | null;
  expiresAt: number | null;
  archivedAt: number | null;
  /** What the owner's artifacts served in the cycle asked for; zero without a counter yet. */
  traffic: { requests: number; bytes: number };
  /**
   * The owner's plan row, which decides its traffic quota; null when it has none (free). Plans
   * are global and artifacts regional (decision 0005), so the lookup never joins it: the content
   * Worker attaches it from its per-isolate cache of `findDeliveryPlan`.
   */
  plan: DeliveryPlan | null;
}

/** The `owner_plans` columns `entitlements` (@portifact/domain) reads. */
export interface DeliveryPlan {
  plan: string;
  seats: number;
  validUntil: number | null;
  overrides: unknown;
}

/**
 * The artifact, its current version's entrypoint and the owner's traffic counter for the cycle
 * that starts at `cycleStart`, in one lookup of the artifact's regional database. `plan` comes
 * back null: the caller attaches the owner's plan from the global database (`findDeliveryPlan`).
 * With `customHost`, only an artifact that holds exactly that custom host (decision 0006): the
 * regional column decides what a custom host serves, whatever any cached hint said.
 */
export async function findDeliveryArtifact(
  db: Db,
  id: string,
  cycleStart: number,
  customHost?: string,
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
      bar: artifacts.bar,
      customHost: artifacts.customHost,
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
    .where(
      customHost === undefined
        ? eq(artifacts.id, id)
        : and(eq(artifacts.id, id), eq(artifacts.customHost, customHost)),
    )
    .limit(1);
  if (!row) return null;
  const { requests, bytes, ...artifact } = row;
  return { ...artifact, traffic: { requests: Number(requests), bytes: Number(bytes) }, plan: null };
}

/** The owner's plan row for delivery, from the global database; null when it has none (free). */
export async function findDeliveryPlan(global: Db, ownerId: string): Promise<DeliveryPlan | null> {
  const [row] = await global
    .select({
      plan: ownerPlans.plan,
      seats: ownerPlans.seats,
      validUntil: ownerPlans.validUntil,
      overrides: ownerPlans.overrides,
    })
    .from(ownerPlans)
    .where(eq(ownerPlans.ownerId, ownerId))
    .limit(1);
  return row ? { ...row, overrides: row.overrides ?? null } : null;
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
