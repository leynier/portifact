// Same-origin calls from the dashboard to /api/v1 and the session endpoints under /api/auth.
// The browser sends the session cookie, fetch metadata and the Origin header, which the Worker
// checks (apps/app/src/api/access.ts). Every response is validated with the shared contracts.
import {
  AccessLogView,
  AccessPolicyView,
  type AccessUpdate,
  AccountDeletionResult,
  AccountSettings,
  type AccountSettingsUpdate,
  AccountUsageView,
  AnnotationDeleteResult,
  AnnotationEditResult,
  AnnotationExport,
  type AnnotationExportQuery,
  AnnotationModeView,
  AnnotationPage,
  type AnnotationsState,
  AnnotationThreadView,
  type AnnotationVersionFilter,
  ApiError,
  type ApprovalChangeInput,
  type ApprovalRequestInput,
  ApprovalReviewView,
  type ApprovalVerdictInput,
  ArtifactList,
  type ArtifactListFilters,
  ArtifactStatsView,
  ArtifactSummary,
  AUDIT_EXPORT_CURSOR_HEADER,
  type AuditExportFormat,
  type AuditKind,
  AuditLogView,
  BrandSettings,
  type BrandUpdate,
  BrowserSessionList,
  CommentNoticeMute,
  CommittedPublish,
  ConnectedAppList,
  type CreateThreadRequest,
  CustomDomainList,
  CustomDomainRemoved,
  CustomDomainView,
  DisconnectResult,
  DocumentPreview,
  type DocumentPreviewRequest,
  type DownloadKind,
  type EditMessageRequest,
  type ErrorCode,
  FileDiff,
  IncomingInvitationList,
  InvitationList,
  InvitationLookup,
  InvitationView,
  LifecycleResult,
  PolicyImpact,
  PreparedPublish,
  type PublishRequest,
  ReviewStart,
  ReviewTabStart,
  type RollbackRequest,
  RolledBack,
  SearchResults,
  type ServiceTokenCreate,
  ServiceTokenCreated,
  ServiceTokenList,
  ShareLinkCreated,
  ShareLinkList,
  ShareLinkRevoked,
  SignOutOthersResult,
  type SsoProviderInput,
  SsoSettings,
  SsoTestResult,
  type UploadedPart,
  VersionComparison,
  VersionDownload,
  VersionList,
  VersionManifest,
  ViewerInfo,
  type WebhookCreate,
  WebhookCreated,
  WebhookDeliveries,
  WebhookList,
  WebhookRemoved,
  WebhookTestQueued,
  type WebhookUpdate,
  WebhookView,
  WorkspaceDomainList,
  WorkspaceDomainView,
  WorkspaceGroupDetail,
  WorkspaceGroupList,
  WorkspaceGroupView,
  WorkspaceList,
  WorkspaceMemberList,
  WorkspaceMemberView,
  type WorkspacePolicy,
  WorkspacePolicyView,
  type WorkspaceRole,
  WorkspaceView,
} from "@portifact/contracts";
import { z } from "zod";
import type { SavedFile } from "./publish/download.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Why a call failed: a documented API error code, no network, or an answer we do not know. */
export type FailureCode = ErrorCode | "network" | "unexpected";

export class ApiFailure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly status: number,
  ) {
    super(code);
    this.name = "ApiFailure";
  }
}

/** Filters and the page of an audit log request. */
export interface AuditPageQuery {
  kinds?: readonly AuditKind[] | undefined;
  actor?: string | undefined;
  /** ISO date and time: only events at or after it. */
  from?: string | undefined;
  cursor?: string | undefined;
}

export type LifecycleAction = "renew" | "archive" | "restore" | "delete" | "pin" | "unpin";

export interface Account {
  email: string;
  name: string;
  /** When the account was created (ISO), which decides when it may publish in public. */
  createdAt: string | null;
}

/** A way to sign in to the account besides an email code, such as Google or GitHub. */
export interface SignInMethod {
  provider: string;
  connectedAt: string;
}

