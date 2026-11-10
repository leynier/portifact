// The `/api/v1` response shapes, built from service results. MCP returns exactly what the API
// returns for the same operation; the parity tests in test/mcp-parity.test.ts hold both to it.
import {
  ArtifactListItem,
  ArtifactSummary,
  CommittedPublish,
  LifecycleResult,
  type OwnerView,
} from "@portifact/contracts";
import type {
  ArtifactRow,
  CommittedPublish as CommittedVersion,
  LifecycleOutcome,
  ListedArtifact,
} from "@portifact/services";
import type { Env } from "../env.ts";

/** An artifact's summary, with where it lives (`ownerView` in the services). */
export function artifactSummary(env: Env, row: ArtifactRow, owner: OwnerView): ArtifactSummary {
  return ArtifactSummary.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    state: row.state,
    accessMode: row.accessMode,
    annotations: row.annotations,
    currentVersionId: row.currentVersionId,
    url: contentUrl(env, row.id),
    owner,
    expiresAt: isoOrNull(row.expiresAt),
    archivedAt: isoOrNull(row.archivedAt),
    purgeAt: isoOrNull(row.purgeAt),
    ...(row.state === "suspended" && row.suspensionReason
      ? { suspension: { reason: row.suspensionReason } }
      : {}),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

/** An artifact of the list, with its activity; `GET /api/v1/artifacts` and `list_artifacts`. */
export function artifactListItem(
  env: Env,
  row: ListedArtifact,
  owner: OwnerView,
): ArtifactListItem {
  const { activity } = row;
  return ArtifactListItem.parse({
    ...artifactSummary(env, row, owner),
    activity: {
      versions: activity.versions,
      currentBytes: activity.currentBytes,
      openThreads: activity.openThreads,
      lastAnnotationAt: isoOrNull(activity.lastAnnotationAt),
    },
  });
}

export function committedPublish(env: Env, value: CommittedVersion): CommittedPublish {
  return CommittedPublish.parse({
    artifactId: value.artifactId,
    versionId: value.versionId,
    versionNumber: value.versionNumber,
    url: contentUrl(env, value.artifactId),
    expiresAt: iso(value.expiresAt),
  });
}

export function lifecycleResult(value: LifecycleOutcome): LifecycleResult {
  return LifecycleResult.parse({
    state: value.state,
    expiresAt: isoOrNull(value.expiresAt),
    purgeAt: isoOrNull(value.purgeAt),
  });
}

function contentUrl(env: Env, artifactId: string): string {
  return `https://${artifactId}.${env.CONTENT_DOMAIN}/`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}
