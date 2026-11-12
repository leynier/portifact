// Test support for the dashboard: an in-memory /api/v1 and session endpoint behind the real
// API client, and a renderer with memory history. Only used by tests.

import type { I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { AuditStreamAttempt, AuditStreamView } from "@portifact/contracts";
import {
  type AccessLogEntry,
  type AccessLogView,
  type AccessPolicyView,
  AccessUpdate,
  type AccountSettings,
  type AccountUsageView,
  type AnnotationHistoryEntry,
  type AnnotationMessageView,
  type AnnotationRole,
  type AnnotationsState,
  type AnnotationThreadView,
  type ApprovalReviewView,
  type ArtifactActivity,
  ArtifactListQuery,
  type ArtifactStatsView,
  type ArtifactSummary,
  type AuditEventView,
  type AuditLogView,
  type BrandSettings,
  type BrandUpdate,
  type BrowserSession,
  type CommentNoticeMute,
  type CommentScope,
  type ConnectedApp,
  type CustomDomainList,
  type CustomDomainView,
  DEFAULT_POLICY,
  DocumentPreviewRequest,
  type ErrorCode,
  type FileChange,
  GitHubTrustRuleCreate,
  type GitHubTrustRuleView,
  type GraceForecastView,
  githubKeyPrefix,
  type IncomingInvitationView,
  type IntegrationConnectionView,
  type InvitationLookup,
  type InvitationView,
  LIMITS,
  type ManifestFile,
  NO_APPROVAL_REVIEW,
  type OwnerView,
  PLANS,
  type PolicyImpact,
  type PreparedPublish,
  PublishRequest,
  planRequiredMessage,
  type ReviewStart,
  RollbackRequest,
  type ScimOverview,
  type ScimTokenView,
  type SearchSnippet,
  ServiceTokenCreate,
  type ServiceTokenView,
  type ShareLinkCreated,
  type ShareLinkList,
  type ShareLinkView,
  type SingleFamilyLists,
  type SsoProviderView,
  type SsoSettings,
  UNTRUSTED_ANNOTATIONS_NOTICE,
  type UploadTarget,
  type UsageBlock,
  type VersionSummary,
  type ViewerInfo,
  type WebhookAttempt,
  type WebhookView,
  type WorkspaceDomainView,
  WorkspaceGroupCreate,
  type WorkspaceGroupView,
  type WorkspaceMemberView,
  type WorkspacePolicy,
  type WorkspaceView,
} from "@portifact/contracts";
import {
  auditExportLine,
  auditExportPreamble,
  checkSingleFamily,
  commentTiming,
  diffText,
  normalizePolicy,
  noticeWindowEnd,
  retentionTiming,
  singleFamilyLists,
  textDiffEligibility,
} from "@portifact/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { HumanCheckWidget } from "../human-check/turnstile.ts";
import { dashboardApi } from "./api.ts";
import { DashboardApp } from "./app.tsx";
import { DashboardContext } from "./context.tsx";
import { createI18n } from "./i18n/i18n.ts";
import type { LocaleOptions } from "./locale.tsx";
import { inProcessBuilder } from "./publish/builder.ts";
import type { SavedFile } from "./publish/download.ts";
import { sha256OfBlob } from "./publish/hash.ts";
import type { StorageTransport } from "./publish/upload.ts";
import { createQueryClient } from "./query-client.ts";
import { createDashboardRouter } from "./router.tsx";

export const NOW = "2026-11-08T12:00:00.000Z";

/** A usage body with nothing used and nothing blocking, as a new month starts. */
export function usageView(overrides: Partial<AccountUsageView> = {}): AccountUsageView {
  return {
    plan: {
      name: "free",
      validUntil: null,
      seats: 1,
      limits: { ...PLANS.free.limits },
      features: [],
    },
    activeArtifacts: { used: 2, limit: 50 },
    storage: { used: 1_500_000, reserved: 0, limit: 2_500_000_000 },
    publishesLast24h: { used: 3, limit: 100 },
    newFilesLast24h: { used: 0, limit: 10_000 },
    newBytesLast24h: { used: 0, limit: 5_000_000_000 },
    newObjectsThisMonth: { used: 0, limit: 100_000, resetsAt: "2026-12-01T00:00:00.000Z" },
    openUploads: { used: 0, limit: 2 },
    trafficThisMonth: {
      requests: { used: 12_345, limit: 1_000_000 },
      bytes: { used: 3_200_000_000, limit: 25_000_000_000 },
      resetsAt: "2026-12-01T00:00:00.000Z",
    },
    versionLimits: { publishedBytes: 250_000_000, files: 1_000, documentBytes: 5_000_000 },
    publicAccessFrom: "2026-09-08T12:00:00.000Z",
    blocks: [],
    ...overrides,
  };
}

export const DEFAULT_ACTIVITY: ArtifactActivity = {
  versions: 1,
  currentBytes: 2048,
  openThreads: 0,
  lastAnnotationAt: null,
};

export function artifact(id: string, overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    id,
    name: `Artifact ${id}`,
    type: "site",
    state: "active",
    accessMode: "restricted",
    annotations: "off",
    currentVersionId: `v-${id}`,
    url: `https://${id}.portifact.dev/`,
    owner: { kind: "personal" },
    expiresAt: "2026-12-08T12:00:00.000Z",
    archivedAt: null,
    purgeAt: null,
    pinned: false,
    key: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Failure {
  status: number;
  code?: ErrorCode;
  /** Throw like a network failure instead of answering. */
  network?: boolean;
}

export function connectedApp(
  clientId: string,
  overrides: Partial<ConnectedApp> = {},
): ConnectedApp {
  return {
    clientId,
    name: "Portifact CLI",
    firstParty: true,
    resources: ["api"],
    scopes: ["artifacts:read", "offline_access"],
    approvedAt: "2026-11-01T12:00:00.000Z",
    lastIssuedAt: "2026-11-08T11:00:00.000Z",
    expiresAt: "2026-12-01T12:00:00.000Z",
    signInMethod: "code",
    ...overrides,
  };
}

export function browserSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    current: false,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    createdAt: "2026-11-01T12:00:00.000Z",
    lastActiveAt: "2026-11-08T10:00:00.000Z",
    expiresAt: "2026-11-15T10:00:00.000Z",
    signInMethod: "code",
    ...overrides,
  };
}

/** A committed version as the fake API keeps it. */
export interface FakeVersion {
  id: string;
  number: number;
  committedAt: string;
  expiresAt: string | null;
  entrypoint: string;
  files: ManifestFile[];
}

interface FakeUpload {
  id: string;
  key: string;
  artifactId: string;
  versionId: string;
  versionNumber: number;
  request: PublishRequest;
  /** The response prepare gave, replayed for the same idempotency key. */
  state: "open" | "committed" | "aborted";
}

type StorageFault = { status: number } | { network: true } | { corrupt: true };

/**
 * Presigned storage as the dashboard sees it: uploads must send the signed size and checksum
 * and bytes that match them, and downloads serve the stored bytes. Faults answer, drop or
 * corrupt the next transfers.
 */
export interface FakeStorage extends StorageTransport {
  /** Verified objects by SHA-256. */
  objects: Map<string, Blob>;
  puts: { url: string; headers: Record<string, string>; size: number }[];
  gets: string[];
  fail(fault: StorageFault, times?: number): void;
  /** Holds the next upload until the returned function is called or the upload is aborted. */
  hold(): () => void;
}

/** `expiring: "soon"` as the service decides it: active, expiring within the notices' window. */
function expiringSoon(item: { state: string; expiresAt: string | null }, now = Date.now()) {
  if (item.state !== "active" || item.expiresAt === null) return false;
  const at = Date.parse(item.expiresAt);
  return at > now && at <= noticeWindowEnd(now);
}

function base64OfHex(hex: string): string {
  let binary = "";
  for (let i = 0; i < hex.length; i += 2)
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(binary);
}

function fakeStorage(): FakeStorage {
  const faults: { fault: StorageFault; times: number }[] = [];
  const nextFault = () => {
    const found = faults.find((f) => f.times > 0);
    if (found) found.times -= 1;
    return found?.fault;
  };
  let held: Promise<void> | undefined;
  const storage: FakeStorage = {
    objects: new Map(),
    puts: [],
    gets: [],
    fail(fault, times = 1) {
      faults.push({ fault, times });
    },
    hold() {
      let release = () => {};
      held = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    async put(target, body, onProgress, signal) {
      if (held) {
        const waiting = held;
        held = undefined;
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          void waiting.then(resolve);
        });
      }
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      storage.puts.push({ url: target.url, headers: target.headers, size: body.size });
      // The fake API hands out single PUTs only; multipart is covered by publish/upload.test.ts.
      if (!("sha256" in target)) return { status: 404 };
      const fault = nextFault();
      if (fault && "network" in fault) return { status: 0 };
      if (fault && "status" in fault) return { status: fault.status };
      onProgress(Math.floor(body.size / 2));
      const signedSize = Number(target.headers["content-length"]);
      const checksum = target.headers["x-amz-checksum-sha256"];
      if (signedSize !== body.size || checksum !== base64OfHex(await sha256OfBlob(body))) {
        return { status: 400 };
      }
      if (Date.parse(target.expiresAt) <= Date.now()) return { status: 403 };
      onProgress(body.size);
      storage.objects.set(target.sha256, body);
      return { status: 200 };
    },
    async get(url) {
      storage.gets.push(url);
      const fault = nextFault();
      if (fault && ("network" in fault || "status" in fault))
        throw new TypeError("Failed to fetch");
      const sha = /\/download\/([0-9a-f]{64})/.exec(url)?.[1] ?? "";
      const blob = storage.objects.get(sha);
      if (!blob) throw new TypeError("missing object");
      if (fault && "corrupt" in fault) return new Blob(["corrupted"]);
      return blob;
    },
  };
  return storage;
}

/** Annotations of one artifact in the fake server, with a change counter for cursors. */
export interface FakeAnnotations {
  mode: AnnotationsState;
  role: AnnotationRole;
  /** Which threads the caller sees; `all` unless a test narrows it. */
  commentScope?: CommentScope;
  /** Threads the caller no longer sees: an edit of their own message there answers no thread. */
  outOfScope?: string[];
  currentVersionId: string;
  threads: (AnnotationThreadView & { seq: number })[];
  deleted: { id: string; seq: number }[];
  seq: number;
  /**
   * Comments that still need a solved human check: each one must carry a `turnstileToken`
   * starting with `solved`, or the post answers `human_verification_required`.
   */
  humanChecks?: number;
  /** The comment action history, oldest first, as GET .../history pages it (owner only). */
  history?: AnnotationHistoryEntry[];
}

export function fakeMessage(overrides: Partial<AnnotationMessageView> = {}): AnnotationMessageView {
  return {
    id: `m${Math.random().toString(36).slice(2, 10)}`,
    author: { id: "u-bea", name: "Bea", image: null },
    own: false,
    state: "visible",
    body: "Looks good",
    revision: 1,
    createdAt: NOW,
    editedAt: null,
    ...overrides,
  };
}

export function fakeThread(
  id: string,
  overrides: Partial<AnnotationThreadView> = {},
): AnnotationThreadView {
  return {
    id,
    versionId: "v1",
    current: true,
    path: "index.html",
    target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
    state: "open",
    author: { id: "u-bea", name: "Bea", image: null },
    own: false,
    byOwner: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
    messages: [fakeMessage()],
    ...overrides,
  };
}

/** A workspace of the fake server: its view for the caller, members, seats and invitations. */
export interface FakeWorkspace {
  view: WorkspaceView;
  members: WorkspaceMemberView[];
  seats: number;
  invitations: InvitationView[];
  usage: AccountUsageView;
  branding: BrandSettings;
  /** Service tokens (decision 0011) and whether the plan includes them. */
  serviceTokens: ServiceTokenView[];
  serviceTokensAvailable: boolean;
  /** GitHub trust rules (decision 0024) and whether the deployment offers the federation. */
  githubTrust: GitHubTrustRuleView[];
  githubOidcEnabled: boolean;
  /** Its email domains (decision 0010); verifying one succeeds when `dns` holds its value. */
  domains: WorkspaceDomainView[];
  /** The TXT values the fake DNS answers, by record name. */
  dns: Record<string, string[]>;
  /** The plan includes workspace sharing. */
  domainsAvailable: boolean;
  /** Its groups (decision 0014), with their members' user IDs. */
  groups: (WorkspaceGroupView & { memberIds: string[]; pendingIds?: string[] })[];
  /**
   * Single sign-on (decision 0016): switched on for the deployment, in the plan, and the provider.
   * Off by default, as deployed: the routes answer `capacity_unavailable`.
   */
  sso: { enabled: boolean; available: boolean; provider: SsoProviderView | null };
  /**
   * SCIM (decision 0017): switched on for the deployment, in the plan, its tokens and settings.
   * Off by default, as deployed: the routes answer `capacity_unavailable`.
   */
  scim: {
    enabled: boolean;
    available: boolean;
    tokens: ScimTokenView[];
    invitationEmails: boolean;
    lastSyncAt: string | null;
    /** The directory-managed groups mapped to editor and admin. */
    editorGroup?: string | null;
    adminGroup?: string | null;
  };
  /** Its policies' revision and plan (decision 0015); the policy itself is on `view`. */
  policyRevision: number;
  policiesAvailable: boolean;
  /** Whether a set comment retention is in force (decision 0023); in force unless a test says. */
  commentRetentionInForce?: boolean;
  /**
   * How a save that changes comment retention is refused, as the API refuses it while the guard
   * record cannot be read or written (`guard`, with its detail) or for capacity (`capacity`).
   */
  commentRetentionRefusal?: "guard" | "capacity";
  /** What the fake preview answers; a save needs these counts confirmed while any is above zero. */
  policyImpact: PolicyImpact;
  /**
   * "SSO required" as an admin's Policies page sees it (decision 0021): null where single sign-on
   * is not offered; otherwise whether the provider can sign people in and the admin's own session
   * went through it. `ssoOutside` is how many members the provider cannot serve.
   */
  ssoState: { usable: boolean; yourSession: boolean; offered?: boolean } | null;
  ssoOutside: number;
}

