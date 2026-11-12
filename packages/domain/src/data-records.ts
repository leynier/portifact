// What a space's export says about its artifacts and itself besides files and logs: the records
// files of `portifact export` and the "Download your data" page (`ArtifactRecords` and
// `SpaceRecords` in contracts). Both clients assemble them here from the same read routes, so the
// two files never differ in what they hold or how a refusal is recorded. The reads are injected:
// each answers the route's body, or why it is not there (a `SkippedRecord`); any other failure is
// thrown and stops the export. Nothing here reads or writes by itself.
import {
  type AccessPolicyView,
  ANALYTICS,
  type AnnotationExport,
  type AnnotationHistoryEntry,
  type AnnotationHistoryPage,
  type ApprovalReviewView,
  type ArtifactAnalyticsRecord,
  type ArtifactRecords,
  type ArtifactStatsDay,
  type ArtifactStatsView,
  type ArtifactSummary,
  type AuditStreamList,
  type BrandSettings,
  type ExportedIntegrationConnectionList,
  type GitHubTrustRuleList,
  type IntegrationConnectionList,
  type InvitationList,
  RECORDS_FORMAT,
  type ScimOverview,
  type ServiceTokenList,
  type ShareLinkList,
  type SkippedRecord,
  type SpaceRecords,
  type SsoSettings,
  type WebhookList,
  type WorkspaceDomainList,
  type WorkspaceGroupDetail,
  type WorkspaceGroupList,
  type WorkspaceMemberList,
  type WorkspacePolicyView,
  type WorkspaceView,
} from "@portifact/contracts";
import { DAY_MS, formatDay, parseDay } from "./analytics.ts";

/** A route's body, or why it is not in the export. */
export type RecordPart<T> = T | SkippedRecord;

export function isSkipped<T>(part: RecordPart<T>): part is SkippedRecord {
  return typeof part === "object" && part !== null && "skipped" in part;
}

/** The reads one artifact's records come from, each the API route the field documents. */
export interface ArtifactRecordReads {
  access(): Promise<RecordPart<AccessPolicyView>>;
  shareLinks(): Promise<RecordPart<ShareLinkList>>;
  approvalReview(): Promise<RecordPart<ApprovalReviewView>>;
  /** Without a range, the route's default days, which also says how many days the plan keeps. */
  stats(range?: { from: string; to: string }): Promise<RecordPart<ArtifactStatsView>>;
  comments(version: "all" | "current"): Promise<RecordPart<AnnotationExport>>;
  commentHistory(cursor: string | undefined): Promise<RecordPart<AnnotationHistoryPage>>;
}

/**
 * The ranges, oldest first and each at most `ANALYTICS.maxRangeDays` long, that cover every day
 * a plan keeping `retentionDays` holds up to `to` (the server's today).
 */
export function statsWindows(to: string, retentionDays: number): { from: string; to: string }[] {
  const last = parseDay(to);
  const first = last - retentionDays * DAY_MS;
  const windows: { from: string; to: string }[] = [];
  for (let start = first; start <= last; start += ANALYTICS.maxRangeDays * DAY_MS) {
    const end = Math.min(last, start + (ANALYTICS.maxRangeDays - 1) * DAY_MS);
    windows.push({ from: formatDay(start), to: formatDay(end) });
  }
  return windows;
}

async function analyticsRecord(
  reads: ArtifactRecordReads,
): Promise<RecordPart<ArtifactAnalyticsRecord>> {
  const first = await reads.stats();
  if (isSkipped(first)) return first;
  const days = new Map<string, ArtifactStatsDay>();
  for (const window of statsWindows(first.to, first.retentionDays)) {
    const page = await reads.stats(window);
    if (isSkipped(page)) return page;
    for (const day of page.days) days.set(day.date, day);
  }
  const all = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    retentionDays: first.retentionDays,
    from: all[0]?.date ?? first.from,
    to: all.at(-1)?.date ?? first.to,
    days: all,
  };
}

/**
 * Threads of every version for the owner side; anyone else sees only the current version's, so
 * a refusal of every version falls back to those.
 */
async function commentsRecord(reads: ArtifactRecordReads): Promise<RecordPart<AnnotationExport>> {
  const all = await reads.comments("all");
  if (isSkipped(all) && all.skipped === "forbidden") return reads.comments("current");
  return all;
}

async function historyRecord(
  reads: ArtifactRecordReads,
): Promise<RecordPart<AnnotationHistoryEntry[]>> {
  const entries: AnnotationHistoryEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await reads.commentHistory(cursor);
    if (isSkipped(page)) return page;
    entries.push(...page.entries);
    if (page.nextCursor === null || page.entries.length === 0) return entries;
    cursor = page.nextCursor;
  }
}

