// `portifact export`: what a space's export folder holds (decision 0022, second delivery). The
// CLI writes `manifest.json` last, from what it verified on disk, so a reader of the folder (or a
// later run that resumes it) knows exactly what is there and what was left out, and why.
import { z } from "zod";
import { ArtifactStatsDay, StatsDate } from "./analytics.ts";
import { AnnotationExport, AnnotationHistoryEntry } from "./annotations.ts";
import { ApprovalReviewView } from "./approval-reviews.ts";
import { AuditStreamList } from "./audit-streams.ts";
import { BrandSettings } from "./branding.ts";
import { ArtifactId } from "./core.ts";
import { WorkspaceDomainList } from "./email-domains.ts";
import { GitHubTrustRuleList } from "./github-oidc.ts";
import { WorkspaceGroupDetail, WorkspaceGroupList } from "./groups.ts";
import { IntegrationConnectionList, IntegrationConnectionView } from "./integrations.ts";
import { WorkspacePolicyView } from "./policies.ts";
import { AccessPolicyView, ArtifactSummary } from "./publishing.ts";
import { ScimOverview } from "./scim.ts";
import { ServiceTokenList } from "./service-tokens.ts";
import { ShareLinkList } from "./share-links.ts";
import { SsoSettings } from "./sso.ts";
import { ChangeItemView } from "./suggestions.ts";
import { DownloadKind } from "./versions.ts";
import { WebhookList } from "./webhooks.ts";
import { InvitationList, WorkspaceMemberList, WorkspaceView } from "./workspaces.ts";

/**
 * The version of the manifest's shape; a change that a reader must notice raises it. Format 2
 * added each artifact's `records` file and the space's `spaceRecords` file.
 */
export const EXPORT_MANIFEST_FORMAT = 2;

/** The manifest's file name, at the root of the export folder. */
export const EXPORT_MANIFEST_FILE = "manifest.json";

/**
 * Why something a space holds is not in the export: the caller may not read it (`forbidden`,
 * `plan_required`), it is gone (`not_found`: deleted or being purged while the export ran), or
 * the server asked to wait (`rate_limited`: a later run completes it, so the export exits 1).
 */
export const ExportSkipReason = z.enum(["forbidden", "plan_required", "not_found", "rate_limited"]);
export type ExportSkipReason = z.infer<typeof ExportSkipReason>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const ExportedFile = z.strictObject({
  kind: DownloadKind,
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256,
});
export type ExportedFile = z.infer<typeof ExportedFile>;

export const ExportedVersion = z.strictObject({
  id: z.string().min(1),
  number: z.number().int().min(1),
  current: z.boolean(),
  /** Relative to the export folder, `/`-separated. */
  folder: z.string().min(1),
  files: z.array(ExportedFile),
});
export type ExportedVersion = z.infer<typeof ExportedVersion>;

/** A JSON Lines file of the export, or why it is not there. */
export const ExportedLog = z.union([
  z.strictObject({ file: z.string().min(1), lines: z.number().int().nonnegative() }),
  z.strictObject({ skipped: ExportSkipReason }),
]);
export type ExportedLog = z.infer<typeof ExportedLog>;

/**
 * Why one part of a records file is not there: an export skip reason; `unavailable` when the
 * feature is switched off on this deployment (its read routes answer `capacity_unavailable`;
 * capacity protection never refuses reads); or `dashboard_only` for workspace data that only the dashboard's
 * session may read (members and their addresses, invitations, email domains, service tokens,
 * single sign-on, SCIM, GitHub trust rules, integrations, audit streams, branding and the full
 * policies; AGENTS.md keeps them off bearer routes), which the "Download your data" page exports
 * instead.
 */
export const RecordSkipReason = z.enum([
  ...ExportSkipReason.options,
  "unavailable",
  "dashboard_only",
]);
export type RecordSkipReason = z.infer<typeof RecordSkipReason>;

export const SkippedRecord = z.strictObject({ skipped: RecordSkipReason });
export type SkippedRecord = z.infer<typeof SkippedRecord>;

/** One part of a records file: the API's own body for it, or why it is not there. */
function part<T extends z.ZodType>(view: T) {
  return z.union([SkippedRecord, view]);
}

/**
 * The space's issue and Slack connections as the records hold them: the dashboard's view without
 * `credentialHint` (the credential's last characters), which only the dashboard shows. `identity`
 * (the account the service reported) stays.
 */
export const ExportedIntegrationConnectionList = z.strictObject({
  ...IntegrationConnectionList.shape,
  connections: z.array(
    z.strictObject(IntegrationConnectionView.omit({ credentialHint: true }).shape),
  ),
});
export type ExportedIntegrationConnectionList = z.infer<typeof ExportedIntegrationConnectionList>;

/** The version of the records files' shape; a change that a reader must notice raises it. */
export const RECORDS_FORMAT = 1;

/** Every retained day of an artifact's analytics, oldest first. */
export const ArtifactAnalyticsRecord = z.strictObject({
  retentionDays: z.number().int().positive(),
  from: StatsDate,
  to: StatsDate,
  days: z.array(ArtifactStatsDay),
});
export type ArtifactAnalyticsRecord = z.infer<typeof ArtifactAnalyticsRecord>;