export const NO_IMPACT: PolicyImpact = {
  publicArtifacts: 0,
  readersOutside: 0,
  linksRevoked: 0,
  linksWithoutPassword: 0,
  linksOverLifetime: 0,
  artifactsAtStart: 0,
  artifactsSoon: 0,
  pinsLifted: 0,
  threadsAtStart: 0,
  messagesAtStart: 0,
  threadsSoon: 0,
};

export function workspace(
  slug: string,
  role: WorkspaceView["role"],
  overrides: Partial<Omit<FakeWorkspace, "view">> & {
    name?: string;
    policy?: WorkspacePolicy;
    /** Its network policy refuses this browser (decision 0020). */
    blocked?: boolean;
    /** Where its data is stored (decision 0005). */
    region?: WorkspaceView["region"];
    /** Which request policy refuses it (decision 0021). */
    blockedBy?: WorkspaceView["blockedBy"];
  } = {},
): FakeWorkspace {
  const {
    name = `Team ${slug}`,
    policy = DEFAULT_POLICY,
    blocked = false,
    region = "default",
    blockedBy = blocked ? "network" : null,
    ...rest
  } = overrides;
  return {
    view: {
      slug,
      name,
      role,
      region,
      createdAt: NOW,
      policy: { ...policy, commentRetentionToken: null },
      blocked,
      blockedBy,
    },
    members: [
      {
        userId: "u_ada",
        name: "Ada",
        email: "ada@example.test",
        role,
        joinedAt: NOW,
        you: true,
        directoryRole: false,
      },
      ...(role === "admin"
        ? []
        : [
            {
              userId: "u_grace",
              name: "Grace Admin",
              email: "grace@example.test",
              role: "admin" as const,
              joinedAt: NOW,
              you: false,
              directoryRole: false,
            },
          ]),
    ],
    seats: 10,
    invitations: [],
    usage: usageView(),
    branding: { available: true, lowestPlan: "pro", suspended: false, brand: null },
    serviceTokens: [],
    serviceTokensAvailable: true,
    githubTrust: [],
    githubOidcEnabled: true,
    domains: [],
    dns: {},
    domainsAvailable: true,
    groups: [],
    sso: { enabled: false, available: true, provider: null },
    scim: {
      enabled: false,
      available: true,
      tokens: [],
      invitationEmails: false,
      lastSyncAt: null,
    },
    policyRevision: 0,
    policiesAvailable: true,
    policyImpact: NO_IMPACT,
    ssoState: null,
    ssoOutside: 0,
    ...rest,
  };
}

export interface FakeServer {
  /** The caller's workspaces, by slug; empty by default. */
  workspaces: Record<string, FakeWorkspace>;
  /** Invitations addressed to the caller. */
  incoming: IncomingInvitationView[];
  /** Answers to the invitation link lookup, by token; unknown tokens answer `not_found`. */
  links: Record<string, InvitationLookup>;
  artifacts: ArtifactSummary[];
  /** What the list says about each artifact's activity; missing ones get `DEFAULT_ACTIVITY`. */
  activity: Record<string, ArtifactActivity>;
  /** Answers to GET /viewer by artifact ID; missing ones follow `reviews` and `annotations`. */
  viewers: Record<string, ViewerInfo>;
  /** Answers to POST /review, by artifact ID; missing ones answer 404. */
  reviews: Record<string, ReviewStart>;
  /** Review tab codes issued so far (POST /review/tab answers with the review's origin). */
  reviewTabs: number;
  annotations: Record<string, FakeAnnotations>;
  /** Committed versions by artifact ID, newest first. */
  versions: Record<string, FakeVersion[]>;
  /** The text of each seeded file by SHA-256, for the comparison routes. */
  texts: Map<string, string>;
  uploads: FakeUpload[];
  storage: FakeStorage;
  /** How long upload URLs the fake API issues stay valid. */
  uploadUrlTtlMs: number;
  email: string | null;
  /** When the account was created; null leaves it out of the session. */
  createdAt: string | null;
  /** Access policies by artifact ID; missing ones start from the artifact's mode. */
  access: Record<string, AccessPolicyView>;
  /** Linked providers, as /list-accounts answers them. */
  providers: { providerId: string; createdAt: string }[];
  sessions: BrowserSession[];
  apps: ConnectedApp[];
  /** The account's defaults for new artifacts. */
  settings: AccountSettings;
  /** Comment notices by artifact: whether the owner's plan has them and the caller's mute. */
  commentNotices: Record<string, CommentNoticeMute>;
  /** The body of GET /api/v1/usage. */
  usage: AccountUsageView;
  /** The body of GET /api/v1/grace-forecast (decision 0022), for every space. */
  graceForecast: GraceForecastView;
  /** The account's webhooks and whether its plan includes them, as /api/v1/webhooks keeps them. */
  webhooks: {
    list: WebhookView[];
    available: boolean;
    attempts: Record<string, WebhookAttempt[]>;
    /** Whether the deployment offers webhooks (`WEBHOOKS_ENABLED`). */
    offered?: boolean;
  };
  /** Webhooks a test event was queued for. */
  webhookTests: string[];
  /**
   * The space's issue connections (decision 0018), as /api/v1/integrations keeps them, and the
   * issues asked for from threads with their Idempotency-Key.
   */
  integrations: {
    connections: IntegrationConnectionView[];
    available: boolean;
    /** Whether the deployment offers integrations (`INTEGRATIONS_ENABLED`). */
    offered: boolean;
    /** Whether the deployment offers Slack connections (`SLACK_ENABLED`, decision 0025). */
    slackOffered: boolean;
    euResidency: boolean;
    issues: { artifactId: string; threadId: string; key: string; body: unknown }[];
  };
  /** Access log entries by artifact ID, newest first, paged by `pageSize` like the Worker. */
  accessLogs: Record<string, AccessLogEntry[]>;
  /**
   * Audit events by space (`""` for the personal space), newest first. A space without an entry
   * answers `plan_required`; a workspace role other than admin answers `forbidden`.
   */
  audit: Record<string, AuditEventView[]>;
  /** Spaces whose plan includes exporting the audit log (`exportable`); none by default. */
  auditExportable: Set<string>;
  /** Events per export part, so the dashboard follows the cursor. */
  auditExportPart: number;
  /** The owner's plan's `auditRetentionDays`, as the audit page reports it. */
  auditRetentionDays: number;
  /**
   * Audit streams by space (`""` for the personal space), as /api/v1/audit/streams keeps them
   * (decision 0019). `offered` is the deployment's switch (off by default, as deployed), and
   * `available` the plan's features.
   */
  auditStreams: {
    offered: boolean;
    available: boolean;
    euOwner: boolean;
    bySpace: Record<string, AuditStreamView[]>;
    attempts: Record<string, AuditStreamAttempt[]>;
    tests: string[];
  };
  /**
   * Analytics by artifact ID. An artifact without an entry answers `plan_required`, like an
   * owner on the free plan; the range asked for comes back as `from`.
   */
  stats: Record<string, ArtifactStatsView>;
  /**
   * Content search hits by space (`""` for the personal space): GET /api/v1/search returns the
   * hits whose snippet contains the query, in this order, after the role and plan checks.
   */
  search: Record<
    string,
    { artifactId: string; path: string; snippet: SearchSnippet; partial: boolean }[]
  >;
  /** Share links by artifact ID, newest first, as the API lists them. */
  shareLinks: Record<string, ShareLinkView[]>;
  /**
   * Approval reviews by artifact (decision 0013), as GET .../review/status answers them; missing
   * ones have no request. Writes answer `approvalReply` when it is set.
   */
  approvals: Record<string, ApprovalReviewView>;
  approvalReply: ApprovalReviewView | { error: ErrorCode; status: number } | null;
  /** Whether the owner's plan includes share links. */
  shareLinksEnabled: boolean;
  /** Custom domains and pending claims, oldest first. */
  domains: CustomDomainView[];
  /** Whether the owner's plan includes custom domains (one, like Pro). */
  domainsEnabled: boolean;
  /** Whether the deployment serves custom domains. */
  domainsAvailable: boolean;
  /** The account's brand, as GET /api/v1/account/branding answers it. */
  branding: BrandSettings;
  /** Logo files sent to PUT /api/v1/account/branding/logo, in order. */
  logoUploads: Blob[];
  /** JSON bodies of requests that sent one, in order. */
  bodies: unknown[];
  pageSize: number;
  requests: { method: string; path: string }[];
  /** Idempotency keys sent, with the path they were sent to, in order. */
  idempotencyKeys: { path: string; key: string }[];
  /** The next `times` requests matching `method path` (path without query) fail. */
  fail(method: string, path: string, failure: Failure, times?: number): void;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** How many times the artifact list was requested. */
  listRequests(): number;
}

