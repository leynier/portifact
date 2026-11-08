// Read queries used when serving artifacts. They run on every uncached request, so each is a
// single indexed lookup.
import { and, eq } from "drizzle-orm";
import type { Db } from "./index.ts";
import { artifacts, objects, versionFiles } from "./schema.ts";

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
  expiresAt: number | null;
  archivedAt: number | null;
}

export async function findDeliveryArtifact(db: Db, id: string): Promise<DeliveryArtifact | null> {
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
      expiresAt: artifacts.expiresAt,
      archivedAt: artifacts.archivedAt,
    })
    .from(artifacts)
    .where(eq(artifacts.id, id))
    .limit(1);
  return row ?? null;
}

export interface DeliveryFile {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
  r2Key: string;
}

/** A published file of a version together with the R2 key of its verified object. */
export async function findPublishedFile(
  db: Db,
  versionId: string,
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
        eq(versionFiles.kind, "published"),
        eq(versionFiles.path, path),
        eq(objects.state, "verified"),
      ),
    )
    .limit(1);
  return row ?? null;
}