/**
 * Everything about one artifact besides its files and access log, as the exporting person may
 * read it: `artifacts/<id>/records.json` of `portifact export` and the "Records" download of
 * the "Download your data" page, the same shape from both. Each part is the body of the API
 * route that reads it (so its fields are documented there), or why it is not there. Comment
 * threads are those of every version the exporting person sees, under their comment scope;
 * the history has no text.
 */
export const ArtifactRecords = z.strictObject({
  format: z.literal(RECORDS_FORMAT),
  kind: z.literal("artifact"),
  exportedAt: z.iso.datetime(),
  /** `GET /api/v1/artifacts/:id`. */
  artifact: ArtifactSummary,
  /** `GET /api/v1/artifacts/:id/access`: mode, readers (with the share permission), groups, comments, bar. */
  access: part(AccessPolicyView),
  /** `GET /api/v1/artifacts/:id/share-links`: settings only, never a link's secret or password. */
  shareLinks: part(ShareLinkList),
  /** `GET /api/v1/artifacts/:id/review/status`: the request, reviewers, verdicts, notes and history. */
  approvalReview: part(ApprovalReviewView),
  /** `GET /api/v1/artifacts/:id/stats`, every retained day. */
  analytics: part(ArtifactAnalyticsRecord),
  /** `GET /api/v1/artifacts/:id/annotations/export`. */
  comments: part(AnnotationExport),
  /** `GET /api/v1/artifacts/:id/annotations/history`, every page. */
  commentHistory: part(z.array(AnnotationHistoryEntry)),
  /**
   * `GET /api/v1/artifacts/:id/changes`, every item in every state, every page: the owner
   * side's change list (decision 0027); `unavailable` where edit suggestions are switched off.
   */
  changeList: part(z.array(ChangeItemView)),
});
export type ArtifactRecords = z.infer<typeof ArtifactRecords>;

/**
 * Everything about the space itself: `space.json` of `portifact export` and the "Space records"
 * download of the "Download your data" page, the same shape from both. The command fills what
 * bearer routes read and marks the rest `dashboard_only`; the page, with the dashboard's
 * session, fills everything the admin may read. Workspace-only parts are null for a personal
 * space. Secrets are never part of any body: tokens, webhook URLs, credentials and passwords
 * stay out.
 */
export const SpaceRecords = z.strictObject({
  format: z.literal(RECORDS_FORMAT),
  kind: z.literal("space"),
  exportedAt: z.iso.datetime(),
  space: z.strictObject({
    ownerId: z.string().min(1).max(200),
    /** The workspace's slug; null for a personal space. */
    slug: z.string().nullable(),
  }),
  /** The workspace as `GET /api/v1/workspaces` lists it: name, region, role and policies. */
  workspace: part(WorkspaceView).nullable(),
  members: part(WorkspaceMemberList).nullable(),
  invitations: part(InvitationList).nullable(),
  groups: part(WorkspaceGroupList).nullable(),
  /** Each group with its members. */
  groupMembers: part(z.array(WorkspaceGroupDetail)).nullable(),
  emailDomains: part(WorkspaceDomainList).nullable(),
  policies: part(WorkspacePolicyView).nullable(),
  serviceTokens: part(ServiceTokenList).nullable(),
  githubTrust: part(GitHubTrustRuleList).nullable(),
  sso: part(SsoSettings).nullable(),
  scim: part(ScimOverview).nullable(),
  /** The brand's values; the logo itself is its own download on the page. */
  branding: part(BrandSettings),
  webhooks: part(WebhookList),
  /** Without each connection's credential hint. */
  integrations: part(ExportedIntegrationConnectionList),
  auditStreams: part(AuditStreamList),
});
export type SpaceRecords = z.infer<typeof SpaceRecords>;

/** A JSON file of the export, or why it is not there. */
export const ExportedRecordFile = z.union([
  z.strictObject({ file: z.string().min(1) }),
  z.strictObject({ skipped: ExportSkipReason }),
]);
export type ExportedRecordFile = z.infer<typeof ExportedRecordFile>;

export const ExportManifest = z.strictObject({
  format: z.literal(EXPORT_MANIFEST_FORMAT),
  /** The workspace's slug, or `personal`. */
  space: z.string().min(1),
  /** The owner's opaque ID, the same the folder's marker holds. */
  ownerId: z.string().min(1).max(200),
  exportedAt: z.iso.datetime(),
  artifacts: z.array(
    z.strictObject({
      id: ArtifactId,
      name: z.string(),
      versions: z.array(ExportedVersion),
      accessLog: ExportedLog,
      /** `records.json`: settings, access, share links, review, analytics, comments and history. */
      records: ExportedRecordFile,
      /** Set when the artifact (or the rest of its versions) could not be exported, and why. */
      skipped: ExportSkipReason.optional(),
    }),
  ),
  audit: ExportedLog,
  /** `space.json`: the workspace, its groups, policies and webhooks, as bearer routes read them. */
  spaceRecords: ExportedRecordFile,
  totals: z.strictObject({
    artifacts: z.number().int().nonnegative(),
    versions: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  /**
   * False when a part must be fetched later (the run exited 8): the next run resumes this export
   * and keeps the records it already wrote. True closes the export: the next run reads them again.
   */
  complete: z.boolean(),
});
export type ExportManifest = z.infer<typeof ExportManifest>;