export function fakeServer(artifacts: ArtifactSummary[] = []): FakeServer {
  const failures: { key: string; failure: Failure; times: number }[] = [];
  const server: FakeServer = {
    workspaces: {},
    incoming: [],
    links: {},
    artifacts,
    activity: {},
    viewers: {},
    reviews: {},
    reviewTabs: 0,
    annotations: {},
    versions: {},
    uploads: [],
    storage: fakeStorage(),
    uploadUrlTtlMs: 15 * 60 * 1000,
    email: "ada@example.test",
    createdAt: "2026-09-01T12:00:00.000Z",
    access: {},
    providers: [],
    sessions: [browserSession({ current: true })],
    apps: [],
    settings: {
      defaultAccessMode: "restricted",
      defaultAnnotations: "off",
      defaultCommentVisibility: "owner",
      defaultBar: true,
      expiryNotices: true,
      commentNotices: true,
      locale: null,
    },
    usage: usageView(),
    graceForecast: { ownerId: "u_owner", grace: null, kinds: [] },
    webhooks: { list: [], available: true, attempts: {} },
    webhookTests: [],
    integrations: {
      connections: [],
      available: true,
      offered: false,
      slackOffered: false,
      euResidency: false,
      issues: [],
    },
    accessLogs: {},
    search: {},
    audit: {},
    auditExportable: new Set(),
    auditExportPart: 2,
    auditRetentionDays: 90,
    auditStreams: {
      offered: false,
      available: true,
      euOwner: false,
      bySpace: {},
      attempts: {},
      tests: [],
    },
    stats: {},
    shareLinks: {},
    approvals: {},
    approvalReply: null,
    shareLinksEnabled: true,
    domains: [],
    domainsEnabled: true,
    domainsAvailable: true,
    branding: { available: true, lowestPlan: "pro", suspended: false, brand: null },
    logoUploads: [],
    commentNotices: {},
    bodies: [],
    pageSize: 50,
    texts: new Map(),
    requests: [],
    idempotencyKeys: [],
    fail(method, path, failure, times = 1) {
      failures.push({ key: `${method} ${path}`, failure, times });
    },
    listRequests: () =>
      server.requests.filter(
        (r) => r.method === "GET" && /^\/api\/v1\/artifacts(\?|$)/.test(r.path),
      ).length,
    async fetch(input, init = {}) {
      const method = init.method ?? "GET";
      const url = new URL(input, "https://app.portifact.com");
      server.requests.push({ method, path: `${url.pathname}${url.search}` });
      const idempotencyKey = new Headers(init.headers).get("idempotency-key");
      if (idempotencyKey) server.idempotencyKeys.push({ path: url.pathname, key: idempotencyKey });
      if (typeof init.body === "string") server.bodies.push(JSON.parse(init.body));
      if (init.body instanceof Blob) server.logoUploads.push(init.body);
      const failure = failures.find((f) => f.key === `${method} ${url.pathname}` && f.times > 0);
      if (failure) {
        failure.times -= 1;
        if (failure.failure.network) throw new TypeError("Failed to fetch");
        return Response.json(
          failure.failure.code ? { error: { code: failure.failure.code, message: "x" } } : {},
          { status: failure.failure.status },
        );
      }
      return route(server, method, url, new Headers(init.headers));
    },
  };
  return server;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function apiError(code: ErrorCode, status: number): Response {
  return json({ error: { code, message: "x" } }, status);
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
let idCounter = 0;

function newArtifactId(): string {
  idCounter += 1;
  let n = idCounter;
  let id = "";
  for (let i = 0; i < 10; i++) {
    id = (ID_ALPHABET[n % 32] as string) + id;
    n = Math.floor(n / 32);
  }
  return id;
}

/** Adds a committed version, with its bytes stored, as if published earlier. */
export async function seedVersion(
  server: FakeServer,
  artifactId: string,
  files: { path: string; text: string; kind?: "published" | "source"; contentType?: string }[],
  overrides: Partial<FakeVersion> = {},
): Promise<FakeVersion> {
  const manifest: ManifestFile[] = [];
  for (const file of files) {
    const blob = new Blob([file.text]);
    const sha256 = await sha256OfBlob(blob);
    server.storage.objects.set(sha256, blob);
    server.texts.set(sha256, file.text);
    manifest.push({
      path: file.path,
      kind: file.kind ?? "published",
      sha256,
      size: blob.size,
      contentType: file.contentType ?? "text/html; charset=utf-8",
    });
  }
  const existing = server.versions[artifactId] ?? [];
  const number = (existing[0]?.number ?? 0) + 1;
  const version: FakeVersion = {
    id: `ver${artifactId}${number}`,
    number,
    committedAt: NOW,
    expiresAt: null,
    entrypoint: manifest.find((f) => f.kind === "published")?.path ?? "index.html",
    files: manifest,
    ...overrides,
  };
  for (const old of existing) old.expiresAt ??= "2026-11-15T12:00:00.000Z";
  server.versions[artifactId] = [version, ...existing];
  const artifact = server.artifacts.find((a) => a.id === artifactId);
  if (artifact) artifact.currentVersionId = version.id;
  return version;
}

function summaryOf(version: FakeVersion, currentId: string | null): VersionSummary {
  const of = (kind: "published" | "source") => version.files.filter((f) => f.kind === kind);
  const bytes = (files: ManifestFile[]) => files.reduce((sum, f) => sum + f.size, 0);
  return {
    id: version.id,
    number: version.number,
    current: version.id === currentId,
    entrypoint: version.entrypoint,
    publishedBytes: bytes(of("published")),
    sourceBytes: bytes(of("source")),
    publishedFiles: of("published").length,
    sourceFiles: of("source").length,
    rendererVersion: null,
    committedAt: version.committedAt,
    expiresAt: version.id === currentId ? null : version.expiresAt,
    sourceOrigin: null,
  };
}

function preparedOf(server: FakeServer, upload: FakeUpload): PreparedPublish {
  const pending = new Map<string, ManifestFile>();
  for (const file of upload.request.files) {
    if (!server.storage.objects.has(file.sha256)) pending.set(file.sha256, file);
  }
  const expiresAt = new Date(Date.now() + server.uploadUrlTtlMs).toISOString();
  const uploads: UploadTarget[] = [...pending.values()].map((file, index) => ({
    sha256: file.sha256,
    size: file.size,
    method: "PUT",
    url: `https://storage.test/objects/${file.sha256}?sig=${server.requests.length}-${index}`,
    headers: {
      "content-length": String(file.size),
      host: "storage.test",
      "x-amz-checksum-sha256": base64OfHex(file.sha256),
    },
    expiresAt,
  }));
  return {
    artifactId: upload.artifactId,
    versionId: upload.versionId,
    versionNumber: upload.versionNumber,
    uploadId: upload.id,
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    uploads,
  };
}

/** The publishing, version and preview routes of /api/v1, as the Worker answers them. */
function publishingRoute(
  server: FakeServer,
  method: string,
  url: URL,
  headers: Headers,
): Response | undefined {
  const path = url.pathname;
  const body = server.bodies.at(-1);
  if (path === "/api/v1/publishes" && method === "POST") {
    const key = headers.get("idempotency-key") ?? "";
    if (key.length < 8) return apiError("invalid_input", 400);
    const replay = server.uploads.find((u) => u.key === key);
    if (replay) return json(preparedOf(server, replay), 201);
    const parsed = PublishRequest.safeParse(body);
    if (!parsed.success) return apiError("invalid_input", 400);
    const request = parsed.data;
    let artifact = request.artifactId
      ? server.artifacts.find((a) => a.id === request.artifactId)
      : undefined;
    if (request.artifactId && !artifact) return apiError("not_found", 404);
    if (artifact && artifact.currentVersionId !== request.baseVersionId) {
      return apiError("version_conflict", 409);
    }
    if (!artifact) {
      artifact = {
        id: newArtifactId(),
        name: request.name,
        type: request.type,
        state: "draft",
        accessMode: "restricted",
        annotations: "off",
        currentVersionId: null,
        url: "",
        owner: ownerOf(server, url.searchParams.get("workspace")),
        expiresAt: null,
        archivedAt: null,
        purgeAt: null,
        pinned: false,
        key: request.key ?? null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      artifact.url = `https://${artifact.id}.portifact.dev/`;
      server.artifacts.push(artifact);
    }
    const number = (server.versions[artifact.id]?.[0]?.number ?? 0) + 1;
    const upload: FakeUpload = {
      id: `up${server.uploads.length + 1}`,
      key,
      artifactId: artifact.id,
      versionId: `ver${artifact.id}${number}`,
      versionNumber: number,
      request,
      state: "open",
    };
    server.uploads.push(upload);
    return json(preparedOf(server, upload), 201);
  }
  const publish = /^\/api\/v1\/publishes\/([^/]+)(\/commit)?$/.exec(path);
  if (publish) {
    const upload = server.uploads.find((u) => u.id === publish[1]);
    if (!upload) return apiError("not_found", 404);
    if (method === "GET" && !publish[2]) {
      return upload.state === "open"
        ? json(preparedOf(server, upload))
        : apiError("not_found", 404);
    }
    if (method === "DELETE" && !publish[2]) {
      upload.state = "aborted";
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && publish[2]) {
      if (upload.state !== "open") return apiError("not_found", 404);
      if (preparedOf(server, upload).uploads.length > 0) return apiError("upload_incomplete", 409);
      const artifact = server.artifacts.find((a) => a.id === upload.artifactId) as ArtifactSummary;
      if (artifact.currentVersionId !== (upload.request.baseVersionId ?? null)) {
        return apiError("version_conflict", 409);
      }
      upload.state = "committed";
      const version: FakeVersion = {
        id: upload.versionId,
        number: upload.versionNumber,
        committedAt: NOW,
        expiresAt: null,
        entrypoint: upload.request.entrypoint,
        files: upload.request.files,
      };
      for (const old of server.versions[artifact.id] ?? [])
        old.expiresAt ??= "2026-11-15T12:00:00.000Z";
      server.versions[artifact.id] = [version, ...(server.versions[artifact.id] ?? [])];
      Object.assign(artifact, {
        currentVersionId: version.id,
        state: "active",
        expiresAt: "2026-12-08T12:00:00.000Z",
      });
      return json({
        artifactId: artifact.id,
        versionId: version.id,
        versionNumber: version.number,
        url: artifact.url,
        expiresAt: "2026-12-08T12:00:00.000Z",
      });
    }
  }
  if (path === "/api/v1/documents/preview" && method === "POST") {
    const parsed = DocumentPreviewRequest.safeParse(body);
    if (!parsed.success) return apiError("invalid_input", 400);
    const escaped = parsed.data.source.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    return json({
      html: `<!doctype html><title>${parsed.data.name}</title><main>${escaped}</main>`,
      rendererVersion: "1",
    });
  }
  const diff = /^\/api\/v1\/artifacts\/([^/]+)\/versions\/([^/]+)\/diff\/([^/]+)(\/file)?$/.exec(
    path,
  );
  if (diff && method === "GET") return diffRoute(server, diff, url);
  const versions =
    /^\/api\/v1\/artifacts\/([^/]+)\/(versions|rollback)(?:\/([^/]+))?(\/download)?$/.exec(path);
  if (!versions) return undefined;
  const artifact = server.artifacts.find((a) => a.id === versions[1]);
  if (!artifact) return apiError("not_found", 404);
  const list = server.versions[artifact.id] ?? [];
  if (versions[2] === "rollback" && method === "POST") {
    const parsed = RollbackRequest.safeParse(body);
    if (!parsed.success || !headers.get("idempotency-key")) return apiError("invalid_input", 400);
    if (artifact.state !== "active") return apiError("artifact_archived", 409);
    if (parsed.data.baseVersionId !== artifact.currentVersionId) {
      return apiError("version_conflict", 409);
    }
    const from = list.find((v) => v.id === parsed.data.versionId);
    if (!from) return apiError("not_found", 404);
    const number = (list[0]?.number ?? 0) + 1;
    const version: FakeVersion = {
      ...from,
      id: `ver${artifact.id}${number}`,
      number,
      expiresAt: null,
    };
    for (const old of list) old.expiresAt ??= "2026-11-15T12:00:00.000Z";
    server.versions[artifact.id] = [version, ...list];
    artifact.currentVersionId = version.id;
    return json({
      artifactId: artifact.id,
      versionId: version.id,
      versionNumber: number,
      url: artifact.url,
      expiresAt: "2026-12-08T12:00:00.000Z",
      fromVersionId: from.id,
      fromVersionNumber: from.number,
    });
  }
  if (versions[2] !== "versions" || method !== "GET") return apiError("not_found", 404);
  if (!versions[3]) {
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const items = list.slice(start, start + server.pageSize);
    const next = start + server.pageSize;
    return json({
      artifactId: artifact.id,
      items: items.map((v) => summaryOf(v, artifact.currentVersionId)),
      nextCursor: next < list.length ? String(next) : null,
      retention: {
        previousVersions: server.usage.plan.limits.retainedPreviousVersions,
        days: server.usage.plan.limits.previousVersionRetentionDays,
      },
      versionDiff: server.usage.plan.features.includes("versionDiff"),
    });
  }
  const ref = versions[3] === "current" ? artifact.currentVersionId : versions[3];
  const version = list.find((v) => v.id === ref);
  if (!version) return apiError("not_found", 404);
  if (!versions[4]) {
    return json({
      ...summaryOf(version, artifact.currentVersionId),
      artifactId: artifact.id,
      files: version.files,
    });
  }
  const kind = url.searchParams.get("kind") ?? "published";
  const only = url.searchParams.get("path");
  const files = version.files.filter((f) => f.kind === kind && (!only || f.path === only));
  if (files.length === 0) return apiError("not_found", 404);
  return json({
    artifactId: artifact.id,
    versionId: version.id,
    versionNumber: version.number,
    kind,
    entrypoint: version.entrypoint,
    files: files.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      size: f.size,
      contentType: f.contentType,
      method: "GET",
      url: `https://storage.test/download/${f.sha256}?sig=1`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })),
  });
}

/** The comparison routes, from the seeded files and the plan in `usage`, like the Worker. */
function diffRoute(server: FakeServer, match: RegExpExecArray, url: URL): Response {
  const artifact = server.artifacts.find((a) => a.id === match[1]);
  if (!artifact) return apiError("not_found", 404);
  if (!server.usage.plan.features.includes("versionDiff")) return apiError("plan_required", 403);
  const list = server.versions[artifact.id] ?? [];
  const find = (ref: string) =>
    list.find((v) => v.id === (ref === "current" ? artifact.currentVersionId : ref));
  const from = find(decodeURIComponent(match[2] as string));
  const to = find(decodeURIComponent(match[3] as string));
  if (!from || !to) return apiError("not_found", 404);
  const key = (f: ManifestFile) => `${f.kind}\u0000${f.path}`;
  const a = new Map(from.files.map((f) => [key(f), f]));
  const b = new Map(to.files.map((f) => [key(f), f]));
  const side = (f: ManifestFile | undefined) =>
    f ? { sha256: f.sha256, size: f.size, contentType: f.contentType } : null;
  const files = [...new Set([...a.keys(), ...b.keys()])].sort().map((k) => {
    const before = a.get(k);
    const after = b.get(k);
    const any = (before ?? after) as ManifestFile;
    const change: FileChange = !before
      ? "added"
      : !after
        ? "removed"
        : before.sha256 === after.sha256
          ? "unchanged"
          : "changed";
    return { kind: any.kind, path: any.path, change, before: side(before), after: side(after) };
  });
  const versionsOf = {
    from: { id: from.id, number: from.number },
    to: { id: to.id, number: to.number },
  };
  if (!match[4]) {
    const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
    for (const file of files) counts[file.change] += 1;
    return json({
      artifactId: artifact.id,
      ...versionsOf,
      counts,
      files: files.filter((file) => file.change !== "unchanged"),
      nextCursor: null,
    });
  }
  const file = files.find(
    (f) =>
      f.kind === (url.searchParams.get("kind") ?? "published") &&
      f.path === url.searchParams.get("path"),
  );
  if (!file) return apiError("not_found", 404);
  const answer = (diff: unknown) => json({ artifactId: artifact.id, ...versionsOf, ...file, diff });
  if (file.change === "unchanged") return answer({ status: "identical" });
  if ([file.before, file.after].some((f) => textDiffEligibility(f) === "binary")) {
    return answer({ status: "binary" });
  }
  const text = (f: { sha256: string } | null) => (f ? (server.texts.get(f.sha256) ?? "") : "");
  const result = diffText(text(file.before), text(file.after));
  if (result.status !== "text") return answer({ status: result.status });
  return answer({ ...result, nextCursor: null });
}

/** Where a new artifact lives: the workspace a slug names, or the personal space. */
function ownerOf(server: FakeServer, slug: string | null): OwnerView {
  const found = slug ? server.workspaces[slug] : undefined;
  return found
    ? { kind: "workspace", slug: found.view.slug, name: found.view.name }
    : { kind: "personal" };
}

const seatsOf = (w: FakeWorkspace) => ({
  used: w.members.length + w.invitations.length,
  limit: w.seats,
});

