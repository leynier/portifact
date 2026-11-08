// Same-origin calls from the dashboard to /api/v1 and the session endpoints under /api/auth.
// The browser sends the session cookie, fetch metadata and the Origin header, which the Worker
// checks (apps/app/src/api/access.ts). Every response is validated with the shared contracts.
import {
  AccessPolicyView,
  type AccessUpdate,
  AccountDeletionResult,
  ApiError,
  ArtifactList,
  ArtifactSummary,
  BrowserSessionList,
  CommittedPublish,
  ConnectedAppList,
  DisconnectResult,
  DocumentPreview,
  type DocumentPreviewRequest,
  type DownloadKind,
  type ErrorCode,
  LifecycleResult,
  PreparedPublish,
  type PublishRequest,
  type RollbackRequest,
  RolledBack,
  SignOutOthersResult,
  VersionDownload,
  VersionList,
  VersionManifest,
} from "@portifact/contracts";
import { z } from "zod";

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
  listArtifacts(cursor?: string): Promise<ArtifactList>;
  getArtifact(artifactId: string): Promise<ArtifactSummary>;
  lifecycle(artifactId: string, action: LifecycleAction): Promise<LifecycleResult>;
  getAccess(artifactId: string): Promise<AccessPolicyView>;
  updateAccess(artifactId: string, change: AccessUpdate): Promise<AccessPolicyView>;
  signInMethods(): Promise<SignInMethod[]>;
  browserSessions(): Promise<BrowserSessionList>;
  signOutOtherSessions(): Promise<SignOutOthersResult>;
  connectedApps(): Promise<ConnectedAppList>;
  disconnectApp(clientId: string): Promise<DisconnectResult>;
  /** Deletes the account; the email typed again confirms it. */
  deleteAccount(confirmEmail: string): Promise<AccountDeletionResult>;
  /** Starts a publish; retrying with the same key returns the same upload. */
  preparePublish(request: PublishRequest, idempotencyKey: string): Promise<PreparedPublish>;
  /** An open upload with fresh URLs for the objects still to send. */
  uploadProgress(uploadId: string): Promise<PreparedPublish>;
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
    method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
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
    const body = await response.json().catch(() => null);
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
    listArtifacts(cursor) {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
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
    deleteAccount(confirmEmail) {
      return call("/api/v1/account/delete", AccountDeletionResult, "POST", { confirmEmail });
    },
    preparePublish(request, idempotencyKey) {
      return call("/api/v1/publishes", PreparedPublish, "POST", request, {
        "idempotency-key": idempotencyKey,
      });
    },
    uploadProgress(uploadId) {
      return call(`/api/v1/publishes/${encodeURIComponent(uploadId)}`, PreparedPublish);
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
  };
}
