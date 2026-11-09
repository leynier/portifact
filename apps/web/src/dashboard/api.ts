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
  ArtifactList,
  type ArtifactListFilters,
  ArtifactSummary,
  BrowserSessionList,
  CommittedPublish,
  ConnectedAppList,
  type CreateThreadRequest,
  DisconnectResult,
  DocumentPreview,
  type DocumentPreviewRequest,
  type DownloadKind,
  type EditMessageRequest,
  type ErrorCode,
  LifecycleResult,
  PreparedPublish,
  type PublishRequest,
  ReviewStart,
  ReviewTabStart,
  type RollbackRequest,
  RolledBack,
  SignOutOthersResult,
  type UploadedPart,
  VersionDownload,
  VersionList,
  VersionManifest,
  ViewerInfo,
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

export type LifecycleAction = "renew" | "archive" | "restore" | "delete";

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
  /** A page of the account's artifacts that match `filters`; the API applies them. */
  listArtifacts(cursor?: string, filters?: ArtifactListFilters): Promise<ArtifactList>;
  getArtifact(artifactId: string): Promise<ArtifactSummary>;
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
  /** Deletes the account; the email typed again confirms it. */
  deleteAccount(confirmEmail: string): Promise<AccountDeletionResult>;
  /** The account's quotas, this month's traffic and what blocks it now. */
  usage(): Promise<AccountUsageView>;
  /** A page of the artifact's access log, newest first; only its owner may read it. */
  accessLog(artifactId: string, cursor?: string, limit?: number): Promise<AccessLogView>;
  /** Starts a publish; retrying with the same key returns the same upload. */
  preparePublish(request: PublishRequest, idempotencyKey: string): Promise<PreparedPublish>;
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
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
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
    listArtifacts(cursor, filters = {}) {
      const params = new URLSearchParams();
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
    deleteAccount(confirmEmail) {
      return call("/api/v1/account/delete", AccountDeletionResult, "POST", { confirmEmail });
    },
    usage() {
      return call("/api/v1/usage", AccountUsageView);
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
    preparePublish(request, idempotencyKey) {
      return call("/api/v1/publishes", PreparedPublish, "POST", request, {
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