/** The workspace routes, answered like the Worker: a slug the caller is not in is missing. */
function workspaceRoute(server: FakeServer, method: string, url: URL): Response | undefined {
  const path = url.pathname;
  const body = server.bodies.at(-1) as Record<string, unknown> | undefined;
  if (path === "/api/v1/workspaces" && method === "GET") {
    return json({ items: Object.values(server.workspaces).map((w) => w.view) });
  }
  if (path === "/api/v1/account/invitations" && method === "GET") {
    return json({ items: server.incoming });
  }
  const answered = /^\/api\/v1\/account\/invitations\/([^/]+)\/(accept|decline)$/.exec(path);
  if (answered && method === "POST") {
    const invitation = server.incoming.find((i) => i.id === answered[1]);
    if (!invitation) return apiError("not_found", 404);
    server.incoming = server.incoming.filter((i) => i !== invitation);
    if (answered[2] === "decline") return new Response(null, { status: 204 });
    const view: WorkspaceView = {
      slug: invitation.workspace.slug,
      name: invitation.workspace.name,
      role: invitation.role,
      region: "default",
      createdAt: NOW,
      policy: { ...DEFAULT_POLICY, commentRetentionToken: null },
      blocked: false,
      blockedBy: null,
    };
    server.workspaces[view.slug] = workspace(view.slug, view.role, { name: view.name });
    return json(view);
  }
  if (path === "/api/v1/invitations/lookup" && method === "POST") {
    const found = server.links[String(body?.token)];
    return found ? json(found) : apiError("not_found", 404);
  }
  const link = /^\/api\/v1\/invitations\/(accept|decline)$/.exec(path);
  if (link && method === "POST") {
    const found = server.links[String(body?.token)];
    if (found?.status !== "invited") return apiError("not_found", 404);
    delete server.links[String(body?.token)];
    if (link[1] === "decline") return new Response(null, { status: 204 });
    const { workspace: target, role } = found.invitation;
    server.workspaces[target.slug] = workspace(target.slug, role, { name: target.name });
    return json(server.workspaces[target.slug]?.view);
  }
  const groups =
    /^\/api\/v1\/workspaces\/([^/]+)\/groups(?:\/([^/]+))?(?:\/members(?:\/([^/]+))?|\/stop-sync)?$/.exec(
      path,
    );
  if (groups) return groupRoute(server, groups, path, method, body);
  const policies = /^\/api\/v1\/workspaces\/([^/]+)\/policies(\/preview)?$/.exec(path);
  if (policies) return policyRoute(server, policies, method, body);
  const trust = /^\/api\/v1\/workspaces\/([^/]+)\/github-trust(?:\/([^/]+))?$/.exec(path);
  if (trust) return githubTrustRoute(server, trust, method, body);
  const tokens = /^\/api\/v1\/workspaces\/([^/]+)\/service-tokens(?:\/([^/]+))?$/.exec(path);
  if (tokens) return serviceTokenRoute(server, tokens, method, body);
  const scoped = /^\/api\/v1\/workspaces\/([^/]+)\/(members|invitations|leave)(?:\/([^/]+))?$/.exec(
    path,
  );
  const domains = /^\/api\/v1\/workspaces\/([^/]+)\/domains(?:\/([^/]+))?(\/verify)?$/.exec(path);
  if (domains) return domainRoute(server, method, domains, body);
  const sso = /^\/api\/v1\/workspaces\/([^/]+)\/sso(\/test)?$/.exec(path);
  if (sso) return ssoRoute(server, method, sso, body);
  const scim = /^\/api\/v1\/workspaces\/([^/]+)\/scim(?:\/tokens(?:\/([^/]+))?)?$/.exec(path);
  if (scim) return scimRoute(server, method, path, scim, body);
  if (!scoped) return undefined;
  const w = server.workspaces[decodeURIComponent(scoped[1] ?? "")];
  if (!w) return apiError("not_found", 404);
  const admin = w.view.role === "admin";
  const admins = () => w.members.filter((m) => m.role === "admin").length;
  const [, , kind, id] = scoped;
  if (kind === "members" && !id && method === "GET") {
    return json({ workspace: w.view, items: w.members, seats: seatsOf(w) });
  }
  if (kind === "leave" && method === "POST") {
    const me = w.members.find((m) => m.you);
    if (me?.role === "admin" && admins() <= 1) return apiError("sole_workspace_admin", 409);
    delete server.workspaces[w.view.slug];
    return new Response(null, { status: 204 });
  }
  if (!admin) return apiError("forbidden", 403);
  if (kind === "members" && id) {
    const member = w.members.find((m) => m.userId === decodeURIComponent(id));
    if (!member) return apiError("not_found", 404);
    if (
      member.role === "admin" &&
      admins() <= 1 &&
      (method === "DELETE" || body?.role !== "admin")
    ) {
      return apiError("sole_workspace_admin", 409);
    }
    if (method === "DELETE") {
      w.members = w.members.filter((m) => m !== member);
      return new Response(null, { status: 204 });
    }
    member.role = body?.role as WorkspaceView["role"];
    return json(member);
  }
  if (kind === "invitations" && !id && method === "GET") {
    return json({ items: w.invitations, seats: seatsOf(w) });
  }
  if (kind === "invitations" && !id && method === "POST") {
    const email = String(body?.email).toLowerCase();
    const replaced = w.invitations.filter((i) => i.email !== email);
    if (w.members.length + replaced.length >= w.seats) return apiError("seats_exhausted", 409);
    const invitation: InvitationView = {
      id: `inv_${String(w.invitations.length + 1).padStart(32, "0")}`,
      email,
      role: body?.role as WorkspaceView["role"],
      invitedBy: "Ada",
      createdAt: NOW,
      expiresAt: "2026-11-15T12:00:00.000Z",
      source: "admin",
    };
    w.invitations = [...replaced, invitation];
    return json(invitation, 201);
  }
  if (kind === "invitations" && id && method === "DELETE") {
    const before = w.invitations.length;
    w.invitations = w.invitations.filter((i) => i.id !== id);
    return w.invitations.length < before
      ? new Response(null, { status: 204 })
      : apiError("not_found", 404);
  }
  return undefined;
}

/** The email domain routes, answered like the Worker: admins only, a missing slug is missing. */
/** Single sign-on settings as the API answers them (decision 0016). */
function ssoSettings(w: FakeWorkspace): SsoSettings {
  const verified = w.domains.filter((d) => d.state === "verified").map((d) => d.domain);
  const provider = w.sso.provider;
  const lapsed = provider ? provider.domains.filter((d) => !verified.includes(d)) : [];
  const state = !provider
    ? "off"
    : !w.sso.available
      ? "plan"
      : lapsed.length === provider.domains.length
        ? "domains"
        : "on";
  return {
    state,
    provider: provider ? { ...provider, lapsedDomains: lapsed } : null,
    available: w.sso.available,
    verifiedDomains: verified,
    redirectUriPattern: "https://app.portifact.com/api/auth/sso/callback/<id>",
  };
}

/** The Directory sync settings as the API answers them (decision 0017). */
function scimOverview(w: FakeWorkspace): ScimOverview {
  const choices = w.groups
    .filter((g) => g.directory)
    .map((g) => ({
      id: g.id,
      name: g.name,
      members: g.memberIds.length,
      pending: g.pendingIds?.length ?? 0,
    }));
  return {
    baseUrl: "https://app.portifact.com/scim/v2",
    available: w.scim.available,
    tokens: w.scim.tokens,
    limit: 2,
    invitationEmails: w.scim.invitationEmails,
    lastSyncAt: w.scim.lastSyncAt,
    pending: w.invitations.filter((i) => i.source === "directory").length,
    groups: choices,
    roleMapping: {
      editor: choices.find((g) => g.id === w.scim.editorGroup) ?? null,
      admin: choices.find((g) => g.id === w.scim.adminGroup) ?? null,
    },
  };
}

function scimRoute(
  server: FakeServer,
  method: string,
  path: string,
  match: RegExpExecArray,
  body: Record<string, unknown> | undefined,
): Response {
  const w = server.workspaces[decodeURIComponent(match[1] ?? "")];
  if (!w) return apiError("not_found", 404);
  if (!w.scim.enabled) return apiError("capacity_unavailable", 503);
  if (w.view.role !== "admin") return apiError("forbidden", 403);
  if (path.endsWith("/scim")) {
    if (method === "PATCH") {
      if (body?.invitationEmails !== undefined) {
        w.scim.invitationEmails = body.invitationEmails === true;
      }
      if (body?.editorGroup !== undefined) w.scim.editorGroup = body.editorGroup as string | null;
      if (body?.adminGroup !== undefined) {
        // Like the API: mapping a group to admin needs the confirmation naming it.
        if (body.adminGroup !== null && body.confirmAdminGroup !== body.adminGroup) {
          return apiError("invalid_input", 400);
        }
        w.scim.adminGroup = body.adminGroup as string | null;
      }
    }
    return json(scimOverview(w));
  }
  if (method === "POST") {
    if (!w.scim.available) return apiError("plan_required", 403);
    if (w.scim.tokens.length >= 2) return apiError("quota_exceeded", 409);
    const token: ScimTokenView = {
      id: `sc_${String(w.scim.tokens.length + 1).padStart(32, "0")}`,
      label: String(body?.label ?? ""),
      createdAt: NOW,
      expiresAt: "2027-11-10T12:00:00.000Z",
      lastUsedAt: null,
      createdBy: { name: "Ada" },
      expired: false,
    };
    w.scim.tokens = [...w.scim.tokens, token];
    return json({ token, secret: `pfsc_${"A".repeat(43)}` }, 201);
  }
  if (method === "DELETE") {
    const id = decodeURIComponent(match[2] ?? "");
    if (!w.scim.tokens.some((token) => token.id === id)) return apiError("not_found", 404);
    w.scim.tokens = w.scim.tokens.filter((token) => token.id !== id);
    return new Response(null, { status: 204 });
  }
  return apiError("not_found", 404);
}

function ssoRoute(
  server: FakeServer,
  method: string,
  match: RegExpExecArray,
  body: Record<string, unknown> | undefined,
): Response {
  const w = server.workspaces[decodeURIComponent(match[1] ?? "")];
  if (!w) return apiError("not_found", 404);
  if (!w.sso.enabled) return apiError("capacity_unavailable", 503);
  if (w.view.role !== "admin") return apiError("forbidden", 403);
  if (match[2] && method === "POST") {
    if (!w.sso.available) return apiError("plan_required", 403);
    const issuer = String(body?.issuer ?? "");
    if (issuer.includes("broken")) return json({ ok: false, problem: "issuer_mismatch" });
    const host = new URL(issuer).hostname;
    return json({ ok: true, hosts: { authorization: host, token: host, keys: host } });
  }
  if (method === "GET") return json(ssoSettings(w));
  if (method === "PUT") {
    if (!w.sso.available) return apiError("plan_required", 403);
    const issuer = String(body?.issuer ?? "");
    if (issuer.includes("broken")) return apiError("invalid_input", 400);
    const id = `sso_${"5".repeat(32)}`;
    w.sso.provider = {
      id,
      issuer,
      clientId: String(body?.clientId ?? ""),
      domains: (body?.domains as string[]) ?? [],
      lapsedDomains: [],
      hasClientSecret: true,
      redirectUri: `https://app.portifact.com/api/auth/sso/callback/${id}`,
      createdAt: NOW,
      updatedAt: NOW,
    };
    return json(ssoSettings(w));
  }
  if (method === "DELETE") {
    if (!w.sso.provider) return apiError("not_found", 404);
    w.sso.provider = null;
    return json({ removed: true });
  }
  return apiError("not_found", 404);
}

function domainRoute(
  server: FakeServer,
  method: string,
  match: RegExpExecArray,
  body: Record<string, unknown> | undefined,
): Response {
  const w = server.workspaces[decodeURIComponent(match[1] ?? "")];
  if (!w) return apiError("not_found", 404);
  if (w.view.role !== "admin") return apiError("forbidden", 403);
  const [, , id, verify] = match;
  if (!id && method === "GET") {
    return json({ items: w.domains, available: w.domainsAvailable, limit: 10 });
  }
  if (!id && method === "POST") {
    if (!w.domainsAvailable) return apiError("plan_required", 403);
    const domain = String(body?.domain).trim().toLowerCase();
    if (domain === "gmail.com") return apiError("invalid_input", 400);
    const existing = w.domains.find((d) => d.domain === domain);
    if (existing) return json(existing, 201);
    const n = String(w.domains.length + 1).padStart(32, "0");
    const view: WorkspaceDomainView = {
      id: `wd_${n}`,
      domain,
      unicode: null,
      state: "pending",
      record: { name: `_portifact-email.${domain}`, value: `portifact-email-verify=${n}` },
      createdAt: NOW,
      verifiedAt: null,
      checkedAt: null,
      expiresAt: "2026-11-15T12:00:00.000Z",
      failedChecks: 0,
      problem: null,
    };
    w.domains = [...w.domains, view];
    return json(view, 201);
  }
  const found = w.domains.find((d) => d.id === decodeURIComponent(id ?? ""));
  if (!found) return apiError("not_found", 404);
  if (verify && method === "POST") {
    if (!(w.dns[found.record.name] ?? []).includes(found.record.value)) {
      return apiError("invalid_input", 400);
    }
    Object.assign(found, { state: "verified", verifiedAt: NOW, checkedAt: NOW, expiresAt: null });
    return json(found);
  }
  if (method === "DELETE") {
    w.domains = w.domains.filter((d) => d !== found);
    return json({ id: found.id, removed: true });
  }
  return apiError("not_found", 404);
}

