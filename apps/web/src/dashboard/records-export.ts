// The records downloads of "Download your data": one artifact's records and the space's records,
// the same files `portifact export` writes (`ArtifactRecords`, `SpaceRecords`), assembled in the
// browser by the shared collector from read routes the dashboard already uses. Nothing is archived
// on the server. With the dashboard's session the space's records also hold what only the session
// may read (members, invitations, email domains, service tokens and the like), for admins.
import {
  ArtifactRecords,
  type RecordSkipReason,
  type SkippedRecord,
  SpaceRecords,
} from "@portifact/contracts";
import {
  collectArtifactRecords,
  collectSpaceRecords,
  type RecordPart,
  recordsRetryLater,
} from "@portifact/domain";
import { ApiFailure, type DashboardApi } from "./api.ts";
import type { SavedFile } from "./publish/download.ts";
import type { Space } from "./space.tsx";

/** The refusals a records file notes as a missing part; anything else fails the download. */
const SKIPPED: Partial<Record<string, RecordSkipReason>> = {
  forbidden: "forbidden",
  plan_required: "plan_required",
  not_found: "not_found",
  rate_limited: "rate_limited",
  // A feature switched off on this deployment; capacity protection never refuses reads.
  capacity_unavailable: "unavailable",
};

/** A read whose refusal is recorded in the file instead of failing the download. */
async function part<T>(read: () => Promise<T>): Promise<RecordPart<T>> {
  try {
    return await read();
  } catch (error) {
    const skipped = error instanceof ApiFailure ? SKIPPED[error.code] : undefined;
    if (skipped) return { skipped };
    throw error;
  }
}

function jsonFile(fileName: string, value: unknown): SavedFile {
  return {
    fileName,
    blob: new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }),
  };
}

export interface RecordsDownload {
  file: SavedFile;
  /** A part asked to wait: downloading again later completes it. */
  retryLater: boolean;
}

/** One artifact's records, as `artifacts/<id>/records.json` of `portifact export`. */
export async function artifactRecordsFile(
  api: DashboardApi,
  artifactId: string,
  now: number,
): Promise<RecordsDownload> {
  const artifact = await api.getArtifact(artifactId);
  const records = ArtifactRecords.parse(
    await collectArtifactRecords(
      artifact,
      {
        access: () => part(() => api.getAccess(artifactId)),
        shareLinks: () => part(() => api.listShareLinks(artifactId)),
        approvalReview: () => part(() => api.getReview(artifactId)),
        stats: (range) => part(() => api.stats(artifactId, range?.from, range?.to)),
        comments: (version) => part(() => api.annotationExport(artifactId, version)),
        commentHistory: (cursor) => part(() => api.annotationHistory(artifactId, cursor)),
      },
      now,
    ),
  );
  return {
    file: jsonFile(`${artifactId}-records.json`, records),
    retryLater: recordsRetryLater(records),
  };
}

/** The space's records, as `space.json` of `portifact export` with the session's parts filled. */
export async function spaceRecordsFile(
  api: DashboardApi,
  space: Space,
  now: number,
): Promise<RecordsDownload> {
  const slug = space.slug;
  const { ownerId } = await api.graceForecast(slug);
  const inWorkspace = <T>(read: (slug: string) => Promise<T>) =>
    slug === undefined
      ? async (): Promise<SkippedRecord> => ({ skipped: "not_found" })
      : () => part(() => read(slug));
  const records = SpaceRecords.parse(
    await collectSpaceRecords(
      { ownerId, slug: slug ?? null },
      {
        workspace: inWorkspace(async (s) => {
          const found = (await api.workspaces()).items.find((item) => item.slug === s);
          if (!found) throw new ApiFailure("not_found", 404);
          return found;
        }),
        members: inWorkspace((s) => api.members(s)),
        invitations: inWorkspace((s) => api.invitations(s)),
        groups: inWorkspace((s) => api.groups(s)),
        group: (groupId) => inWorkspace((s) => api.group(s, groupId))(),
        emailDomains: inWorkspace((s) => api.workspaceDomains(s)),
        policies: inWorkspace((s) => api.policies(s)),
        serviceTokens: inWorkspace((s) => api.serviceTokens(s)),
        githubTrust: inWorkspace((s) => api.githubTrust(s)),
        sso: inWorkspace((s) => api.sso(s)),
        scim: inWorkspace((s) => api.scim(s)),
        branding: () => part(() => api.brandSettings(slug)),
        webhooks: () => part(() => api.webhooks(slug)),
        integrations: () => part(() => api.integrationConnections(slug)),
        auditStreams: () => part(() => api.auditStreams(slug)),
      },
      now,
    ),
  );
  return {
    file: jsonFile(`${slug ?? "personal"}-space-records.json`, records),
    retryLater: recordsRetryLater(records),
  };
}