/** One artifact's records, read one route after another. */
export async function collectArtifactRecords(
  artifact: ArtifactSummary,
  reads: ArtifactRecordReads,
  now: number,
): Promise<ArtifactRecords> {
  return {
    format: RECORDS_FORMAT,
    kind: "artifact",
    exportedAt: new Date(now).toISOString(),
    artifact,
    access: await reads.access(),
    shareLinks: await reads.shareLinks(),
    approvalReview: await reads.approvalReview(),
    analytics: await analyticsRecord(reads),
    comments: await commentsRecord(reads),
    commentHistory: await historyRecord(reads),
  };
}

/**
 * The reads a space's records come from. A client that may not use a route answers
 * `{ skipped: "dashboard_only" }` for it; the workspace-only reads are not called for a personal
 * space.
 */
export interface SpaceRecordReads {
  workspace(): Promise<RecordPart<WorkspaceView>>;
  members(): Promise<RecordPart<WorkspaceMemberList>>;
  invitations(): Promise<RecordPart<InvitationList>>;
  groups(): Promise<RecordPart<WorkspaceGroupList>>;
  /** One group with its members. */
  group(groupId: string): Promise<RecordPart<WorkspaceGroupDetail>>;
  emailDomains(): Promise<RecordPart<WorkspaceDomainList>>;
  policies(): Promise<RecordPart<WorkspacePolicyView>>;
  serviceTokens(): Promise<RecordPart<ServiceTokenList>>;
  githubTrust(): Promise<RecordPart<GitHubTrustRuleList>>;
  sso(): Promise<RecordPart<SsoSettings>>;
  scim(): Promise<RecordPart<ScimOverview>>;
  branding(): Promise<RecordPart<BrandSettings>>;
  webhooks(): Promise<RecordPart<WebhookList>>;
  integrations(): Promise<RecordPart<IntegrationConnectionList>>;
  auditStreams(): Promise<RecordPart<AuditStreamList>>;
}

async function groupMembersRecord(
  reads: SpaceRecordReads,
  groups: RecordPart<WorkspaceGroupList>,
): Promise<RecordPart<WorkspaceGroupDetail[]>> {
  if (isSkipped(groups)) return groups;
  const details: WorkspaceGroupDetail[] = [];
  for (const group of groups.items) {
    const detail = await reads.group(group.id);
    // A group removed while the export ran is simply not there; any other refusal covers all.
    if (isSkipped(detail)) {
      if (detail.skipped === "not_found") continue;
      return detail;
    }
    details.push(detail);
  }
  return details;
}

/** The connections without the credential hints the dashboard shows (never in a file). */
function withoutCredentialHints(
  list: RecordPart<IntegrationConnectionList>,
): RecordPart<ExportedIntegrationConnectionList> {
  if (isSkipped(list)) return list;
  return {
    ...list,
    connections: list.connections.map(({ credentialHint: _, ...connection }) => connection),
  };
}

/** The space's records; `slug` is null for a personal space. */
export async function collectSpaceRecords(
  space: { ownerId: string; slug: string | null },
  reads: SpaceRecordReads,
  now: number,
): Promise<SpaceRecords> {
  const workspace = space.slug !== null;
  const only = async <T>(read: () => Promise<RecordPart<T>>) => (workspace ? read() : null);
  const groups = await only(() => reads.groups());
  return {
    format: RECORDS_FORMAT,
    kind: "space",
    exportedAt: new Date(now).toISOString(),
    space,
    workspace: await only(() => reads.workspace()),
    members: await only(() => reads.members()),
    invitations: await only(() => reads.invitations()),
    groups,
    groupMembers: groups === null ? null : await groupMembersRecord(reads, groups),
    emailDomains: await only(() => reads.emailDomains()),
    policies: await only(() => reads.policies()),
    serviceTokens: await only(() => reads.serviceTokens()),
    githubTrust: await only(() => reads.githubTrust()),
    sso: await only(() => reads.sso()),
    scim: await only(() => reads.scim()),
    branding: await reads.branding(),
    webhooks: await reads.webhooks(),
    integrations: withoutCredentialHints(await reads.integrations()),
    auditStreams: await reads.auditStreams(),
  };
}

/** Whether any part of a records file asked to be fetched again later. */
export function recordsRetryLater(records: ArtifactRecords | SpaceRecords): boolean {
  return Object.values(records).some(
    (value) => value !== null && isSkipped(value) && value.skipped === "rate_limited",
  );
}