function route(server: FakeServer, method: string, url: URL, headers: Headers): Response {
  const scoped = workspaceRoute(server, method, url);
  if (scoped) return scoped;
  const publishing = publishingRoute(server, method, url, headers);
  if (publishing) return publishing;
  const path = url.pathname;
  const viewed = /^\/api\/v1\/artifacts\/([^/]+)\/viewer$/.exec(path);
  if (viewed && method === "GET") return viewerRoute(server, viewed[1] ?? "");
  const approval = /^\/api\/v1\/artifacts\/([^/]+)\/review\/(request|status|verdict)$/.exec(path);
  if (approval) {
    const artifactId = approval[1] as string;
    const none: ApprovalReviewView = {
      artifactId,
      role: "owner",
      available: true,
      review: NO_APPROVAL_REVIEW,
      request: null,
    };
    if (method === "GET") return json(server.approvals[artifactId] ?? none);
    const reply = server.approvalReply;
    if (reply && "error" in reply) return apiError(reply.error, reply.status);
    const next = reply ?? (method === "DELETE" ? none : (server.approvals[artifactId] ?? none));
    server.approvals[artifactId] = next;
    return json(next, method === "POST" && approval[2] === "request" ? 201 : 200);
  }
  const integrations = integrationRoute(server, method, path, headers);
  if (integrations) return integrations;
  const reviewed = /^\/api\/v1\/artifacts\/([^/]+)\/(review|annotations)(\/.*)?$/.exec(path);
  if (reviewed)
    return reviewRoute(server, method, url, reviewed[1] ?? "", reviewed[2], reviewed[3]);
  if (path === "/api/auth/get-session") {
    return Response.json(
      server.email
        ? { user: { email: server.email, name: "Ada", createdAt: server.createdAt } }
        : null,
    );
  }
  if (path === "/api/auth/list-accounts") {
    return Response.json(server.providers.map((p, i) => ({ id: `acc${i}`, accountId: "1", ...p })));
  }
  if (path === "/api/v1/account/sessions" && method === "GET") {
    return Response.json({ items: server.sessions });
  }
  if (path === "/api/v1/account/sessions/sign-out-others" && method === "POST") {
    const before = server.sessions.length;
    server.sessions = server.sessions.filter((s) => s.current);
    return Response.json({ signedOut: before - server.sessions.length });
  }
  const mute = /^\/api\/v1\/account\/comment-notices\/([^/]+)$/.exec(path);
  if (mute) {
    const id = decodeURIComponent(mute[1] as string);
    const current = server.commentNotices[id] ?? { available: false, muted: false };
    if (method === "PUT") {
      const { muted } = server.bodies.at(-1) as { muted: boolean };
      server.commentNotices[id] = { ...current, muted };
    }
    return Response.json(server.commentNotices[id] ?? current);
  }
  if (path === "/api/v1/account/settings" && method === "GET") {
    return Response.json(server.settings);
  }
  if (path === "/api/v1/account/settings" && method === "PATCH") {
    const update = server.bodies.at(-1) as Partial<AccountSettings>;
    if (update.defaultAccessMode === "public" && server.createdAt) {
      const age = Date.now() - Date.parse(server.createdAt);
      if (age < LIMITS.publicAccessMinAccountAgeMinutes * 60_000) {
        return apiError("account_too_new_for_public", 403);
      }
    }
    server.settings = { ...server.settings, ...update };
    return Response.json(server.settings);
  }
  if (path.startsWith("/api/v1/account/branding")) {
    const slug = url.searchParams.get("workspace");
    if (!slug) return brandingRoute(server, method, path);
    const w = server.workspaces[slug];
    if (!w) return apiError("not_found", 404);
    if (w.view.role !== "admin") return apiError("forbidden", 403);
    // The workspace's brand, through the same fake as the personal one.
    const personal = server.branding;
    server.branding = w.branding;
    try {
      return brandingRoute(server, method, path);
    } finally {
      w.branding = server.branding;
      server.branding = personal;
    }
  }
  if (path === "/api/v1/account/delete" && method === "POST") {
    const body = server.bodies.at(-1) as { confirmEmail?: string } | undefined;
    if (body?.confirmEmail?.trim().toLowerCase() !== server.email) {
      return Response.json({ error: { code: "invalid_input", message: "x" } }, { status: 400 });
    }
    server.email = null;
    return Response.json({ deleted: true });
  }
  const shares = /^\/api\/v1\/artifacts\/([^/]+)\/share-links(?:\/([^/]+))?$/.exec(path);
  if (shares) {
    const artifact = server.artifacts.find((a) => a.id === shares[1]);
    if (!artifact) return apiError("not_found", 404);
    const links = server.shareLinks[artifact.id] ?? [];
    if (method === "GET" && !shares[2]) {
      return json({
        artifactId: artifact.id,
        enabled: server.shareLinksEnabled,
        links,
        activeLimit: 20,
      } satisfies ShareLinkList);
    }
    if (method === "POST" && !shares[2]) {
      if (!server.shareLinksEnabled) return apiError("plan_required", 403);
      const body = server.bodies.at(-1) as { label: string; expiresAt?: string; password?: string };
      const link: ShareLinkView = {
        id: `sl_${String(links.length + 1).padStart(32, "0")}`,
        label: body.label,
        state: "active",
        hasPassword: body.password !== undefined,
        createdAt: "2026-11-10T12:00:00.000Z",
        expiresAt: body.expiresAt ?? null,
        lastUsedOn: null,
      };
      server.shareLinks[artifact.id] = [link, ...links];
      return json(
        { link, url: `https://app.portifact.com/s#${"T".repeat(43)}` } satisfies ShareLinkCreated,
        201,
      );
    }
    if (method === "DELETE" && shares[2]) {
      const id = decodeURIComponent(shares[2]);
      if (!links.some((link) => link.id === id)) return apiError("not_found", 404);
      server.shareLinks[artifact.id] = links.filter((link) => link.id !== id);
      return json({ id, revoked: true });
    }
  }
  const stats = /^\/api\/v1\/artifacts\/([^/]+)\/stats$/.exec(path);
  if (stats && method === "GET") {
    const artifact = server.artifacts.find((a) => a.id === stats[1]);
    if (!artifact) return apiError("not_found", 404);
    const body = server.stats[artifact.id];
    if (!body) {
      return Response.json(
        { error: { code: "plan_required", message: planRequiredMessage("analytics") } },
        { status: 403 },
      );
    }
    return json({ ...body, from: url.searchParams.get("from") ?? body.from });
  }
  if (path === "/api/v1/domains" && method === "GET") {
    const artifactId = url.searchParams.get("artifactId");
    return json({
      available: server.domainsAvailable,
      enabled: server.domainsEnabled,
      limit: server.domainsEnabled ? 1 : 0,
      used: server.domains.filter((d) => d.state === "active" || d.state === "provisioning").length,
      cnameTarget: "domains.portifact.dev",
      domains: server.domains.filter((d) => artifactId === null || d.artifactId === artifactId),
    } satisfies CustomDomainList);
  }
  const addDomain = /^\/api\/v1\/artifacts\/([^/]+)\/domain$/.exec(path);
  if (addDomain && method === "POST") {
    if (!server.domainsEnabled) return apiError("plan_required", 403);
    const hostname = (server.bodies.at(-1) as { hostname: string }).hostname.toLowerCase();
    const view: CustomDomainView = {
      hostname,
      artifactId: addDomain[1] as string,
      state: "pending",
      records: [
        {
          type: "TXT",
          name: `_portifact.${hostname}`,
          value: `portifact-verify=${"a".repeat(32)}`,
        },
        { type: "CNAME", name: hostname, value: "domains.portifact.dev" },
      ],
      claimExpiresAt: "2026-11-17T12:00:00.000Z",
      verifiedAt: null,
      checkedAt: null,
      missedChecks: 0,
      problem: null,
    };
    server.domains = [...server.domains.filter((d) => d.hostname !== hostname), view];
    return json(view, 201);
  }
  const named = /^\/api\/v1\/domains\/([^/]+)(\/verify)?$/.exec(path);
  if (named) {
    const hostname = decodeURIComponent(named[1] as string);
    const found = server.domains.find((d) => d.hostname === hostname);
    if (!found) return apiError("not_found", 404);
    if (method === "POST" && named[2]) return json(found);
    if (method === "DELETE" && !named[2]) {
      server.domains = server.domains.map((d) =>
        d.hostname === hostname ? { ...d, state: "removing" as const } : d,
      );
      return json({ hostname, removed: true });
    }
  }
  const log = /^\/api\/v1\/artifacts\/([^/]+)\/access-log$/.exec(path);
  if (log && method === "GET") {
    const artifact = server.artifacts.find((a) => a.id === log[1]);
    if (!artifact) return apiError("not_found", 404);
    const all = server.accessLogs[artifact.id] ?? [];
    const offset = Number(url.searchParams.get("cursor") ?? "0");
    const size = Math.min(Number(url.searchParams.get("limit") ?? "50"), server.pageSize);
    const page = all.slice(offset, offset + size);
    const next = offset + size;
    return json({
      artifactId: artifact.id,
      entries: page,
      nextCursor: next < all.length ? String(next) : null,
      windowMinutes: 30,
      retentionDays: 30,
    } satisfies AccessLogView);
  }
  if (path === "/api/v1/audit" && method === "GET") {
    const slug = url.searchParams.get("workspace") ?? "";
    if (slug !== "") {
      const w = server.workspaces[slug];
      if (!w) return apiError("not_found", 404);
      if (w.view.role !== "admin") return apiError("forbidden", 403);
    }
    const events = server.audit[slug];
    if (!events) return apiError("plan_required", 403);
    const kinds = url.searchParams.getAll("kind");
    const actor = url.searchParams.get("actor");
    const from = url.searchParams.get("from");
    const all = events.filter(
      (event) =>
        (kinds.length === 0 || kinds.includes(event.kind)) &&
        (!actor || ("id" in event.actor && event.actor.id === actor)) &&
        (!from || event.at >= from),
    );
    const offset = Number(url.searchParams.get("cursor") ?? "0");
    const page = all.slice(offset, offset + server.pageSize);
    const next = offset + server.pageSize;
    return json({
      owner: slug === "" ? { kind: "personal" } : { kind: "workspace", slug, name: slug },
      events: page,
      nextCursor: next < all.length ? String(next) : null,
      retentionDays: server.auditRetentionDays,
      exportable: server.auditExportable.has(slug),
    } satisfies AuditLogView);
  }
  if (path.startsWith("/api/v1/audit/streams")) return auditStreamRoute(server, url, method);
  if (path === "/api/v1/audit/export" && method === "GET") {
    const slug = url.searchParams.get("workspace") ?? "";
    const events = server.audit[slug];
    if (!events) return apiError("plan_required", 403);
    if (!server.auditExportable.has(slug)) return apiError("plan_required", 403);
    const format = url.searchParams.get("format") === "csv" ? "csv" : "jsonl";
    const kinds = url.searchParams.getAll("kind");
    const all = events.filter((event) => kinds.length === 0 || kinds.includes(event.kind));
    const cursor = url.searchParams.get("cursor");
    const offset = Number(cursor ?? "0");
    const next = offset + server.auditExportPart;
    const text =
      (cursor === null ? auditExportPreamble(format) : "") +
      all
        .slice(offset, next)
        .map((event) => auditExportLine(format, event))
        .join("");
    return new Response(text, {
      headers: {
        "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/jsonl",
        ...(next < all.length ? { "portifact-next-cursor": String(next) } : {}),
      },
    });
  }
  if (path === "/api/v1/search" && method === "GET") {
    const slug = url.searchParams.get("workspace") ?? "";
    const space = slug ? server.workspaces[slug] : undefined;
    if (slug && !space) return apiError("not_found", 404);
    if (space?.view.role === "member") return apiError("forbidden", 403);
    const usage = space ? space.usage : server.usage;
    if (!usage.plan.features.includes("contentSearch")) return apiError("plan_required", 403);
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const items = (server.search[slug] ?? [])
      .filter((hit) => hit.snippet.text.toLowerCase().includes(q))
      .flatMap((hit) => {
        const found = server.artifacts.find((a) => a.id === hit.artifactId);
        return found
          ? [
              {
                ...hit,
                artifact: {
                  ...found,
                  activity: server.activity[found.id] ?? DEFAULT_ACTIVITY,
                  review: server.approvals[found.id]?.review ?? NO_APPROVAL_REVIEW,
                },
              },
            ]
          : [];
      })
      .map(({ artifactId: _id, ...hit }) => hit);
    return Response.json({ items, nextCursor: null });
  }
  if (path === "/api/v1/grace-forecast" && method === "GET") {
    const slug = url.searchParams.get("workspace");
    if (slug && !server.workspaces[slug]) return apiError("not_found", 404);
    return Response.json(server.graceForecast);
  }
  if (path === "/api/v1/usage" && method === "GET") {
    const slug = url.searchParams.get("workspace");
    if (!slug) return Response.json(server.usage);
    const w = server.workspaces[slug];
    if (!w) return apiError("not_found", 404);
    return w.view.role === "member" ? apiError("forbidden", 403) : Response.json(w.usage);
  }
  const transfer = /^\/api\/v1\/artifacts\/([^/]+)\/transfer$/.exec(path);
  if (transfer && method === "POST") {
    const moved = server.artifacts.find((a) => a.id === transfer[1]);
    if (!moved) return apiError("not_found", 404);
    const target = (server.bodies.at(-1) as { workspace: string | null }).workspace;
    if (target !== null && !server.workspaces[target]) return apiError("not_found", 404);
    moved.owner = ownerOf(server, target);
    return Response.json(moved);
  }
  if (path.startsWith("/api/v1/webhooks")) {
    const hooks = server.webhooks;
    const refused = () =>
      Response.json(
        { error: { code: "plan_required", message: "Webhooks is part of the Pro plan." } },
        { status: 403 },
      );
    if (path === "/api/v1/webhooks" && method === "GET") {
      return Response.json({
        webhooks: hooks.list,
        available: hooks.available,
        serviceAvailable: hooks.offered ?? true,
        limit: 10,
      });
    }
    if (path === "/api/v1/webhooks" && method === "POST") {
      if (!hooks.available) return refused();
      const body = server.bodies.at(-1) as {
        url: string;
        format: WebhookView["format"];
        events: WebhookView["events"];
      };
      let host: string;
      try {
        const url = new URL(body.url);
        if (url.protocol !== "https:") throw new Error("http");
        host = url.hostname;
      } catch {
        return Response.json(
          { error: { code: "invalid_input", message: "The URL must start with https://." } },
          { status: 400 },
        );
      }
      const webhook: WebhookView = {
        id: `wh_${String(hooks.list.length + 1).padStart(32, "0")}`,
        host,
        format: body.format,
        events: body.events,
        state: "active",
        disabledReason: null,
        disabledAt: null,
        failures: 0,
        createdAt: "2026-11-10T09:00:00.000Z",
        createdVia: "dashboard",
        createdBy: "Ada",
        probation: false,
        lastAttempt: null,
      };
      hooks.list = [...hooks.list, webhook];
      return Response.json(
        { webhook, secret: body.format === "generic" ? "whsec_sample-secret-for-tests" : null },
        { status: 201 },
      );
    }
    const match = /^\/api\/v1\/webhooks\/([^/]+)(\/test|\/deliveries)?$/.exec(path);
    const webhook = match && hooks.list.find((w) => w.id === match[1]);
    if (!match || !webhook) {
      return Response.json(
        { error: { code: "not_found", message: "Webhook not found." } },
        { status: 404 },
      );
    }
    if (match[2] === "/deliveries") {
      return Response.json({
        webhookId: webhook.id,
        attempts: hooks.attempts[webhook.id] ?? [],
        retentionDays: 7,
      });
    }
    if (match[2] === "/test") {
      if (!hooks.available) return refused();
      server.webhookTests.push(webhook.id);
      return Response.json({ webhookId: webhook.id, queued: true }, { status: 202 });
    }
    if (method === "DELETE") {
      hooks.list = hooks.list.filter((w) => w.id !== webhook.id);
      return Response.json({ webhookId: webhook.id, removed: true });
    }
    const change = server.bodies.at(-1) as { enabled?: boolean };
    if (change.enabled === true && !hooks.available) return refused();
    const next: WebhookView =
      change.enabled === false
        ? {
            ...webhook,
            state: "disabled",
            disabledReason: "manual",
            disabledAt: "2026-11-10T10:00:00.000Z",
          }
        : { ...webhook, state: "active", disabledReason: null, disabledAt: null, failures: 0 };
    hooks.list = hooks.list.map((w) => (w.id === webhook.id ? next : w));
    return Response.json(next);
  }
  if (path === "/api/v1/account/apps" && method === "GET") {
    return Response.json({ items: server.apps });
  }
  const app = /^\/api\/v1\/account\/apps\/([^/]+)$/.exec(path);
  if (app && method === "DELETE") {
    const clientId = decodeURIComponent(app[1] ?? "");
    if (!server.apps.some((a) => a.clientId === clientId)) {
      return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
    }
    server.apps = server.apps.filter((a) => a.clientId !== clientId);
    return Response.json({ clientId, disconnected: true });
  }
  const access = /^\/api\/v1\/artifacts\/([^/]+)\/access$/.exec(path);
  const owned = access && server.artifacts.find((a) => a.id === access[1]);
  if (access) {
    if (!owned)
      return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
    const space =
      owned.owner.kind === "workspace" ? server.workspaces[owned.owner.slug] : undefined;
    const policy: AccessPolicyView = server.access[owned.id] ?? {
      mode: owned.accessMode,
      readers: [],
      indexable: false,
      embeddable: false,
      bar: true,
      commentVisibility: "owner",
      readerCommentVisibility: [],
      policyGeneration: 1,
      groups: [],
      audience:
        owned.owner.kind === "workspace"
          ? {
              members: space?.members.length ?? 1,
              domains: (space?.domains ?? [])
                .filter((d) => d.state === "verified")
                .map((d) => d.domain),
              featureAvailable: space?.domainsAvailable ?? true,
            }
          : null,
    };
    server.access[owned.id] = policy;
    if (method === "GET") return Response.json(policy);
    return applyAccess(owned, policy, server.bodies.at(-1), space);
  }
  if (path === "/api/auth/sign-out" && method === "POST") return Response.json({ success: true });
  if (path === "/api/v1/artifacts" && method === "GET") {
    // Validated and filtered like the Worker: empty parameters are no filter.
    const query = ArtifactListQuery.safeParse(
      Object.fromEntries([...url.searchParams].filter(([, value]) => value !== "")),
    );
    if (!query.success) return apiError("invalid_input", 400);
    const { cursor, limit: _limit, ...filters } = query.data;
    const search = filters.search?.toLowerCase();
    const slug = url.searchParams.get("workspace");
    const space = slug ? server.workspaces[slug] : undefined;
    if (slug && !space) return apiError("not_found", 404);
    if (space?.view.role === "member") return apiError("forbidden", 403);
    const matching = server.artifacts.filter(
      (a) =>
        (slug
          ? a.owner.kind === "workspace" && a.owner.slug === slug
          : a.owner.kind === "personal") &&
        (search === undefined || a.name.toLowerCase().includes(search) || a.id.includes(search)) &&
        (filters.state === undefined || a.state === filters.state) &&
        (filters.type === undefined || a.type === filters.type) &&
        (filters.access === undefined || a.accessMode === filters.access) &&
        (filters.annotations === undefined || a.annotations === filters.annotations) &&
        (filters.expiring === undefined || expiringSoon(a)),
    );
    const start = Number(cursor ?? 0);
    const items = matching.slice(start, start + server.pageSize).map((a) => ({
      ...a,
      activity: server.activity[a.id] ?? DEFAULT_ACTIVITY,
      review: server.approvals[a.id]?.review ?? NO_APPROVAL_REVIEW,
    }));
    const next = start + server.pageSize;
    return Response.json({
      items,
      nextCursor: next < matching.length ? String(next) : null,
    });
  }
  const match = /^\/api\/v1\/artifacts\/([^/]+)(?:\/(renew|archive|restore|pin|unpin))?$/.exec(
    path,
  );
  const found = match && server.artifacts.find((a) => a.id === match[1]);
  if (!match || !found) {
    return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
  }
  if (method === "GET" && !match[2]) return Response.json(found);
  if (method === "DELETE" && !match[2]) {
    server.artifacts = server.artifacts.filter((a) => a !== found);
    return Response.json({ state: "deleted", expiresAt: null, purgeAt: null, pinned: false });
  }
  const action = match[2];
  if (action === "pin" && !server.usage.plan.features.includes("pin")) {
    return Response.json(
      { error: { code: "plan_required", message: planRequiredMessage("pin") } },
      { status: 403 },
    );
  }
  if (action === "pin") {
    Object.assign(found, { pinned: true, expiresAt: null });
  } else if (action === "unpin") {
    Object.assign(found, { pinned: false, expiresAt: "2027-01-07T12:00:00.000Z" });
  } else if (action === "archive") {
    Object.assign(found, {
      state: "archived",
      pinned: false,
      archivedAt: NOW,
      purgeAt: "2027-05-08T12:00:00.000Z",
    });
  } else {
    Object.assign(found, {
      state: "active",
      archivedAt: null,
      purgeAt: null,
      expiresAt: "2027-01-07T12:00:00.000Z",
    });
  }
  return Response.json({
    state: found.state,
    expiresAt: found.expiresAt,
    purgeAt: found.purgeAt,
    pinned: found.pinned,
  });
}

