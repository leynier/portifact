// The `/api/v1` response shapes, built from service results. MCP returns exactly what the API
// returns for the same operation; the parity tests in test/mcp-parity.test.ts hold both to it.
import { ArtifactSummary, CommittedPublish, LifecycleResult } from "@portifact/contracts";
import type {
  ArtifactRow,
  CommittedPublish as CommittedVersion,
  LifecycleOutcome,
} from "@portifact/services";
import type { Env } from "../env.ts";

export function artifactSummary(env: Env, row: ArtifactRow): ArtifactSummary {
  return ArtifactSummary.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    state: row.state,
    accessMode: row.accessMode,
    annotations: row.annotations,
    currentVersionId: row.currentVersionId,
    url: contentUrl(env, row.id),
    expiresAt: isoOrNull(row.expiresAt),
    archivedAt: isoOrNull(row.archivedAt),
    purgeAt: isoOrNull(row.purgeAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
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