export interface DashboardApi {
  /** The signed-in account, or null without a session. */
  account(): Promise<Account | null>;
  signOut(): Promise<void>;
  /**
   * A page of the space's artifacts that match `filters`; the API applies them. `workspace` names
   * a workspace by slug, the personal space without it.
   */
  listArtifacts(
    cursor?: string,
    filters?: ArtifactListFilters,
    workspace?: string,
  ): Promise<ArtifactList>;
  getArtifact(artifactId: string): Promise<ArtifactSummary>;
  /** Searches inside the text of a space's artifacts (premium plan T8). */
  searchContent(query: string, cursor?: string, workspace?: string): Promise<SearchResults>;
  lifecycle(artifactId: string, action: LifecycleAction): Promise<LifecycleResult>;
  getAccess(artifactId: string): Promise<AccessPolicyView>;
  updateAccess(artifactId: string, change: AccessUpdate): Promise<AccessPolicyView>;
  signInMethods(): Promise<SignInMethod[]>;
  browserSessions(): Promise<BrowserSessionList>;
  signOutOtherSessions(): Promise<SignOutOthersResult>;
  connectedApps(): Promise<ConnectedAppList>;
  disconnectApp(clientId: string): Promise<DisconnectResult>;
  /** The defaults new artifacts start with. */
  accountSettings(): Promise<AccountSettings>;
  updateAccountSettings(update: AccountSettingsUpdate): Promise<AccountSettings>;
  /** The brand of a space on the viewer's bar, and whether its plan includes it. */
  brandSettings(workspace?: string): Promise<BrandSettings>;
  updateBrand(update: BrandUpdate, workspace?: string): Promise<BrandSettings>;
  deleteBrand(workspace?: string): Promise<BrandSettings>;
  /** Sends the logo file's bytes as they are; the server judges them. */
  uploadBrandLogo(file: Blob, workspace?: string): Promise<BrandSettings>;
  removeBrandLogo(workspace?: string): Promise<BrandSettings>;
  /** Whether the artifact's owner has comment notices, and whether the caller muted it. */
  commentNoticeMute(artifactId: string): Promise<CommentNoticeMute>;
  /** Mutes or unmutes the artifact's comment notices for the caller. */
  setCommentNoticeMute(artifactId: string, muted: boolean): Promise<CommentNoticeMute>;
  /** Deletes the account; the email typed again confirms it. */
  deleteAccount(confirmEmail: string): Promise<AccountDeletionResult>;
  /** A space's quotas, this month's traffic and what blocks it now. */
  usage(workspace?: string): Promise<AccountUsageView>;
  /** The caller's workspaces and role in each. */
  workspaces(): Promise<WorkspaceList>;
  /** A workspace's members and seats (session only). */
  members(slug: string): Promise<WorkspaceMemberList>;
  /** A workspace's service tokens, for its admins (session only, decision 0011). */
  serviceTokens(slug: string): Promise<ServiceTokenList>;
  /** Creates a service token; the answer holds its secret once. */
  createServiceToken(slug: string, body: ServiceTokenCreate): Promise<ServiceTokenCreated>;
  revokeServiceToken(slug: string, tokenId: string): Promise<void>;
  /** A workspace's groups: names and member counts (admins and editors, decision 0014). */
  groups(slug: string): Promise<WorkspaceGroupList>;
  /** One group with its members, for admins (session only). */
  group(slug: string, groupId: string): Promise<WorkspaceGroupDetail>;
  createGroup(slug: string, name: string): Promise<WorkspaceGroupView>;
  renameGroup(slug: string, groupId: string, name: string): Promise<WorkspaceGroupView>;
  deleteGroup(slug: string, groupId: string): Promise<void>;
  addGroupMember(slug: string, groupId: string, userId: string): Promise<WorkspaceGroupDetail>;
  removeGroupMember(slug: string, groupId: string, userId: string): Promise<void>;
  /** A workspace's policies (decision 0015): every member reads them, only admins change them. */
  policies(slug: string): Promise<WorkspacePolicyView>;
  /** What saving a policy would change on the existing artifacts. */
  previewPolicies(slug: string, policy: WorkspacePolicy): Promise<PolicyImpact>;
  savePolicies(
    slug: string,
    update: { policy: WorkspacePolicy; revision: number; confirmed?: PolicyImpact },
  ): Promise<WorkspacePolicyView>;
  changeMemberRole(slug: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMemberView>;
  removeMember(slug: string, userId: string): Promise<void>;
  leaveWorkspace(slug: string): Promise<void>;
  /** A workspace's pending invitations, for its admins. */
  invitations(slug: string): Promise<InvitationList>;
  /** Invites an address, or invites it again: a new invitation replaces the pending one. */
  invite(slug: string, email: string, role: WorkspaceRole): Promise<InvitationView>;
  revokeInvitation(slug: string, invitationId: string): Promise<void>;
  /** A workspace's email domains, for its admins (decision 0010). */
  workspaceDomains(slug: string): Promise<WorkspaceDomainList>;
  /** Claims a domain: answers it with the TXT record to publish. */
  addWorkspaceDomain(slug: string, domain: string): Promise<WorkspaceDomainView>;
  /** Looks the TXT record up and verifies the claim. */
  verifyWorkspaceDomain(slug: string, domainId: string): Promise<WorkspaceDomainView>;
  removeWorkspaceDomain(slug: string, domainId: string): Promise<void>;
  /** A workspace's single sign-on settings, for its admins (decision 0016). */
  sso(slug: string): Promise<SsoSettings>;
  /** Creates or changes the provider; the secret may be omitted on a change. */
  saveSso(slug: string, input: SsoProviderInput): Promise<SsoSettings>;
  removeSso(slug: string): Promise<void>;
  /** Runs discovery for an issuer and says what failed; stores nothing. */
  testSso(slug: string, issuer: string): Promise<SsoTestResult>;
  /** The invitations addressed to the signed-in account. */
  incomingInvitations(): Promise<IncomingInvitationList>;
  /** Accepts (answering the workspace joined) or declines one of them. */
  answerInvitation(
    invitationId: string,
    decision: "accept" | "decline",
  ): Promise<WorkspaceView | null>;
  /** What an invitation link's token names, for the signed-in account. */
  lookupInvitation(token: string): Promise<InvitationLookup>;
  answerInvitationLink(
    token: string,
    decision: "accept" | "decline",
  ): Promise<WorkspaceView | null>;
  /** Moves an artifact to a workspace, or to the personal space with `null`. */
  transferArtifact(artifactId: string, workspace: string | null): Promise<ArtifactSummary>;
  /** A space's webhooks (decision 0009): the personal space, or a workspace by slug. */
  webhooks(workspace: string | undefined): Promise<WebhookList>;
  /** Adds a webhook; the answer holds its signing secret once. */
  createWebhook(webhook: WebhookCreate, workspace: string | undefined): Promise<WebhookCreated>;
  updateWebhook(
    webhookId: string,
    update: WebhookUpdate,
    workspace: string | undefined,
  ): Promise<WebhookView>;
  removeWebhook(webhookId: string, workspace: string | undefined): Promise<WebhookRemoved>;
  testWebhook(webhookId: string, workspace: string | undefined): Promise<WebhookTestQueued>;
  webhookDeliveries(webhookId: string, workspace: string | undefined): Promise<WebhookDeliveries>;
  /** The artifact's share links that are not revoked, never with their URL. */
  listShareLinks(artifactId: string): Promise<ShareLinkList>;
  /** Creates a share link; the answer holds its URL, the only time it is ever shown. */
  createShareLink(
    artifactId: string,
    input: { label: string; expiresAt?: string; password?: string },
  ): Promise<ShareLinkCreated>;
  revokeShareLink(artifactId: string, linkId: string): Promise<ShareLinkRevoked>;
  /** The approval review as the caller may see it (decision 0013). */
  getReview(artifactId: string): Promise<ApprovalReviewView>;
  requestReview(
    artifactId: string,
    input: ApprovalRequestInput,
    idempotencyKey: string,
  ): Promise<ApprovalReviewView>;
  changeReview(
    artifactId: string,
    input: ApprovalChangeInput,
    idempotencyKey: string,
  ): Promise<ApprovalReviewView>;
  cancelReview(artifactId: string): Promise<ApprovalReviewView>;
  /** A requested reviewer's verdict on the version they saw. */
  submitVerdict(
    artifactId: string,
    input: ApprovalVerdictInput,
    idempotencyKey: string,
  ): Promise<ApprovalReviewView>;
  /** The artifact's custom domain and pending ones, with its owner's plan. */
  artifactDomains(artifactId: string): Promise<CustomDomainList>;
  /** Claims a hostname for the artifact; retrying with the same key answers the same claim. */
  addDomain(
    artifactId: string,
    hostname: string,
    idempotencyKey: string,
  ): Promise<CustomDomainView>;
  /** Checks a domain's DNS records and certificate again. */
  verifyDomain(hostname: string): Promise<CustomDomainView>;
  removeDomain(hostname: string): Promise<CustomDomainRemoved>;
  /** A page of the artifact's access log, newest first; only its owner may read it. */
  accessLog(artifactId: string, cursor?: string, limit?: number): Promise<AccessLogView>;
  /** A page of the space's audit log (`GET /api/v1/audit`), newest first. */
  audit(workspace: string | undefined, query: AuditPageQuery): Promise<AuditLogView>;
  /**
   * One part of an export of the space's audit log (`GET /api/v1/audit/export`) as text, and the
   * cursor of the next part (`Portifact-Next-Cursor`), null after the last.
   */
  auditExport(
    workspace: string | undefined,
    format: AuditExportFormat,
    query: AuditPageQuery,
  ): Promise<{ text: string; nextCursor: string | null }>;
  /** Views per UTC day from `from` (YYYY-MM-DD) to today; on the owner's plan with analytics. */
  stats(artifactId: string, from?: string): Promise<ArtifactStatsView>;
  /**
   * Starts a publish; retrying with the same key returns the same upload. A new artifact goes to
   * `workspace`, or the personal space without it; a new version stays where its artifact is.
   */
  preparePublish(
    request: PublishRequest,
    idempotencyKey: string,
    workspace?: string,
  ): Promise<PreparedPublish>;
  /** An open upload with fresh URLs for the objects still to send. */
  uploadProgress(uploadId: string): Promise<PreparedPublish>;
  /** A part of a multipart object reached storage, with the ETag storage answered. */
  reportPart(uploadId: string, part: UploadedPart): Promise<void>;
  commitPublish(uploadId: string): Promise<CommittedPublish>;
  abortPublish(uploadId: string): Promise<void>;
  listVersions(artifactId: string, cursor?: string): Promise<VersionList>;
  versionManifest(artifactId: string, versionId: string): Promise<VersionManifest>;
  versionDownload(
    artifactId: string,
    versionId: string,
    kind: DownloadKind,
    path?: string,
  ): Promise<VersionDownload>;
  rollback(
    artifactId: string,
    request: RollbackRequest,
    idempotencyKey: string,
  ): Promise<RolledBack>;
  compareVersions(
    artifactId: string,
    fromVersionId: string,
    toVersionId: string,
    cursor?: string,
  ): Promise<VersionComparison>;
  fileDiff(
    artifactId: string,
    fromVersionId: string,
    toVersionId: string,
    file: { kind: DownloadKind; path: string },
    cursor?: number,
  ): Promise<FileDiff>;
  previewDocument(request: DocumentPreviewRequest): Promise<DocumentPreview>;
  /**
   * What the viewer's bar shows about the artifact and who is looking; works without a session
   * for public artifacts and answers `not_found` for anything an anonymous visitor cannot see.
   */
  viewerInfo(artifactId: string): Promise<ViewerInfo>;
  /** A one-use review code and the URL the viewer's iframe opens with it. */
  startReview(artifactId: string): Promise<ReviewStart>;
  /** A one-use code and the link that opens the artifact in a top-level review tab. */
  startReviewTab(artifactId: string): Promise<ReviewTabStart>;
  /**
   * A page of the threads of `version` (the current one by default; other versions only for the
   * owner); with `cursor`, only what changed since.
   */
  listAnnotations(
    artifactId: string,
    cursor?: string,
    version?: AnnotationVersionFilter,
  ): Promise<AnnotationPage>;
  /** The threads as the file `portifact annotations export` writes, JSON or Markdown. */
  exportAnnotations(
    artifactId: string,
    query: Pick<AnnotationExportQuery, "format" | "version"> &
      Partial<Pick<AnnotationExportQuery, "state">>,
  ): Promise<SavedFile>;
  createThread(
    artifactId: string,
    request: CreateThreadRequest,
    idempotencyKey: string,
  ): Promise<AnnotationThreadView>;
  reply(
    artifactId: string,
    threadId: string,
    body: string,
    idempotencyKey: string,
    turnstileToken?: string,
  ): Promise<AnnotationThreadView>;
  setThreadState(
    artifactId: string,
    threadId: string,
    state: "open" | "resolved",
  ): Promise<AnnotationThreadView>;
  /** Edits your own message, from the revision you saw; another revision is a conflict. */
  editMessage(
    artifactId: string,
    messageId: string,
    request: EditMessageRequest,
  ): Promise<AnnotationEditResult>;
  moderateMessage(
    artifactId: string,
    messageId: string,
    action: "hide" | "unhide" | "delete",
  ): Promise<AnnotationDeleteResult>;
  deleteThread(artifactId: string, threadId: string): Promise<void>;
  setAnnotationMode(artifactId: string, mode: AnnotationsState): Promise<AnnotationModeView>;
}

/** The brand of a space (session only). */
export const BRAND_PATH = "/api/v1/account/branding";

/** `?workspace=<slug>` for an owner-scoped path, or nothing for the personal space. */
function inSpace(path: string, workspace: string | undefined): string {
  if (!workspace) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ workspace })}`;
}

/** The stored logo for the Branding page's preview, versioned by its hash for the cache. */
export function brandLogoPreview(sha256: string, workspace?: string): string {
  return inSpace(`${BRAND_PATH}/logo?v=${sha256}`, workspace);
}

const workspacePath = (slug: string) => `/api/v1/workspaces/${encodeURIComponent(slug)}`;

/** The account's data as a JSON download (a plain link: the browser saves the attachment). */
export const ACCOUNT_EXPORT_PATH = "/api/v1/account/export";

const SessionBody = z.object({
  user: z.object({
    email: z.string(),
    name: z.string().nullish(),
    createdAt: z.string().nullish(),
  }),
});

// Better Auth's /list-accounts: one row per linked provider. Only what the page shows is kept.
const AccountsBody = z.array(z.object({ providerId: z.string(), createdAt: z.string() }));

export interface DashboardApiOptions {
  fetch: FetchLike;
  /** Called when the session is gone, so the page can send the user to sign in. */
  onUnauthenticated(): void;
}

export function dashboardApi({ fetch, onUnauthenticated }: DashboardApiOptions): DashboardApi {
  const call = async <T>(
    path: string,
    schema: z.ZodType<T>,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" = "GET",
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : {
                "content-type":
                  payload instanceof Blob ? "application/octet-stream" : "application/json",
              }),
          ...extraHeaders,
        },
        ...(payload === undefined
          ? {}
          : { body: payload instanceof Blob ? payload : JSON.stringify(payload) }),
      });
    } catch {
      throw new ApiFailure("network", 0);
    }
    // Successful text answers (the Markdown export) are read as text; everything else is JSON.
    const isText = response.ok && /^text\//.test(response.headers.get("content-type") ?? "");
    const body = await (isText ? response.text() : response.json()).catch(() => null);
    if (response.ok) {
      const parsed = schema.safeParse(body);
      if (parsed.success) return parsed.data;
      throw new ApiFailure("unexpected", response.status);
    }
    if (response.status === 401) {
      onUnauthenticated();
      throw new ApiFailure("unauthenticated", 401);
    }
    const error = ApiError.safeParse(body);
    throw new ApiFailure(error.success ? error.data.error.code : "unexpected", response.status);
  };

  return {
    async account() {
      const session = await call("/api/auth/get-session", SessionBody.nullable());
      return session
        ? {
            email: session.user.email,
            name: session.user.name ?? "",
            createdAt: session.user.createdAt ?? null,
          }
        : null;
    },
    async signOut() {
      let response: Response;
      try {
        response = await fetch("/api/auth/sign-out", {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: "{}",
        });
      } catch {
        throw new ApiFailure("network", 0);
      }
      if (!response.ok) throw new ApiFailure("unexpected", response.status);
    },
    listArtifacts(cursor, filters = {}, workspace) {
      const params = new URLSearchParams();
      if (workspace) params.set("workspace", workspace);
      if (cursor) params.set("cursor", cursor);
      for (const [name, value] of Object.entries(filters)) {
        if (typeof value === "string" && value !== "") params.set(name, value);
      }
      const query = params.size > 0 ? `?${params}` : "";
      return call(`/api/v1/artifacts${query}`, ArtifactList);
    },
    getArtifact(artifactId) {
      return call(`/api/v1/artifacts/${encodeURIComponent(artifactId)}`, ArtifactSummary);
    },
    searchContent(query, cursor, workspace) {
      const params = new URLSearchParams({ q: query });
      if (workspace) params.set("workspace", workspace);
      if (cursor) params.set("cursor", cursor);
      return call(`/api/v1/search?${params}`, SearchResults);
    },
    lifecycle(artifactId, action) {
      const base = `/api/v1/artifacts/${encodeURIComponent(artifactId)}`;
      return action === "delete"
        ? call(base, LifecycleResult, "DELETE")
        : call(`${base}/${action}`, LifecycleResult, "POST");
    },
    getAccess(artifactId) {
      return call(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/access`, AccessPolicyView);
    },
    updateAccess(artifactId, change) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/access`,
        AccessPolicyView,
        "PATCH",
        change,
      );
    },
    async signInMethods() {
      const accounts = await call("/api/auth/list-accounts", AccountsBody);
      return accounts.map((a) => ({ provider: a.providerId, connectedAt: a.createdAt }));
    },
    browserSessions() {
      return call("/api/v1/account/sessions", BrowserSessionList);
    },
    signOutOtherSessions() {
      return call("/api/v1/account/sessions/sign-out-others", SignOutOthersResult, "POST");
    },
    connectedApps() {
      return call("/api/v1/account/apps", ConnectedAppList);
    },
    disconnectApp(clientId) {
      return call(
        `/api/v1/account/apps/${encodeURIComponent(clientId)}`,
        DisconnectResult,
        "DELETE",
      );
    },
    accountSettings() {
      return call("/api/v1/account/settings", AccountSettings);
    },
    updateAccountSettings(update) {
      return call("/api/v1/account/settings", AccountSettings, "PATCH", update);
    },
    brandSettings(workspace) {
      return call(inSpace(BRAND_PATH, workspace), BrandSettings);
    },
    updateBrand(update, workspace) {
      return call(inSpace(BRAND_PATH, workspace), BrandSettings, "PUT", update);
    },
    deleteBrand(workspace) {
      return call(inSpace(BRAND_PATH, workspace), BrandSettings, "DELETE");
    },
    uploadBrandLogo(file, workspace) {
      return call(inSpace(`${BRAND_PATH}/logo`, workspace), BrandSettings, "PUT", file);
    },
    removeBrandLogo(workspace) {
      return call(inSpace(`${BRAND_PATH}/logo`, workspace), BrandSettings, "DELETE");
    },
    webhooks(workspace) {
      return call(inSpace("/api/v1/webhooks", workspace), WebhookList);
    },
    createWebhook(webhook, workspace) {
      return call(inSpace("/api/v1/webhooks", workspace), WebhookCreated, "POST", webhook);
    },
    updateWebhook(webhookId, update, workspace) {
      return call(
        inSpace(`/api/v1/webhooks/${encodeURIComponent(webhookId)}`, workspace),
        WebhookView,
        "PATCH",
        update,
      );
    },
    removeWebhook(webhookId, workspace) {
      return call(
        inSpace(`/api/v1/webhooks/${encodeURIComponent(webhookId)}`, workspace),
        WebhookRemoved,
        "DELETE",
      );
    },
    testWebhook(webhookId, workspace) {
      return call(
        inSpace(`/api/v1/webhooks/${encodeURIComponent(webhookId)}/test`, workspace),
        WebhookTestQueued,
        "POST",
      );
    },
    webhookDeliveries(webhookId, workspace) {
      return call(
        inSpace(`/api/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries`, workspace),
        WebhookDeliveries,
      );
    },
    commentNoticeMute(artifactId) {
      return call(
        `/api/v1/account/comment-notices/${encodeURIComponent(artifactId)}`,
        CommentNoticeMute,
      );
    },
    setCommentNoticeMute(artifactId, muted) {
      return call(
        `/api/v1/account/comment-notices/${encodeURIComponent(artifactId)}`,
        CommentNoticeMute,
        "PUT",
        { muted },
      );
    },
    deleteAccount(confirmEmail) {
      return call("/api/v1/account/delete", AccountDeletionResult, "POST", { confirmEmail });
    },
    usage(workspace) {
      return call(inSpace("/api/v1/usage", workspace), AccountUsageView);
    },
    workspaces() {
      return call("/api/v1/workspaces", WorkspaceList);
    },
    members(slug) {
      return call(`${workspacePath(slug)}/members`, WorkspaceMemberList);
    },
    serviceTokens(slug) {
      return call(`${workspacePath(slug)}/service-tokens`, ServiceTokenList);
    },
    createServiceToken(slug, body) {
      return call(`${workspacePath(slug)}/service-tokens`, ServiceTokenCreated, "POST", body);
    },
    policies(slug) {
      return call(`${workspacePath(slug)}/policies`, WorkspacePolicyView);
    },
    previewPolicies(slug, policy) {
      return call(`${workspacePath(slug)}/policies/preview`, PolicyImpact, "POST", { policy });
    },
    savePolicies(slug, update) {
      return call(`${workspacePath(slug)}/policies`, WorkspacePolicyView, "PUT", update);
    },
    groups(slug) {
      return call(`${workspacePath(slug)}/groups`, WorkspaceGroupList);
    },
    group(slug, groupId) {
      return call(
        `${workspacePath(slug)}/groups/${encodeURIComponent(groupId)}`,
        WorkspaceGroupDetail,
      );
    },
    createGroup(slug, name) {
      return call(`${workspacePath(slug)}/groups`, WorkspaceGroupView, "POST", { name });
    },
    renameGroup(slug, groupId, name) {
      return call(
        `${workspacePath(slug)}/groups/${encodeURIComponent(groupId)}`,
        WorkspaceGroupView,
        "PATCH",
        { name },
      );
    },
    async deleteGroup(slug, groupId) {
      await call(
        `${workspacePath(slug)}/groups/${encodeURIComponent(groupId)}`,
        z.null(),
        "DELETE",
      );
    },
    addGroupMember(slug, groupId, userId) {
      return call(
        `${workspacePath(slug)}/groups/${encodeURIComponent(groupId)}/members`,
        WorkspaceGroupDetail,
        "POST",
        { userId },
      );
    },
    async removeGroupMember(slug, groupId, userId) {
      await call(
        `${workspacePath(slug)}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
        z.null(),
        "DELETE",
      );
    },
    async revokeServiceToken(slug, tokenId) {
      await call(
        `${workspacePath(slug)}/service-tokens/${encodeURIComponent(tokenId)}`,
        z.null(),
        "DELETE",
      );
    },
    changeMemberRole(slug, userId, role) {
      return call(
        `${workspacePath(slug)}/members/${encodeURIComponent(userId)}`,
        WorkspaceMemberView,
        "PATCH",
        { role },
      );
    },
    async removeMember(slug, userId) {
      await call(
        `${workspacePath(slug)}/members/${encodeURIComponent(userId)}`,
        z.null(),
        "DELETE",
      );
    },
    async leaveWorkspace(slug) {
      await call(`${workspacePath(slug)}/leave`, z.null(), "POST");
    },
    invitations(slug) {
      return call(`${workspacePath(slug)}/invitations`, InvitationList);
    },
    invite(slug, email, role) {
      return call(`${workspacePath(slug)}/invitations`, InvitationView, "POST", { email, role });
    },
    async revokeInvitation(slug, invitationId) {
      await call(
        `${workspacePath(slug)}/invitations/${encodeURIComponent(invitationId)}`,
        z.null(),
        "DELETE",
      );
    },
    workspaceDomains(slug) {
      return call(`${workspacePath(slug)}/domains`, WorkspaceDomainList);
    },
    addWorkspaceDomain(slug, domain) {
      return call(`${workspacePath(slug)}/domains`, WorkspaceDomainView, "POST", { domain });
    },
    verifyWorkspaceDomain(slug, domainId) {
      return call(
        `${workspacePath(slug)}/domains/${encodeURIComponent(domainId)}/verify`,
        WorkspaceDomainView,
        "POST",
      );
    },
    async removeWorkspaceDomain(slug, domainId) {
      await call(
        `${workspacePath(slug)}/domains/${encodeURIComponent(domainId)}`,
        z.object({ id: z.string(), removed: z.literal(true) }),
        "DELETE",
      );
    },
    sso(slug) {
      return call(`${workspacePath(slug)}/sso`, SsoSettings);
    },
    saveSso(slug, input) {
      return call(`${workspacePath(slug)}/sso`, SsoSettings, "PUT", input);
    },
    async removeSso(slug) {
      await call(`${workspacePath(slug)}/sso`, z.object({ removed: z.literal(true) }), "DELETE");
    },
    testSso(slug, issuer) {
      return call(`${workspacePath(slug)}/sso/test`, SsoTestResult, "POST", { issuer });
    },
    incomingInvitations() {
      return call("/api/v1/account/invitations", IncomingInvitationList);
    },
    answerInvitation(invitationId, decision) {
      return call(
        `/api/v1/account/invitations/${encodeURIComponent(invitationId)}/${decision}`,
        decision === "accept" ? WorkspaceView : z.null(),
        "POST",
      );
    },
    lookupInvitation(token) {
      return call("/api/v1/invitations/lookup", InvitationLookup, "POST", { token });
    },
    answerInvitationLink(token, decision) {
      return call(
        `/api/v1/invitations/${decision}`,
        decision === "accept" ? WorkspaceView : z.null(),
        "POST",
        { token },
      );
    },
    transferArtifact(artifactId, workspace) {
      return call(`${artifactPath(artifactId)}/transfer`, ArtifactSummary, "POST", { workspace });
    },
    listShareLinks(artifactId) {
      return call(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/share-links`, ShareLinkList);
    },
    createShareLink(artifactId, input) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/share-links`,
        ShareLinkCreated,
        "POST",
        input,
      );
    },
    revokeShareLink(artifactId, linkId) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/share-links/${encodeURIComponent(linkId)}`,
        ShareLinkRevoked,
        "DELETE",
      );
    },
    getReview(artifactId) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/review/status`,
        ApprovalReviewView,
      );
    },
    requestReview(artifactId, input, idempotencyKey) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/review/request`,
        ApprovalReviewView,
        "POST",
        input,
        { "idempotency-key": idempotencyKey },
      );
    },
    changeReview(artifactId, input, idempotencyKey) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/review/request`,
        ApprovalReviewView,
        "PATCH",
        input,
        { "idempotency-key": idempotencyKey },
      );
    },
    cancelReview(artifactId) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/review/request`,
        ApprovalReviewView,
        "DELETE",
      );
    },
    submitVerdict(artifactId, input, idempotencyKey) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/review/verdict`,
        ApprovalReviewView,
        "POST",
        input,
        { "idempotency-key": idempotencyKey },
      );
    },
    artifactDomains(artifactId) {
      return call(
        `/api/v1/domains?${new URLSearchParams({ artifactId }).toString()}`,
        CustomDomainList,
      );
    },
    addDomain(artifactId, hostname, idempotencyKey) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/domain`,
        CustomDomainView,
        "POST",
        { hostname },
        { "idempotency-key": idempotencyKey },
      );
    },
    verifyDomain(hostname) {
      return call(
        `/api/v1/domains/${encodeURIComponent(hostname)}/verify`,
        CustomDomainView,
        "POST",
      );
    },
    removeDomain(hostname) {
      return call(`/api/v1/domains/${encodeURIComponent(hostname)}`, CustomDomainRemoved, "DELETE");
    },
    async auditExport(workspace, format, query) {
      const params = new URLSearchParams({ format });
      for (const kind of query.kinds ?? []) params.append("kind", kind);
      if (query.actor) params.set("actor", query.actor);
      if (query.from) params.set("from", query.from);
      if (query.cursor) params.set("cursor", query.cursor);
      let response: Response;
      try {
        response = await fetch(inSpace(`/api/v1/audit/export?${params}`, workspace), {
          method: "GET",
          credentials: "same-origin",
          headers: { accept: "*/*" },
        });
      } catch {
        throw new ApiFailure("network", 0);
      }
      if (response.ok) {
        return {
          text: await response.text(),
          nextCursor: response.headers.get(AUDIT_EXPORT_CURSOR_HEADER),
        };
      }
      if (response.status === 401) {
        onUnauthenticated();
        throw new ApiFailure("unauthenticated", 401);
      }
      const error = ApiError.safeParse(await response.json().catch(() => null));
      throw new ApiFailure(error.success ? error.data.error.code : "unexpected", response.status);
    },
    audit(workspace, query) {
      const params = new URLSearchParams();
      for (const kind of query.kinds ?? []) params.append("kind", kind);
      if (query.actor) params.set("actor", query.actor);
      if (query.from) params.set("from", query.from);
      if (query.cursor) params.set("cursor", query.cursor);
      const path = params.size > 0 ? `/api/v1/audit?${params}` : "/api/v1/audit";
      return call(inSpace(path, workspace), AuditLogView);
    },
    accessLog(artifactId, cursor, limit) {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (limit !== undefined) params.set("limit", String(limit));
      const query = params.size > 0 ? `?${params}` : "";
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/access-log${query}`,
        AccessLogView,
      );
    },
    stats(artifactId, from) {
      const query = from ? `?${new URLSearchParams({ from })}` : "";
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/stats${query}`,
        ArtifactStatsView,
      );
    },
    preparePublish(request, idempotencyKey, workspace) {
      return call(inSpace("/api/v1/publishes", workspace), PreparedPublish, "POST", request, {
        "idempotency-key": idempotencyKey,
      });
    },
    uploadProgress(uploadId) {
      return call(`/api/v1/publishes/${encodeURIComponent(uploadId)}`, PreparedPublish);
    },
    async reportPart(uploadId, part) {
      await call(`/api/v1/publishes/${encodeURIComponent(uploadId)}/parts`, z.null(), "POST", part);
    },
    commitPublish(uploadId) {
      return call(
        `/api/v1/publishes/${encodeURIComponent(uploadId)}/commit`,
        CommittedPublish,
        "POST",
      );
    },
    async abortPublish(uploadId) {
      await call(`/api/v1/publishes/${encodeURIComponent(uploadId)}`, z.null(), "DELETE");
    },
    listVersions(artifactId, cursor) {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions${query}`,
        VersionList,
      );
    },
    versionManifest(artifactId, versionId) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}`,
        VersionManifest,
      );
    },
    versionDownload(artifactId, versionId, kind, path) {
      const query = new URLSearchParams({ kind, ...(path ? { path } : {}) });
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/download?${query}`,
        VersionDownload,
      );
    },
    rollback(artifactId, request, idempotencyKey) {
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/rollback`,
        RolledBack,
        "POST",
        request,
        { "idempotency-key": idempotencyKey },
      );
    },
    compareVersions(artifactId, fromVersionId, toVersionId, cursor) {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(fromVersionId)}/diff/${encodeURIComponent(toVersionId)}${query}`,
        VersionComparison,
      );
    },
    fileDiff(artifactId, fromVersionId, toVersionId, file, cursor = 0) {
      const query = new URLSearchParams({ ...file, cursor: String(cursor) });
      return call(
        `/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(fromVersionId)}/diff/${encodeURIComponent(toVersionId)}/file?${query}`,
        FileDiff,
      );
    },
    previewDocument(request) {
      return call("/api/v1/documents/preview", DocumentPreview, "POST", request);
    },
    startReview(artifactId) {
      return call(`${artifactPath(artifactId)}/review`, ReviewStart, "POST");
    },
    viewerInfo(artifactId) {
      return call(`${artifactPath(artifactId)}/viewer`, ViewerInfo);
    },
    startReviewTab(artifactId) {
      return call(`${artifactPath(artifactId)}/review/tab`, ReviewTabStart, "POST");
    },
    listAnnotations(artifactId, cursor, version = "current") {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (version !== "current") params.set("version", version);
      const query = params.size > 0 ? `?${params}` : "";
      return call(`${annotationsPath(artifactId)}${query}`, AnnotationPage);
    },
    async exportAnnotations(artifactId, { format, version, state }) {
      const params = new URLSearchParams({ format, version, ...(state ? { state } : {}) });
      const path = `${annotationsPath(artifactId)}/export?${params}`;
      if (format === "json") {
        const data = await call(path, AnnotationExport);
        return {
          fileName: `${data.artifact.id}-annotations.json`,
          blob: new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }),
        };
      }
      // Markdown comes back as text; the dashboard never renders it, only saves it.
      const text = await call(path, z.string(), "GET", undefined, {
        accept: "text/markdown",
      });
      return {
        fileName: `${artifactId}-annotations.md`,
        blob: new Blob([text], { type: "text/markdown;charset=utf-8" }),
      };
    },
    createThread(artifactId, request, idempotencyKey) {
      return call(`${annotationsPath(artifactId)}/threads`, AnnotationThreadView, "POST", request, {
        "idempotency-key": idempotencyKey,
      });
    },
    reply(artifactId, threadId, body, idempotencyKey, turnstileToken) {
      return call(
        `${annotationsPath(artifactId)}/threads/${encodeURIComponent(threadId)}/messages`,
        AnnotationThreadView,
        "POST",
        turnstileToken === undefined ? { body } : { body, turnstileToken },
        { "idempotency-key": idempotencyKey },
      );
    },
    setThreadState(artifactId, threadId, state) {
      const action = state === "resolved" ? "resolve" : "reopen";
      return call(
        `${annotationsPath(artifactId)}/threads/${encodeURIComponent(threadId)}/${action}`,
        AnnotationThreadView,
        "POST",
      );
    },
    editMessage(artifactId, messageId, request) {
      return call(
        `${annotationsPath(artifactId)}/messages/${encodeURIComponent(messageId)}`,
        AnnotationEditResult,
        "PATCH",
        request,
      );
    },
    moderateMessage(artifactId, messageId, action) {
      return call(
        `${annotationsPath(artifactId)}/messages/${encodeURIComponent(messageId)}/moderation`,
        AnnotationDeleteResult,
        "POST",
        { action },
      );
    },
    async deleteThread(artifactId, threadId) {
      await call(
        `${annotationsPath(artifactId)}/threads/${encodeURIComponent(threadId)}`,
        z.unknown(),
        "DELETE",
      );
    },
    setAnnotationMode(artifactId, mode) {
      return call(`${annotationsPath(artifactId)}/mode`, AnnotationModeView, "PUT", { mode });
    },
  };
}

const artifactPath = (artifactId: string) => `/api/v1/artifacts/${encodeURIComponent(artifactId)}`;
const annotationsPath = (artifactId: string) => `${artifactPath(artifactId)}/annotations`;