/** The brand routes like the Worker: paid plans set it, every plan removes it. */
function brandingRoute(server: FakeServer, method: string, path: string): Response {
  const state = server.branding;
  const refused = () =>
    Response.json(
      {
        error: {
          code: "plan_required",
          message: "Branding the Portifact bar is part of the Pro plan.",
        },
      },
      { status: 403 },
    );
  const now = new Date().toISOString();
  if (path === "/api/v1/account/branding") {
    if (method === "GET") return Response.json(state);
    if (method === "DELETE") {
      server.branding = { ...state, brand: null };
      return Response.json(server.branding);
    }
    if (method === "PUT") {
      if (!state.available) return refused();
      const update = server.bodies.at(-1) as BrandUpdate;
      if (/portifact/i.test(update.name)) return apiError("invalid_input", 400);
      server.branding = {
        ...state,
        brand: {
          name: update.name,
          link: update.link,
          accentColor: update.accentColor,
          logo: state.brand?.logo ?? null,
          updatedAt: now,
        },
      };
      return Response.json(server.branding);
    }
  }
  if (path === "/api/v1/account/branding/logo" && state.brand) {
    if (method === "DELETE") {
      server.branding = { ...state, brand: { ...state.brand, logo: null, updatedAt: now } };
      return Response.json(server.branding);
    }
    if (method === "PUT") {
      if (!state.available) return refused();
      const file = server.logoUploads.at(-1);
      if (!file || file.size > 100_000 || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
        return apiError("invalid_input", 400);
      }
      server.branding = {
        ...state,
        brand: {
          ...state.brand,
          logo: {
            sha256: "b".repeat(64),
            type: "image/png",
            width: 64,
            height: 32,
            bytes: file.size,
          },
          updatedAt: now,
        },
      };
      return Response.json(server.branding);
    }
  }
  return apiError("invalid_input", 400);
}

const missing = () =>
  Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });

/**
 * What the viewer's bar shows, like the Worker: `viewers` when set, else what the review and
 * annotations fakes imply. Anonymous visitors (no `email`) see only public artifacts.
 */
function viewerRoute(server: FakeServer, id: string): Response {
  const listed = server.artifacts.find((a) => a.id === id);
  const start = server.reviews[id];
  const info: ViewerInfo | undefined =
    server.viewers[id] ??
    (start && {
      artifactId: id,
      name: start.name,
      type: start.type,
      origin: start.origin,
      versionNumber: 1,
      accessMode: listed?.accessMode ?? "restricted",
      annotations: server.annotations[id]?.mode ?? "off",
      role: server.annotations[id]?.role === "participant" ? "reader" : "owner",
      brand: null,
    });
  if (!info) return missing();
  if (server.email === null) {
    return info.accessMode === "public" ? Response.json({ ...info, role: "anonymous" }) : missing();
  }
  return Response.json(info);
}

/** Issue integrations (decision 0018): the choices, the admins' connections and issue requests. */
function integrationRoute(
  server: FakeServer,
  method: string,
  path: string,
  headers: Headers,
): Response | null {
  const store = server.integrations;
  const issue = /^\/api\/v1\/artifacts\/([^/]+)\/annotations\/threads\/([^/]+)\/issue$/.exec(path);
  if (issue && method === "POST") {
    const body = server.bodies.at(-1) as { target: string };
    store.issues.push({
      artifactId: issue[1] as string,
      threadId: issue[2] as string,
      key: headers.get("idempotency-key") ?? "",
      body,
    });
    return Response.json(
      {
        id: `ti_${"1".repeat(32)}`,
        service: "github",
        target: body.target,
        state: "pending",
        key: null,
        url: null,
        failure: null,
        own: true,
        createdAt: NOW,
      },
      { status: 202 },
    );
  }
  if (path === "/api/v1/integrations" && method === "GET") {
    return Response.json({
      connections: store.offered
        ? store.connections.map(({ id, service, label, targets, usable }) => ({
            id,
            service,
            label,
            targets,
            usable,
          }))
        : [],
      available: store.available,
      serviceAvailable: store.offered,
      euResidency: store.euResidency,
    });
  }
  if (!path.startsWith("/api/v1/integrations/connections")) return null;
  if (path === "/api/v1/integrations/connections" && method === "GET") {
    return Response.json({
      connections: store.connections,
      available: store.available,
      serviceAvailable: store.offered,
      slackAvailable: store.offered && store.slackOffered,
      limit: 5,
      targetLimit: 10,
    });
  }
  if (path === "/api/v1/integrations/connections" && method === "POST") {
    const body = server.bodies.at(-1) as {
      service: "github" | "linear" | "jira" | "slack";
      label: string;
      credential?: string;
      targets?: string[];
      site?: string;
    };
    if (body.service === "slack") {
      // A pending Slack connection, as the Worker starts one: no credential, the setup to show.
      const id = `ic_${String(store.connections.length + 1).repeat(32)}`;
      const requestUrl = `https://app.portifact.com/integrations/slack/events/default/${id}`;
      const pending: IntegrationConnectionView = {
        id,
        service: "slack",
        label: body.label,
        site: null,
        targets: [],
        usable: false,
        identity: "",
        credentialHint: "",
        attention: "pending",
        slack: {
          requestUrl,
          manifest: JSON.stringify({
            settings: { event_subscriptions: { request_url: requestUrl } },
          }),
          createUrl: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
          manifestVersion: null,
          outdated: false,
        },
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: "Ada",
      };
      store.connections = [...store.connections, pending];
      return Response.json(pending, { status: 201 });
    }
    if (body.credential === undefined || body.targets === undefined) {
      return apiError("invalid_input", 400);
    }
    if (body.credential.length < 20) {
      return Response.json(
        {
          error: {
            code: "invalid_input",
            message: "GitHub refused the token: it is wrong, expired or revoked.",
          },
        },
        { status: 400 },
      );
    }
    const created: IntegrationConnectionView = {
      id: `ic_${String(store.connections.length + 1).repeat(32)}`,
      service: body.service,
      label: body.label,
      site: body.site?.replace(/\.atlassian\.net$/, "") ?? null,
      targets: body.targets.map((id) => ({ id, name: id })),
      usable: true,
      identity: "octo-bot",
      credentialHint: `\u2026${body.credential.slice(-4)}`,
      attention: null,
      slack: null,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "Ada",
    };
    store.connections = [...store.connections, created];
    return Response.json(created, { status: 201 });
  }
  const one = /^\/api\/v1\/integrations\/connections\/([^/]+)(\/test)?$/.exec(path);
  const connection = one && store.connections.find((c) => c.id === one[1]);
  if (!one || !connection) return apiError("not_found", 404);
  if (one[2] && method === "POST") {
    return Response.json(
      connection.attention
        ? {
            ok: false,
            identity: null,
            problem: "credential_rejected",
            target: null,
            message: "GitHub refused the token.",
          }
        : { ok: true, identity: connection.identity, problem: null, target: null, message: "ok" },
    );
  }
  if (method === "DELETE") {
    store.connections = store.connections.filter((c) => c.id !== connection.id);
    return Response.json({ connectionId: connection.id, removed: true });
  }
  if (method === "PATCH") {
    const body = server.bodies.at(-1) as {
      label?: string;
      botToken?: string;
      signingSecret?: string;
    };
    if (connection.service === "slack" && body.botToken !== undefined) {
      if (!body.botToken.startsWith("xoxb-")) {
        return Response.json(
          {
            error: {
              code: "invalid_input",
              message: "Paste the app's Bot User OAuth Token, which starts with xoxb-.",
            },
          },
          { status: 400 },
        );
      }
      const done: IntegrationConnectionView = {
        ...connection,
        usable: true,
        identity: "Acme",
        credentialHint: `\u2026${body.botToken.slice(-4)}`,
        attention: null,
        slack: connection.slack && { ...connection.slack, manifestVersion: 1 },
      };
      store.connections = store.connections.map((c) => (c.id === connection.id ? done : c));
      return Response.json(done);
    }
    const next = { ...connection, ...(body.label ? { label: body.label } : {}) };
    store.connections = store.connections.map((c) => (c.id === connection.id ? next : c));
    return Response.json(next);
  }
  return apiError("not_found", 404);
}

/** The review code and annotations endpoints, with the rules the viewer depends on. */
/**
 * Which threads a version filter covers, like the Worker: `current`, `all` or one version, and
 * other versions only for the owner (null when refused).
 */
function inVersion(
  store: FakeAnnotations,
  version: string,
): ((thread: AnnotationThreadView) => boolean) | null {
  if (version === "current" || version === store.currentVersionId) return (t) => t.current;
  if (store.role !== "owner") return null;
  if (version === "all") return () => true;
  return (t) => t.versionId === version;
}

function reviewRoute(
  server: FakeServer,
  method: string,
  url: URL,
  id: string,
  kind: string | undefined,
  rest = "",
): Response {
  if (kind === "review") {
    const start = server.reviews[id];
    if (method !== "POST" || !start) return missing();
    if (rest === "") return Response.json(start);
    if (rest !== "/tab") return missing();
    server.reviewTabs += 1;
    return Response.json({
      artifactId: id,
      url: `${start.origin}/__portifact/review/tab?code=${String(server.reviewTabs).padStart(43, "t")}`,
      origin: start.origin,
      versionId: start.versionId,
      expiresAt: start.expiresAt,
      sessionSeconds: 900,
    });
  }
  const store = server.annotations[id];
  if (rest === "/mode" && method === "PUT") {
    // Like the Worker: the owner's artifact takes the new mode, with or without threads.
    const owned = server.artifacts.find((a) => a.id === id);
    if (!owned) return missing();
    const mode = (server.bodies.at(-1) as { mode?: AnnotationsState } | undefined)?.mode;
    if (!mode) return apiError("invalid_input", 400);
    owned.annotations = mode;
    if (store) {
      store.mode = mode;
      store.seq += 1;
    }
    return Response.json({ annotations: mode });
  }
  if (!store) return missing();
  const body = server.bodies.at(-1) as Record<string, unknown> | undefined;
  const touch = (thread: FakeAnnotations["threads"][number]) => {
    store.seq += 1;
    thread.seq = store.seq;
    thread.revision += 1;
  };
  const view = ({ seq: _seq, ...thread }: FakeAnnotations["threads"][number]) => thread;
  const posting =
    method === "POST" && (rest === "/threads" || /^\/threads\/[^/]+\/messages$/.test(rest));
  if (posting && (store.humanChecks ?? 0) > 0) {
    if (!String(body?.turnstileToken ?? "").startsWith("solved")) {
      return Response.json(
        { error: { code: "human_verification_required", message: "x" } },
        { status: 403 },
      );
    }
    store.humanChecks = (store.humanChecks ?? 0) - 1;
  }
  if (rest === "" && method === "GET") {
    if (store.mode === "off" && store.role !== "owner") {
      return Response.json({ error: { code: "forbidden", message: "x" } }, { status: 403 });
    }
    const scoped = inVersion(store, url.searchParams.get("version") ?? "current");
    if (!scoped) return apiError("forbidden", 403);
    const since = Number(url.searchParams.get("cursor") ?? 0);
    return Response.json({
      artifactId: id,
      annotations: store.mode,
      currentVersionId: store.currentVersionId,
      role: store.role,
      commentScope: store.commentScope ?? "all",
      humanCheck: store.role === "participant" && (store.humanChecks ?? 0) > 0,
      threads: store.threads.filter((t) => t.seq > since && scoped(t)).map(view),
      removed: since > 0 ? store.deleted.filter((d) => d.seq > since).map((d) => d.id) : [],
      cursor: String(store.seq),
      hasMore: false,
    });
  }
  if (rest === "/history" && method === "GET") {
    if (store.role !== "owner") return apiError("forbidden", 403);
    const all = store.history ?? [];
    const from = Number(url.searchParams.get("cursor") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 200);
    return Response.json({
      artifactId: id,
      entries: all.slice(from, from + limit),
      nextCursor: from + limit < all.length ? String(from + limit) : null,
    });
  }
  if (rest === "/export" && method === "GET") {
    const scoped = inVersion(store, url.searchParams.get("version") ?? "current");
    if (!scoped) return apiError("forbidden", 403);
    const state = url.searchParams.get("state");
    const threads = store.threads
      .filter((t) => scoped(t) && (state === null || t.state === state))
      .map(view);
    const artifact = server.artifacts.find((a) => a.id === id);
    if (url.searchParams.get("format") === "markdown") {
      return new Response(`# ${artifact?.name}\n\n${threads.length} threads\n`, {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }
    return Response.json({
      notice: UNTRUSTED_ANNOTATIONS_NOTICE,
      exportedAt: NOW,
      artifact: {
        id,
        name: artifact?.name ?? id,
        type: artifact?.type ?? "site",
        annotations: store.mode,
        currentVersionId: store.currentVersionId,
      },
      threads,
    });
  }
  if (rest === "/threads" && method === "POST") {
    store.seq += 1;
    const thread = {
      ...fakeThread(`t${store.seq}`, {
        own: true,
        author: { id: "u-ada", name: "Ada", image: null },
        target: body?.target as AnnotationThreadView["target"],
        path: (body?.target as { path?: string } | undefined)?.path ?? "",
        versionId: body?.versionId as string,
        messages: [
          fakeMessage({
            own: true,
            author: { id: "u-ada", name: "Ada", image: null },
            body: String(body?.body),
          }),
        ],
      }),
      seq: store.seq,
    };
    store.threads.push(thread);
    return Response.json(view(thread), { status: 201 });
  }
  const threadPath = /^\/threads\/([^/]+)(?:\/(messages|resolve|reopen))?$/.exec(rest);
  const thread = threadPath && store.threads.find((t) => t.id === threadPath[1]);
  if (threadPath && thread) {
    const action = threadPath[2];
    if (method === "DELETE" && !action) {
      store.threads = store.threads.filter((t) => t !== thread);
      store.seq += 1;
      store.deleted.push({ id: thread.id, seq: store.seq });
      return new Response(null, { status: 204 });
    }
    if (action === "messages") {
      thread.messages.push(
        fakeMessage({
          own: true,
          author: { id: "u-ada", name: "Ada", image: null },
          body: String(body?.body),
        }),
      );
      touch(thread);
      return Response.json(view(thread), { status: 201 });
    }
    if (action === "resolve" || action === "reopen") {
      thread.state = action === "resolve" ? "resolved" : "open";
      touch(thread);
      return Response.json(view(thread));
    }
  }
  const edited = /^\/messages\/([^/]+)$/.exec(rest);
  if (edited && method === "PATCH") {
    for (const t of store.threads) {
      const message = t.messages.find((m) => m.id === edited[1]);
      if (!message) continue;
      if (!message.own || message.state !== "visible") return apiError("forbidden", 403);
      if (message.revision !== body?.revision) return apiError("version_conflict", 409);
      message.body = String(body?.body);
      message.revision += 1;
      message.editedAt = NOW;
      touch(t);
      if (store.outOfScope?.includes(t.id)) return Response.json({ threadId: t.id, thread: null });
      return Response.json(view(t));
    }
  }
  const moderation = /^\/messages\/([^/]+)\/moderation$/.exec(rest);
  if (moderation && method === "POST") {
    for (const t of store.threads) {
      const message = t.messages.find((m) => m.id === moderation[1]);
      if (!message) continue;
      const action = body?.action;
      message.state = action === "hide" ? "hidden" : action === "unhide" ? "visible" : "deleted";
      if (action === "delete") message.body = null;
      touch(t);
      return Response.json({ threadId: t.id, thread: view(t) });
    }
  }
  return missing();
}

/** What PATCH /access does in the Worker, minus the account-age rule. */
function applyAccess(
  artifact: ArtifactSummary,
  policy: AccessPolicyView,
  body: unknown,
  space?: FakeWorkspace,
): Response {
  const change = AccessUpdate.safeParse(body);
  if (!change.success) {
    return Response.json({ error: { code: "invalid_input", message: "x" } }, { status: 400 });
  }
  const {
    mode,
    indexable,
    embeddable,
    bar,
    commentVisibility,
    addReaders = [],
    removeReaders = [],
    readerCommentVisibility = [],
    addGroups = [],
    removeGroups = [],
    groupCommentVisibility = [],
  } = change.data;
  // Groups as the Worker checks them (decision 0014): only the workspace's, with its plan.
  const groups = new Map(
    policy.groups.filter((g) => !removeGroups.includes(g.id)).map((g) => [g.id, { ...g }]),
  );
  for (const id of addGroups) {
    if (!space) return apiError("invalid_input", 400);
    if (!space.domainsAvailable) return apiError("plan_required", 403);
    const group = space.groups.find((g) => g.id === id);
    if (!group) return apiError("invalid_input", 400);
    if (!groups.has(id)) {
      groups.set(id, { id, name: group.name, members: group.members, commentVisibility: null });
    }
  }
  for (const entry of groupCommentVisibility) {
    const group = groups.get(entry.group);
    if (!group) return apiError("invalid_input", 400);
    group.commentVisibility =
      entry.commentVisibility === "inherit" ? null : entry.commentVisibility;
  }
  const readers = new Set(policy.readers.filter((email) => !removeReaders.includes(email)));
  for (const email of addReaders) readers.add(email);
  if (readers.size > LIMITS.readersPerArtifact) {
    return Response.json({ error: { code: "quota_exceeded", message: "x" } }, { status: 429 });
  }
  const exceptions = new Map(
    policy.readerCommentVisibility
      .filter((entry) => readers.has(entry.email))
      .map((entry) => [entry.email, entry.commentVisibility]),
  );
  for (const entry of readerCommentVisibility) {
    if (!readers.has(entry.email)) {
      return Response.json({ error: { code: "invalid_input", message: "x" } }, { status: 400 });
    }
    if (entry.commentVisibility === "inherit") exceptions.delete(entry.email);
    else exceptions.set(entry.email, entry.commentVisibility);
  }
  Object.assign(policy, {
    mode: mode ?? policy.mode,
    indexable: indexable ?? policy.indexable,
    embeddable: embeddable ?? policy.embeddable,
    bar: bar ?? policy.bar,
    commentVisibility: commentVisibility ?? policy.commentVisibility,
    readers: [...readers].sort(),
    readerCommentVisibility: [...exceptions]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([email, scope]) => ({ email, commentVisibility: scope })),
    groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
    policyGeneration: policy.policyGeneration + 1,
  });
  artifact.accessMode = policy.mode;
  return Response.json(policy);
}

/** Browser storage for the language choice, in memory, or one that refuses every access. */
export function localeStorage(blocked = false) {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      if (blocked) throw new DOMException("blocked", "SecurityError");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (blocked) throw new DOMException("blocked", "SecurityError");
      values.set(key, value);
    },
  };
  return { values, source: () => storage };
}

export function renderDashboard(
  path: string,
  server: FakeServer,
  options: {
    humanCheck?: HumanCheckWidget | null;
    locale?: LocaleOptions;
    i18n?: I18n;
  } = {},
) {
  const left: string[] = [];
  const saved: SavedFile[] = [];
  const leave = (url: string) => {
    left.push(url);
  };
  const router = createDashboardRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = createQueryClient();
  const view = render(
    <DashboardApp
      env={{
        api: dashboardApi({
          fetch: (input, init) => server.fetch(input, init),
          onUnauthenticated: () => leave("unauthenticated"),
        }),
        leave,
        manifests: inProcessBuilder,
        storage: server.storage,
        save: (file) => {
          saved.push(file);
        },
        humanCheck: options.humanCheck ?? null,
      }}
      i18n={options.i18n ?? createI18n()}
      queryClient={queryClient}
      router={router}
      locale={options.locale ?? { storage: localeStorage().source }}
    />,
  );
  return { ...view, left, saved, router, queryClient };
}

/**
 * Renders one part of the dashboard (a dialog, a list) with the dashboard's providers and the
 * fake API, outside any route, for tests of that part alone.
 */
export function renderInDashboard(node: ReactNode, server: FakeServer) {
  const i18n = createI18n();
  const env = {
    api: dashboardApi({
      fetch: (input, init) => server.fetch(input, init),
      onUnauthenticated: () => {},
    }),
    leave: () => {},
    manifests: inProcessBuilder,
    storage: server.storage,
    save: () => {},
    humanCheck: null,
  };
  return render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={createQueryClient()}>
        <DashboardContext.Provider value={env}>{node}</DashboardContext.Provider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

/** Opens the select named `name` and chooses the option labelled `option`, as a pointer would. */
export function choose(name: string, option: string): void {
  fireEvent.click(screen.getByRole("combobox", { name }));
  fireEvent.click(
    within(screen.getByRole("listbox", { name })).getByRole("option", { name: option }),
  );
}

/** The labels of a select's options and the chosen one, read from its open list. */
export function selectOptions(name: string): { options: string[]; chosen: string | undefined } {
  const trigger = screen.getByRole("combobox", { name });
  fireEvent.click(trigger);
  const options = within(screen.getByRole("listbox", { name })).getAllByRole("option");
  const result = {
    options: options.map((option) => option.textContent ?? ""),
    chosen:
      options.find((option) => option.getAttribute("aria-selected") === "true")?.textContent ??
      undefined,
  };
  fireEvent.keyDown(trigger, { key: "Escape" });
  return result;
}

/** The group routes of a workspace, as apps/app/src/api/workspaces.ts answers them. */
function groupRoute(
  server: FakeServer,
  match: RegExpExecArray,
  path: string,
  method: string,
  body: Record<string, unknown> | undefined,
): Response {
  const w = server.workspaces[decodeURIComponent(match[1] ?? "")];
  if (!w) return apiError("not_found", 404);
  const id = match[2] ? decodeURIComponent(match[2]) : undefined;
  const membersPath = path.includes("/members");
  const memberId = match[3] ? decodeURIComponent(match[3]) : undefined;
  const view = ({ memberIds: _, ...group }: FakeWorkspace["groups"][number]) => group;
  if (!id && method === "GET") {
    if (w.view.role === "member") return apiError("forbidden", 403);
    return json({ items: w.groups.map(view), available: w.domainsAvailable, limit: 50 });
  }
  if (w.view.role !== "admin") return apiError("forbidden", 403);
  if (!id && method === "POST") {
    if (!w.domainsAvailable) return apiError("plan_required", 403);
    const parsed = WorkspaceGroupCreate.safeParse(body);
    if (!parsed.success) return apiError("invalid_input", 400);
    const group = {
      id: `wg_${String(w.groups.length + 1).padStart(32, "0")}`,
      name: parsed.data.name,
      members: 0,
      createdAt: NOW,
      directory: false,
      memberIds: [],
    };
    w.groups.push(group);
    return json(view(group), 201);
  }
  const group = w.groups.find((g) => g.id === id);
  if (!group) return apiError("not_found", 404);
  const detail = () => ({
    group: view(group),
    items: group.memberIds.flatMap((userId) => {
      const m = w.members.find((one) => one.userId === userId);
      return m ? [{ userId, name: m.name, email: m.email, role: m.role, addedAt: NOW }] : [];
    }),
    limit: 500,
  });
  // Like the API: stopping the sync makes it an ordinary group, and clears its mapping.
  if (path.endsWith("/stop-sync") && method === "POST") {
    if (!group.directory) return apiError("not_found", 404);
    group.directory = false;
    if (w.scim.editorGroup === group.id) w.scim.editorGroup = null;
    if (w.scim.adminGroup === group.id) w.scim.adminGroup = null;
    return json({ stopped: true });
  }
  // Like the API: the directory manages its groups; the dashboard changes none of them.
  if (group.directory && method !== "GET") return apiError("forbidden", 403);
  if (membersPath && method === "POST") {
    if (!w.domainsAvailable) return apiError("plan_required", 403);
    const userId = String(body?.userId ?? "");
    if (!w.members.some((m) => m.userId === userId)) return apiError("not_found", 404);
    if (!group.memberIds.includes(userId)) group.memberIds.push(userId);
    group.members = group.memberIds.length;
    return json(detail(), 201);
  }
  if (membersPath && memberId && method === "DELETE") {
    group.memberIds = group.memberIds.filter((userId) => userId !== memberId);
    group.members = group.memberIds.length;
    return new Response(null, { status: 204 });
  }
  if (method === "GET") return json(detail());
  if (method === "PATCH") {
    const parsed = WorkspaceGroupCreate.safeParse(body);
    if (!parsed.success) return apiError("invalid_input", 400);
    group.name = parsed.data.name;
    return json(view(group));
  }
  if (method === "DELETE") {
    w.groups = w.groups.filter((g) => g !== group);
    return new Response(null, { status: 204 });
  }
  return apiError("not_found", 404);
}

/** The service token routes of a workspace, as apps/app/src/api/workspaces.ts answers them. */
function serviceTokenRoute(
  server: FakeServer,
  match: RegExpExecArray,
  method: string,
  body: Record<string, unknown> | undefined,
): Response {
  const w = server.workspaces[decodeURIComponent(match[1] ?? "")];
  if (!w) return apiError("not_found", 404);
  if (w.view.role !== "admin") return apiError("forbidden", 403);
  const id = match[2] ? decodeURIComponent(match[2]) : undefined;
  if (!id && method === "GET") {
    return json({ items: w.serviceTokens, available: w.serviceTokensAvailable, limit: 20 });
  }
  if (!id && method === "POST") {
    if (!w.serviceTokensAvailable) return apiError("plan_required", 403);
    const parsed = ServiceTokenCreate.safeParse(body);
    if (!parsed.success) return apiError("invalid_input", 400);
    const token: ServiceTokenView = {
      id: `st_${String(w.serviceTokens.length + 1).padStart(32, "0")}`,
      label: parsed.data.label,
      role: parsed.data.role,
      scopes: parsed.data.scopes,
      restriction: parsed.data.restriction,
      createdAt: NOW,
      expiresAt: new Date(Date.parse(NOW) + parsed.data.expiresInDays * 86_400_000).toISOString(),
      lastUsedAt: null,
      createdBy: { name: "Ada" },
      expired: false,
    };
    w.serviceTokens.push(token);
    // A placeholder of the secret's shape, built at run time (no committed value matches it).
    const secret = ["pf", "st_", "x".repeat(43)].join("");
    return json({ token, secret }, 201);
  }
  if (id && method === "DELETE") {
    const before = w.serviceTokens.length;
    w.serviceTokens = w.serviceTokens.filter((token) => token.id !== id);
    if (w.serviceTokens.length === before) return apiError("not_found", 404);
    return new Response(null, { status: 204 });
  }
  return apiError("not_found", 404);
}

/** The GitHub trust rule routes of a workspace, as apps/app/src/api/workspaces.ts answers them. */
function githubTrustRoute(
  server: FakeServer,
  match: RegExpExecArray,
  method: string,
  body: Record<string, unknown> | undefined,
): Response {
  const w = server.workspaces[decodeURIComponent(match[1] ?? "")];
  if (!w) return apiError("not_found", 404);
  if (w.view.role !== "admin") return apiError("forbidden", 403);
  const id = match[2] ? decodeURIComponent(match[2]) : undefined;
  if (!id && method === "GET") {
    return json({
      items: w.githubTrust,
      available: w.serviceTokensAvailable,
      enabled: w.githubOidcEnabled,
      limit: 20,
      audience: `https://app.portifact.com/workspaces/${w.view.slug}/github`,
    });
  }
  if (!id && method === "POST") {
    if (!w.githubOidcEnabled) return apiError("capacity_unavailable", 503);
    if (!w.serviceTokensAvailable) return apiError("plan_required", 403);
    const parsed = GitHubTrustRuleCreate.safeParse(body);
    if (!parsed.success) return apiError("invalid_input", 400);
    const rule: GitHubTrustRuleView = {
      id: `gtr_${String(w.githubTrust.length + 1).padStart(32, "0")}`,
      repository: parsed.data.repository,
      repositoryId: parsed.data.repositoryId,
      repositoryOwnerId: parsed.data.repositoryOwnerId,
      events: parsed.data.events,
      ref: parsed.data.ref,
      environment: parsed.data.environment,
      scopes: parsed.data.scopes,
      keyPrefix: githubKeyPrefix(parsed.data.repositoryId),
      liveCredentials: 0,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: { name: "Ada" },
      revision: 0,
    };
    w.githubTrust.push(rule);
    return json(rule, 201);
  }
  if (id && method === "DELETE") {
    const before = w.githubTrust.length;
    w.githubTrust = w.githubTrust.filter((rule) => rule.id !== id);
    if (w.githubTrust.length === before) return apiError("not_found", 404);
    return new Response(null, { status: 204 });
  }
  return apiError("not_found", 404);
}

function normalizedPolicy(policy: WorkspacePolicy): WorkspacePolicy {
  const normalized = normalizePolicy(policy);
  return normalized.ok ? normalized.value : policy;
}

/** The fake policies routes (decision 0015): every member reads, admins preview and save. */
function policyRoute(
  server: FakeServer,
  match: RegExpExecArray,
  method: string,
  body: Record<string, unknown> | undefined,
): Response {
  const w = server.workspaces[decodeURIComponent(match[1] ?? "")];
  if (!w) return apiError("not_found", 404);
  const admin = w.view.role === "admin";
  // As the API (decision 0020): the network allowlists only to admins, with their own address.
  const hidden = (list: unknown) => (list === null ? null : "hidden");
  const state = () => ({
    policy: admin
      ? w.view.policy
      : {
          ...w.view.policy,
          ipAllowlist: hidden(w.view.policy.ipAllowlist),
          tokenIpAllowlist: hidden(w.view.policy.tokenIpAllowlist),
        },
    revision: w.policyRevision,
    enabled: w.policiesAvailable,
    editable: admin,
    domainVerified: w.domains.some((domain) => domain.state === "verified"),
    yourIp: admin ? "192.0.2.10" : null,
    serviceTokens: admin ? w.serviceTokens.length : null,
    // The admin signed in three hours ago (decision 0021).
    yourSignInAt: admin ? Date.now() - 3 * 3_600_000 : null,
    sso: admin && w.ssoState ? { offered: true, ...w.ssoState } : null,
    commentRetentionInForce:
      w.view.policy.commentRetentionDays === null ? null : (w.commentRetentionInForce ?? true),
  });
  if (!match[2] && method === "GET") return json(state());
  if (!admin) return apiError("forbidden", 403);
  if (match[2] && method === "POST") {
    const proposed = body?.policy as WorkspacePolicy | undefined;
    const networks =
      proposed?.ipAllowlist || proposed?.tokenIpAllowlist
        ? {
            members: proposed.ipAllowlist ? w.members.length : 0,
            tokens: proposed.tokenIpAllowlist ? w.serviceTokens.length : 0,
            unboundTokens:
              proposed.ipAllowlist && !proposed.tokenIpAllowlist ? w.serviceTokens.length : 0,
            singleFamily: singleFamilyLists(
              w.view.policy as WorkspacePolicy,
              normalizedPolicy(proposed),
            ),
          }
        : null;
    // Who the sign-in policies bind (decision 0021): every member, as the API counts them.
    const signIns =
      proposed && (proposed.sessionMaxHours !== null || proposed.allowedClients !== null)
        ? { members: w.members.length, staleMembers: 1, clientMembers: 0 }
        : null;
    // Who requiring single sign-on binds (decision 0021).
    const sso =
      proposed?.ssoRequired && w.ssoState?.usable
        ? { members: w.members.length, outsideProvider: w.ssoOutside, withoutSsoSession: 1 }
        : null;
    return json({ ...w.policyImpact, networks, signIns, sso });
  }
  if (!match[2] && method === "PUT") {
    if (body?.revision !== w.policyRevision) return apiError("version_conflict", 409);
    const asked = (body?.policy as WorkspacePolicy | undefined)?.commentRetentionDays ?? null;
    if (w.commentRetentionRefusal && asked !== w.view.policy.commentRetentionDays) {
      const reason = w.commentRetentionRefusal === "guard" ? "comment_retention_guard" : null;
      return json(
        {
          error: {
            code: "capacity_unavailable",
            message: "x",
            ...(reason && { details: { reason } }),
          },
        },
        503,
      );
    }
    // As the API: a save that changes existing artifacts needs the impact the preview showed,
    // and is refused when a count grew past it since.
    const impact = Object.values(w.policyImpact).reduce((sum, count) => sum + count, 0);
    const confirmed = body?.confirmed as PolicyImpact | undefined;
    const grew = (Object.keys(w.policyImpact) as (keyof PolicyImpact)[]).some(
      (key) => w.policyImpact[key] > (confirmed?.[key] ?? -1),
    );
    if (impact > 0 && grew) return apiError("policy_refused", 403);
    // As the API (decision 0020): a single-family list needs exactly that confirmed.
    const families = singleFamilyLists(
      w.view.policy as WorkspacePolicy,
      normalizedPolicy(body?.policy as WorkspacePolicy),
    );
    const confirmedFamilies = body?.confirmedSingleFamily as SingleFamilyLists | undefined;
    if (!checkSingleFamily(families, confirmedFamilies).ok) {
      return apiError("policy_refused", 403);
    }
    // As the API (decision 0021): newly requiring SSO needs the members it cuts off confirmed.
    const proposedPolicy = body?.policy as WorkspacePolicy | undefined;
    const newlySso = proposedPolicy?.ssoRequired === true && !w.view.policy.ssoRequired;
    if (newlySso && w.ssoOutside > 0 && body?.confirmedOutsideProvider !== w.ssoOutside) {
      return apiError("policy_refused", 403);
    }
    // As the API (decision 0023): the server decides when a maximum life takes effect, and its
    // comment retention guard token is never shown.
    const saved = commentTiming(
      w.view.policy as WorkspacePolicy,
      retentionTiming(
        w.view.policy as WorkspacePolicy,
        body?.policy as WorkspacePolicy,
        Date.now(),
      ),
      Date.now(),
    );
    w.view = { ...w.view, policy: { ...saved, commentRetentionToken: null } };
    w.policyRevision += 1;
    return json(state());
  }
  return apiError("not_found", 404);
}

/** Audit streams (decision 0019), as the session-only routes answer them. */
function auditStreamRoute(server: FakeServer, url: URL, method: string): Response {
  const store = server.auditStreams;
  const slug = url.searchParams.get("workspace") ?? "";
  store.bySpace[slug] ??= [];
  const list = store.bySpace[slug];
  const error = (code: string, status: number, message = code) =>
    Response.json({ error: { code, message } }, { status });
  const path = url.pathname;
  if (path === "/api/v1/audit/streams" && method === "GET") {
    return Response.json({
      streams: list,
      available: store.available,
      serviceAvailable: store.offered,
      euOwner: store.euOwner,
      limit: 2,
      settleMinutes: 20,
    });
  }
  if (path === "/api/v1/audit/streams" && method === "POST") {
    if (!store.available)
      return error("plan_required", 403, "Exporting the audit log is part of the Enterprise plan.");
    const body = server.bodies.at(-1) as { label: string; url: string; start: string };
    let host: string;
    try {
      const parsed = new URL(body.url);
      if (parsed.protocol !== "https:") throw new Error("http");
      host = parsed.hostname;
    } catch {
      return error("invalid_input", 400, "The URL must start with https://.");
    }
    const stream: AuditStreamView = {
      id: `as_${String(list.length + 1).padStart(32, "0")}`,
      label: body.label,
      host,
      state: "active",
      pausedReason: null,
      pausedAt: null,
      deliveredThrough: null,
      lagMs: null,
      failures: 0,
      failingSince: null,
      lastAttempt: null,
      lastGap: null,
      testPending: false,
      createdAt: "2026-11-10T09:00:00.000Z",
      createdBy: "Ada",
    };
    list.push(stream);
    return Response.json(
      { stream, secret: "whsec_sample-stream-secret-for-tests" },
      { status: 201 },
    );
  }
  const match = /^\/api\/v1\/audit\/streams\/([^/]+)(\/test|\/deliveries)?$/.exec(path);
  const found = match && list.find((one) => one.id === match[1]);
  if (!match || !found) return error("not_found", 404, "Audit stream not found.");
  if (match[2] === "/deliveries") {
    return Response.json({
      streamId: found.id,
      attempts: store.attempts[found.id] ?? [],
      retentionDays: 7,
    });
  }
  if (match[2] === "/test") {
    store.tests.push(found.id);
    return Response.json({ streamId: found.id, queued: true }, { status: 202 });
  }
  if (method === "DELETE") {
    store.bySpace[slug] = list.filter((one) => one.id !== found.id);
    return Response.json({ streamId: found.id, removed: true });
  }
  const change = server.bodies.at(-1) as { state?: "active" | "paused"; rotateSecret?: true };
  if (change.state === "active" && !store.available) return error("plan_required", 403);
  const next: AuditStreamView =
    change.state === "paused"
      ? { ...found, state: "paused", pausedReason: "manual", pausedAt: "2026-11-10T10:00:00.000Z" }
      : change.state === "active"
        ? { ...found, state: "active", pausedReason: null, pausedAt: null, failures: 0 }
        : found;
  store.bySpace[slug] = list.map((one) => (one.id === found.id ? next : one));
  return Response.json({
    stream: next,
    secret: change.rotateSecret ? "whsec_rotated-stream-secret-for-tests" : null,
  });
}
