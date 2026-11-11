// The /api/v1 publishing, artifact and version routes of the fake server, and a fake presigned
// storage target. They follow apps/app's contract: the same shapes (validated with
// packages/contracts), error codes, idempotency replay, deduplication by SHA-256, lifecycle
// states and version history. Storage checks the signed size and checksum headers, the bytes and
// the URL's expiry like R2 does, and serves downloads only through unexpired signed links.

import { createHash, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  type AbuseReason,
  type AccessLogEntry,
  AccessLogQuery,
  type AccessLogView,
  type AccessMode,
  type AccessPolicyView,
  AccessUpdate,
  type AccountUsageView,
  ApprovalChangeInput,
  ApprovalRequestInput,
  type ApprovalReviewView,
  ApprovalVerdictInput,
  ARTIFACT_ID_ALPHABET,
  ArtifactListFilters,
  type ArtifactListItem,
  type ArtifactStatsView,
  type ArtifactSummary,
  type ArtifactType,
  AUDIT_EXPORT_CURSOR_HEADER,
  type AuditEventView,
  AuditExportFormat,
  type CommentScope,
  type CommentVisibility,
  CustomDomainAdd,
  type CustomDomainView,
  DEFAULT_POLICY,
  ERROR_STATUS,
  type ErrorCode,
  type FeedbackItem,
  IdempotencyKey,
  type IntegrationChoiceList,
  type ManifestFile,
  NO_APPROVAL_REVIEW,
  PLANS,
  type PlanFeature,
  PublishRequest,
  planRequiredMessage,
  RollbackRequest,
  type SearchResults,
  ShareLinkCreate,
  type ShareLinkView,
  type SourceOrigin,
  UNTRUSTED_ANNOTATIONS_NOTICE,
  UploadedPart,
  VERSION_DIFF,
  type WebhookAttempt,
  WebhookCreate,
  WebhookUpdate,
  type WebhookView,
  type WorkspaceGroupView,
  type WorkspacePolicyShown,
} from "@portifact/contracts";
import {
  auditExportContentType,
  auditExportLine,
  auditExportPreamble,
  decodeUtf8,
  diffText,
  noticeWindowEnd,
  pageHunks,
  textDiffEligibility,
} from "@portifact/domain";

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FakeArtifact {
  id: string;
  name: string;
  type: ArtifactType;
  state: "active" | "archived" | "deleted";
  currentVersionId: string | null;
  versions: number;
  expiresAt: number | null;
  archivedAt: number | null;
  purgeAt: number | null;
  pinned: boolean;
  /** The active custom domain, if the test gives the artifact one. */
  customHost?: string;
  createdAt: number;
  updatedAt: number;
  access: {
    mode: AccessMode;
    readers: string[];
    indexable: boolean;
    embeddable: boolean;
    bar: boolean;
    commentVisibility: CommentVisibility;
    readerCommentVisibility: { email: string; commentVisibility: CommentScope }[];
  };
  policyGeneration: number;
  /** Set when the operator suspended it; the summary then says `suspended` with the reason. */
  suspensionReason?: AbuseReason;
  /** The workspace it lives in; absent for the personal space. */
  workspace?: string | undefined;
  /** Its publish key (decision 0011), if it was created with one. */
  key?: string | undefined;
  /** Who the workspace modes reach, as the access view shows it; absent means null. */
  audience?: AccessPolicyView["audience"];
  /** Groups of its workspace it lists (decision 0014). */
  groups?: AccessPolicyView["groups"];
}

export interface FakeWorkspace {
  slug: string;
  name: string;
  role: "admin" | "editor" | "member";
  /** Its policies as shown (decisions 0015 and 0020); the defaults when absent. */
  policy?: WorkspacePolicyShown;
  /** Its network policy refuses this machine (decision 0020). */
  blocked?: boolean;
}

export interface FakeVersionFile {
  kind: "published" | "source";
  path: string;
  sha256: string;
  size: number;
  contentType: string;
}

export interface FakeVersion {
  id: string;
  number: number;
  entrypoint: string;
  files: FakeVersionFile[];
  committedAt: number;
  /** End of retention once it is no longer current. */
  expiresAt: number | null;
  sourceOrigin?: SourceOrigin | null;
}

interface UploadSession {
  id: string;
  ownerId: string;
  artifactId: string;
  isNew: boolean;
  /** The workspace a new artifact goes to. */
  workspace: string | undefined;
  name: string;
  type: ArtifactType;
  versionId: string;
  versionNumber: number;
  entrypoint: string;
  files: ManifestFile[];
  sourceOrigin: SourceOrigin | null;
  key: string | undefined;
  /** Objects this upload must send; they stay pending until the commit verifies them. */
  needed: Map<string, number>;
  /** Objects uploaded in parts, by SHA-256. */
  multipart: Map<string, FakeMultipart>;
  state: "uploading" | "committed" | "aborted";
  committed?: unknown;
}

interface FakeMultipart {
  partSize: number;
  partCount: number;
  /** Parts storage holds, with the ETag it answered. */
  stored: Map<number, { etag: string; bytes: Buffer }>;
  /** Parts the client reported, with the ETag it sent. */
  reported: Map<number, string>;
}

export interface PartPutRecord {
  sha256: string;
  partNumber: number;
  bytes: number;
  status: number;
}

export interface PutRecord {
  sha256: string;
  headers: IncomingHttpHeaders;
  bytes: number;
  status: number;
}

export interface FakeApiState {
  artifacts: Map<string, FakeArtifact>;
  /** Access log entries by artifact, newest first, as GET /artifacts/:id/access-log pages them. */
  accessLogs: Map<string, AccessLogEntry[]>;
  /** Audit events by space (`personal` or a slug), newest first, as GET /audit pages them. */
  audit: Map<string, AuditEventView[]>;
  /** The query strings GET /audit received, in order. */
  auditQueries: string[];
  /** The query strings GET /audit/export received, in order. */
  auditExportQueries: string[];
  /** Events per export part, so tests follow the cursor through several parts. */
  auditExportPart: number;
  /** Analytics by artifact, as GET /artifacts/:id/stats returns them; missing means none seeded. */
  stats: Map<string, ArtifactStatsView>;
  /** Search pages by space (`personal` or a slug), as GET /search returns them for any query. */
  search: Map<string, SearchResults>;
  /** The query strings GET /search received, in order. */
  searchQueries: string[];
  /**
   * Open feedback by space (`personal` or a workspace slug), newest first, as GET /feedback pages
   * it; a workspace's needs `workspaces` in `usage.plan.features`.
   */
  feedback: Map<string, FeedbackItem[]>;
  /** Share links by artifact, newest first, without their tokens. */
  shareLinks: Map<string, ShareLinkView[]>;
  /** What GET /integrations answers, by space (`personal` or a slug); missing means none. */
  integrations: Map<string, IntegrationChoiceList>;
  /** Approval reviews by artifact (decision 0013), as GET /artifacts/:id/review returns them. */
  approvals: Map<string, ApprovalReviewView>;
  /** Every review request the CLI sent: method, path, Idempotency-Key and body. */
  approvalCalls: { method: string; path: string; key: string | undefined; body: unknown }[];
  /** Tokens of the links created, which the CLI may print only once, at creation. */
  shareTokens: string[];
  /** Whether the owner's plan includes share links. */
  shareLinksEnabled: boolean;
  /** Custom domains and pending claims by hostname. */
  domains: Map<string, CustomDomainView>;
  /** Whether the owner's plan includes custom domains (one, like Pro). */
  domainsEnabled: boolean;
  /** Objects the account already stores, by SHA-256. */
  stored: Map<string, Buffer>;
  /** Objects uploaded and not committed yet. */
  uploaded: Map<string, Buffer>;
  sessions: Map<string, UploadSession>;
  puts: PutRecord[];
  /** Part uploads to storage, in the order they finished. */
  partPuts: PartPutRecord[];
  /** Part reports the API received. */
  partReports: { sha256: string; partNumber: number; etag: string }[];
  /**
   * Multipart threshold and part size for clients that ask for multipart; null turns multipart
   * off, as on a server older than it.
   */
  multipart: { thresholdBytes: number; partBytes: number } | null;
  /** Answer part uploads without an ETag header, as storage does without the CORS rule. */
  hideEtag: boolean;
  /** Upload URLs the server handed out, by token. */
  urls: Map<string, { sha256: string; size: number; expiresAt: number; partNumber?: number }>;
  /** Versions of each artifact, oldest first. */
  versions: Map<string, FakeVersion[]>;
  /** Download links the server handed out, by token. */
  downloadUrls: Map<string, { sha256: string; expiresAt: number }>;
  /** Storage downloads: which object, with which headers, and the answer. */
  gets: { sha256: string; headers: IncomingHttpHeaders; status: number }[];
  /** How long download links stay valid. */
  downloadTtlMs: number;
  /**
   * Adds a committed version with these files (their bytes are stored) and makes it current.
   * Paths are taken as given, so tests can seed what a hostile server would send.
   */
  seedVersion(
    artifact: FakeArtifact,
    files: { published: Record<string, string | Buffer>; source?: Record<string, string | Buffer> },
    options?: { entrypoint?: string; sourceOrigin?: SourceOrigin | null },
  ): FakeVersion;
  /** The account is in its first days, so it cannot make an artifact public. */
  tooNewForPublic: boolean;
  /** The workspaces the user belongs to, as GET /workspaces lists them. */
  workspaces: FakeWorkspace[];
  /** Groups by workspace slug, as GET /workspaces/:slug/groups lists them. */
  groups: Map<string, WorkspaceGroupView[]>;
  /** The `workspace` parameter of each owner-scoped request, as `<route> <slug|personal>`. */
  workspaceParams: string[];
  /** How long upload URLs stay valid. */
  urlTtlMs: number;
  /** Creates an artifact as if it had been published before the test. */
  seed(overrides?: Partial<FakeArtifact>): FakeArtifact;
  /** What GET /usage answers. */
  usage: AccountUsageView;
  /** The account's webhooks, as /webhooks keeps them (the feature comes from `usage.plan`). */
  webhooks: Map<string, WebhookView>;
  /** Delivery attempts each webhook's log answers. */
  webhookAttempts: Map<string, WebhookAttempt[]>;
  /** Test events queued per webhook. */
  webhookTests: string[];
  /** Whether the server offers webhooks at all (`WEBHOOKS_ENABLED`). */
  webhooksOffered: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = DAY_MS;

export function createFakeApi(origin: () => string, clock: () => number) {
  const idempotency = new Map<string, { hash: string; reply: Reply }>();
  const state: FakeApiState = {
    artifacts: new Map(),
    accessLogs: new Map(),
    audit: new Map(),
    auditQueries: [],
    auditExportQueries: [],
    auditExportPart: 2,
    stats: new Map(),
    search: new Map(),
    searchQueries: [],
    feedback: new Map(),
    shareLinks: new Map(),
    integrations: new Map(),
    approvals: new Map(),
    approvalCalls: [],
    shareTokens: [],
    shareLinksEnabled: true,
    domains: new Map(),
    domainsEnabled: true,
    stored: new Map(),
    uploaded: new Map(),
    sessions: new Map(),
    puts: [],
    partPuts: [],
    partReports: [],
    multipart: { thresholdBytes: 64 * 1024 * 1024, partBytes: 16 * 1024 * 1024 },
    hideEtag: false,
    urls: new Map(),
    versions: new Map(),
    downloadUrls: new Map(),
    gets: [],
    downloadTtlMs: 5 * 60 * 1000,
    seedVersion(artifact, files, options = {}) {
      const entries: FakeVersionFile[] = [];
      for (const kind of ["published", "source"] as const) {
        for (const [path, content] of Object.entries(files[kind] ?? {})) {
          const bytes = Buffer.from(content);
          const sha256 = sha256Of(bytes);
          state.stored.set(sha256, bytes);
          entries.push({
            kind,
            path,
            sha256,
            size: bytes.length,
            contentType: contentTypeOf(path),
          });
        }
      }
      return addVersion(artifact, {
        id: `ver_${randomUUID().replaceAll("-", "")}`,
        entrypoint: options.entrypoint ?? Object.keys(files.published)[0] ?? "index.html",
        files: entries,
        sourceOrigin: options.sourceOrigin ?? null,
      });
    },
    tooNewForPublic: false,
    workspaces: [],
    groups: new Map(),
    workspaceParams: [],
    webhooks: new Map(),
    webhookAttempts: new Map(),
    webhookTests: [],
    webhooksOffered: true,
    urlTtlMs: 15 * 60 * 1000,
    usage: {
      plan: {
        name: "free",
        validUntil: null,
        seats: 1,
        limits: { ...PLANS.free.limits },
        features: [],
      },
      activeArtifacts: { used: 0, limit: 50 },
      storage: { used: 0, reserved: 0, limit: 2_500_000_000 },
      publishesLast24h: { used: 0, limit: 100 },
      newFilesLast24h: { used: 0, limit: 10_000 },
      newBytesLast24h: { used: 0, limit: 5_000_000_000 },
      newObjectsThisMonth: { used: 0, limit: 100_000, resetsAt: "2026-12-01T00:00:00.000Z" },
      openUploads: { used: 0, limit: 2 },
      trafficThisMonth: {
        requests: { used: 0, limit: 1_000_000 },
        bytes: { used: 0, limit: 25_000_000_000 },
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
      versionLimits: { publishedBytes: 250_000_000, files: 1_000, documentBytes: 5_000_000 },
      publicAccessFrom: "2026-01-01T00:00:00.000Z",
      blocks: [],
    },
    seed(overrides = {}) {
      const now = clock();
      const artifact: FakeArtifact = {
        id: newArtifactId(),
        name: "Seeded report",
        type: "site",
        state: "active",
        currentVersionId: `ver_${randomUUID()}`,
        versions: 1,
        expiresAt: now + 30 * DAY_MS,
        archivedAt: null,
        purgeAt: null,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        access: {
          mode: "restricted",
          readers: [],
          indexable: false,
          embeddable: false,
          bar: true,
          commentVisibility: "owner",
          readerCommentVisibility: [],
        },
        policyGeneration: 1,
        ...overrides,
      };
      state.artifacts.set(artifact.id, artifact);
      return artifact;
    },
  };

  /** Answers a storage upload, or undefined when the path is not a storage URL. */
  function storage(method: string, url: URL, headers: IncomingHttpHeaders, body: Buffer) {
    const match = /^\/r2\/objects\/([0-9a-f]{64})$/.exec(url.pathname);
    if (match && method === "GET") {
      const sha256 = match[1] as string;
      const reply = checkDownload(sha256, url.searchParams.get("token") ?? "", headers);
      state.gets.push({ sha256, headers, status: reply.status });
      return reply;
    }
    const part = /^\/r2\/parts\/([0-9a-f]{64})\/(\d+)$/.exec(url.pathname);
    if (part && method === "PUT") {
      return storePart(
        part[1] as string,
        Number(part[2]),
        url.searchParams.get("token") ?? "",
        headers,
        body,
      );
    }
    if (!match || method !== "PUT") return undefined;
    const sha256 = match[1] as string;
    const reply = checkUpload(sha256, url.searchParams.get("token") ?? "", headers, body);
    state.puts.push({ sha256, headers, bytes: body.length, status: reply.status });
    if (reply.status === 200) state.uploaded.set(sha256, body);
    return reply;
  }

  function checkUpload(
    sha256: string,
    token: string,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ): Reply {
    const signed = state.urls.get(token);
    if (!signed || signed.sha256 !== sha256) return { status: 403, body: "SignatureDoesNotMatch" };
    if (clock() >= signed.expiresAt) return { status: 403, body: "Request has expired" };
    // Storage never needs, and must never receive, the user's API token.
    if (headers.authorization !== undefined) return { status: 400, body: "Unexpected header" };
    if (headers["content-length"] !== String(signed.size)) return { status: 403, body: "Size" };
    if (headers["x-amz-checksum-sha256"] !== checksum(sha256)) {
      return { status: 403, body: "SignatureDoesNotMatch" };
    }
    if (body.length !== signed.size || sha256Of(body) !== sha256) {
      return { status: 400, body: "BadDigest" };
    }
    return { status: 200 };
  }

  function storePart(
    sha256: string,
    partNumber: number,
    token: string,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ): Reply {
    const signed = state.urls.get(token);
    const record = (status: number) =>
      state.partPuts.push({ sha256, partNumber, bytes: body.length, status });
    if (!signed || signed.sha256 !== sha256 || signed.partNumber !== partNumber) {
      record(403);
      return { status: 403, body: "SignatureDoesNotMatch" };
    }
    if (clock() >= signed.expiresAt) {
      record(403);
      return { status: 403, body: "Request has expired" };
    }
    if (headers.authorization !== undefined) {
      record(400);
      return { status: 400, body: "Unexpected header" };
    }
    if (headers["content-length"] !== String(signed.size) || body.length !== signed.size) {
      record(403);
      return { status: 403, body: "SignatureDoesNotMatch" };
    }
    const upload = [...state.sessions.values()]
      .map((session) => session.multipart.get(sha256))
      .find((found) => found !== undefined);
    if (!upload) {
      record(404);
      return { status: 404, body: "NoSuchUpload" };
    }
    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    upload.stored.set(partNumber, { etag, bytes: body });
    record(200);
    return { status: 200, ...(state.hideEtag ? {} : { headers: { etag } }) };
  }

  function checkDownload(sha256: string, token: string, headers: IncomingHttpHeaders): Reply {
    const signed = state.downloadUrls.get(token);
    if (!signed || signed.sha256 !== sha256) return { status: 403, body: "SignatureDoesNotMatch" };
    if (clock() >= signed.expiresAt) return { status: 403, body: "Request has expired" };
    if (headers.authorization !== undefined) return { status: 400, body: "Unexpected header" };
    const bytes = state.stored.get(sha256);
    return bytes ? { status: 200, body: bytes } : { status: 404, body: "NoSuchKey" };
  }

  function uploadTarget(sha256: string, size: number) {
    const token = randomUUID();
    const expiresAt = clock() + state.urlTtlMs;
    state.urls.set(token, { sha256, size, expiresAt });
    return {
      sha256,
      size,
      method: "PUT",
      url: `${origin()}/r2/objects/${sha256}?token=${token}`,
      headers: { "content-length": String(size), "x-amz-checksum-sha256": checksum(sha256) },
      expiresAt: iso(expiresAt),
    };
  }

  /** Appends a committed version, makes it current and starts the previous one's retention. */
  function addVersion(
    artifact: FakeArtifact,
    version: Pick<FakeVersion, "id" | "entrypoint" | "files" | "sourceOrigin">,
  ): FakeVersion {
    const now = clock();
    const list = state.versions.get(artifact.id) ?? [];
    const previous = list.find((v) => v.id === artifact.currentVersionId);
    if (previous) previous.expiresAt = now + 7 * DAY_MS;
    const added: FakeVersion = {
      ...version,
      number: Math.max(artifact.versions, ...list.map((v) => v.number)) + 1,
      committedAt: now,
      expiresAt: null,
    };
    list.push(added);
    state.versions.set(artifact.id, list);
    artifact.currentVersionId = added.id;
    artifact.versions = added.number;
    artifact.expiresAt = artifact.pinned ? null : now + 30 * DAY_MS;
    artifact.updatedAt = now;
    return added;
  }

  /** Retained versions and the current one's bytes; the fake keeps no comment threads here. */
  function activityOf(artifact: FakeArtifact) {
    const retained = (state.versions.get(artifact.id) ?? []).filter(
      (version) => retainedVersion(artifact, version.id) !== undefined,
    );
    const current = retained.find((version) => version.id === artifact.currentVersionId);
    return {
      versions: retained.length,
      currentBytes: current ? current.files.reduce((sum, file) => sum + file.size, 0) : null,
      openThreads: 0,
      lastAnnotationAt: null,
    };
  }

  function retainedVersion(artifact: FakeArtifact, ref: string): FakeVersion | undefined {
    const id = ref === "current" ? artifact.currentVersionId : ref;
    const version = state.versions.get(artifact.id)?.find((v) => v.id === id);
    if (!version) return undefined;
    const current = version.id === artifact.currentVersionId;
    return current || version.expiresAt === null || version.expiresAt > clock()
      ? version
      : undefined;
  }

  function versionSummary(artifact: FakeArtifact, version: FakeVersion) {
    const of = (kind: string) => version.files.filter((file) => file.kind === kind);
    const bytes = (kind: string) => of(kind).reduce((sum, file) => sum + file.size, 0);
    const current = version.id === artifact.currentVersionId;
    return {
      id: version.id,
      number: version.number,
      current,
      entrypoint: version.entrypoint,
      publishedBytes: bytes("published"),
      sourceBytes: bytes("source"),
      publishedFiles: of("published").length,
      sourceFiles: of("source").length,
      rendererVersion: null,
      committedAt: iso(version.committedAt),
      expiresAt: current || version.expiresAt === null ? null : iso(version.expiresAt),
      sourceOrigin: version.sourceOrigin ?? null,
    };
  }

  const missingVersion = () =>
    error(
      "not_found",
      "This version does not exist, is no longer retained or your account cannot download it.",
    );

  function listVersions(artifact: FakeArtifact, url: URL): Reply {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const cursor = url.searchParams.get("cursor");
    const before = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || Number.isNaN(before)) {
      return error("invalid_input", "Invalid cursor or limit.");
    }
    const all = [...(state.versions.get(artifact.id) ?? [])]
      .filter((v) => retainedVersion(artifact, v.id) && v.number < before)
      .sort((a, b) => b.number - a.number);
    const items = all.slice(0, limit).map((v) => versionSummary(artifact, v));
    const last = items.at(-1);
    const nextCursor = all.length > limit && last ? String(last.number) : null;
    const paid = state.usage.plan.features.includes("versionDiff");
    return {
      status: 200,
      body: {
        artifactId: artifact.id,
        items,
        nextCursor,
        retention: {
          previousVersions: state.usage.plan.limits.retainedPreviousVersions,
          days: state.usage.plan.limits.previousVersionRetentionDays,
        },
        versionDiff: paid,
      },
    };
  }

  /** Both versions' files joined by kind and path, sorted, as the server compares them. */
  function joinedFiles(before: FakeVersion, after: FakeVersion) {
    const key = (file: FakeVersionFile) => `${file.kind}\u0000${file.path}`;
    const a = new Map(before.files.map((file) => [key(file), file]));
    const b = new Map(after.files.map((file) => [key(file), file]));
    const side = (file: FakeVersionFile | undefined) =>
      file ? { sha256: file.sha256, size: file.size, contentType: file.contentType } : null;
    return [...new Set([...a.keys(), ...b.keys()])].sort().map((k) => {
      const from = a.get(k);
      const to = b.get(k);
      const any = (from ?? to) as FakeVersionFile;
      const change = !from
        ? "added"
        : !to
          ? "removed"
          : from.sha256 === to.sha256
            ? "unchanged"
            : "changed";
      return { kind: any.kind, path: any.path, change, before: side(from), after: side(to) };
    });
  }

  function compared(artifact: FakeArtifact, fromRef: string, toRef: string) {
    if (!state.usage.plan.features.includes("versionDiff"))
      return { reply: planRequired("versionDiff") };
    const from = retainedVersion(artifact, fromRef);
    const to = retainedVersion(artifact, toRef);
    if (!from || !to) return { reply: missingVersion() };
    return { from, to };
  }

  function compareVersions(
    artifact: FakeArtifact,
    fromRef: string,
    toRef: string,
    url: URL,
  ): Reply {
    const found = compared(artifact, fromRef, toRef);
    if ("reply" in found) return found.reply;
    const { from, to } = found;
    const limit = Number(url.searchParams.get("limit") ?? VERSION_DIFF.filesDefault);
    const cursor = url.searchParams.get("cursor");
    const start = cursor === null ? 0 : Number(cursor.replace(/^f/, ""));
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > VERSION_DIFF.filesMax ||
      Number.isNaN(start)
    ) {
      return error("invalid_input", "Invalid cursor or limit.");
    }
    const files = joinedFiles(from, to);
    const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
    for (const file of files) counts[file.change as keyof typeof counts] += 1;
    const differing = files.filter((file) => file.change !== "unchanged");
    const page = differing.slice(start, start + limit);
    return {
      status: 200,
      body: {
        artifactId: artifact.id,
        from: { id: from.id, number: from.number },
        to: { id: to.id, number: to.number },
        counts,
        files: page,
        nextCursor: start + limit < differing.length ? `f${start + limit}` : null,
      },
    };
  }

  function diffFile(artifact: FakeArtifact, fromRef: string, toRef: string, url: URL): Reply {
    const found = compared(artifact, fromRef, toRef);
    if ("reply" in found) return found.reply;
    const { from, to } = found;
    const kind = url.searchParams.get("kind") ?? "published";
    const path = url.searchParams.get("path");
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    if (path === null || (kind !== "published" && kind !== "source")) {
      return error(
        "invalid_input",
        "Send path, kind published or source and cursor a hunk number.",
      );
    }
    const file = joinedFiles(from, to).find((f) => f.kind === kind && f.path === path);
    if (!file) return error("not_found", "Neither version has this file.");
    const body = (diff: unknown): Reply => ({
      status: 200,
      body: {
        artifactId: artifact.id,
        from: { id: from.id, number: from.number },
        to: { id: to.id, number: to.number },
        ...file,
        diff,
      },
    });
    if (file.change === "unchanged") return body({ status: "identical" });
    const eligibility = [textDiffEligibility(file.before), textDiffEligibility(file.after)];
    if (eligibility.includes("binary")) return body({ status: "binary" });
    if (eligibility.includes("too_large")) return body({ status: "too_large" });
    const text = (side: { sha256: string } | null) =>
      side === null
        ? ""
        : decodeUtf8(new Uint8Array(state.stored.get(side.sha256) ?? Buffer.alloc(0)));
    const [a, b] = [text(file.before), text(file.after)];
    if (a === null || b === null) return body({ status: "binary" });
    const diff = diffText(a, b);
    if (diff.status !== "text") return body({ status: diff.status });
    const page = pageHunks(diff.hunks, cursor);
    return body({ status: "text", added: diff.added, removed: diff.removed, ...page });
  }

  function versionManifest(artifact: FakeArtifact, ref: string): Reply {
    const version = retainedVersion(artifact, ref);
    if (!version) return missingVersion();
    const files = [...version.files].sort((a, b) =>
      a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind.localeCompare(b.kind),
    );
    return {
      status: 200,
      body: { ...versionSummary(artifact, version), artifactId: artifact.id, files },
    };
  }

  function download(artifact: FakeArtifact, ref: string, url: URL): Reply {
    const kind = url.searchParams.get("kind") ?? "published";
    const path = url.searchParams.get("path");
    if (kind !== "published" && kind !== "source") {
      return error("invalid_input", "kind must be published or source.");
    }
    const version = retainedVersion(artifact, ref);
    if (!version) return missingVersion();
    const files = version.files
      .filter((file) => file.kind === kind && (path === null || file.path === path))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (path !== null && files.length === 0)
      return error("not_found", "This version has no such file.");
    return {
      status: 200,
      body: {
        artifactId: artifact.id,
        versionId: version.id,
        versionNumber: version.number,
        kind,
        entrypoint: version.entrypoint,
        files: files.map((file) => {
          const token = randomUUID();
          const expiresAt = clock() + state.downloadTtlMs;
          state.downloadUrls.set(token, { sha256: file.sha256, expiresAt });
          return {
            path: file.path,
            sha256: file.sha256,
            size: file.size,
            contentType: file.contentType,
            method: "GET",
            url: `${origin()}/r2/objects/${file.sha256}?token=${token}`,
            expiresAt: iso(expiresAt),
          };
        }),
      },
    };
  }

  function rollback(artifact: FakeArtifact, key: string | undefined, raw: string): Reply {
    const parsedKey = IdempotencyKey.safeParse(key);
    if (!parsedKey.success) return error("invalid_input", "Send an Idempotency-Key header.");
    const hash = `rollback ${artifact.id} ${raw}`;
    const previous = idempotency.get(parsedKey.data);
    if (previous) {
      if (previous.hash !== hash) return error("invalid_input", "Key used for another request.");
      return previous.reply;
    }
    const reply = rollbackOnce(artifact, raw);
    idempotency.set(parsedKey.data, { hash, reply });
    return reply;
  }

  function rollbackOnce(artifact: FakeArtifact, raw: string): Reply {
    const parsed = RollbackRequest.safeParse(parseJson(raw));
    if (!parsed.success) return error("invalid_input", "Invalid rollback request.");
    if (artifact.state === "archived") {
      return error("artifact_archived", "Restore the artifact before rolling it back.");
    }
    if (artifact.currentVersionId !== parsed.data.baseVersionId) {
      return error("version_conflict", "The artifact changed since your last read.");
    }
    const target = retainedVersion(artifact, parsed.data.versionId);
    if (!target) return missingVersion();
    if (target.id === artifact.currentVersionId) {
      return error("invalid_input", "That version is already the current one.");
    }
    const added = addVersion(artifact, {
      id: `ver_${randomUUID().replaceAll("-", "")}`,
      entrypoint: target.entrypoint,
      files: target.files.map((file) => ({ ...file })),
      sourceOrigin: target.sourceOrigin ?? null,
    });
    return {
      status: 200,
      body: {
        artifactId: artifact.id,
        versionId: added.id,
        versionNumber: added.number,
        url: contentUrl(artifact.id),
        expiresAt: artifact.expiresAt === null ? null : iso(artifact.expiresAt),
        fromVersionId: target.id,
        fromVersionNumber: target.number,
      },
    };
  }

  /** Answers a version route of an artifact, or undefined when the path is not one. */
  function versionRoute(
    method: string,
    path: string,
    url: URL,
    key: string | undefined,
    raw: string,
  ) {
    const diff = /^\/artifacts\/([^/]+)\/versions\/([^/]+)\/diff\/([^/]+)(\/file)?$/.exec(path);
    if (diff && method === "GET") {
      const artifact = state.artifacts.get(diff[1] as string);
      if (!artifact || artifact.state === "deleted")
        return error("not_found", "Artifact not found.");
      const [fromRef, toRef] = [
        decodeURIComponent(diff[2] as string),
        decodeURIComponent(diff[3] as string),
      ];
      return diff[4]
        ? diffFile(artifact, fromRef, toRef, url)
        : compareVersions(artifact, fromRef, toRef, url);
    }
    const match = /^\/artifacts\/([^/]+)\/(versions|rollback)(?:\/([^/]+)(\/download)?)?$/.exec(
      path,
    );
    if (!match) return undefined;
    const artifact = state.artifacts.get(match[1] as string);
    if (!artifact || artifact.state === "deleted") return error("not_found", "Artifact not found.");
    const [, , group, ref, isDownload] = match;
    if (group === "rollback" && !ref && method === "POST") return rollback(artifact, key, raw);
    if (group !== "versions" || method !== "GET") return undefined;
    if (!ref) return listVersions(artifact, url);
    const versionRef = decodeURIComponent(ref);
    return isDownload ? download(artifact, versionRef, url) : versionManifest(artifact, versionRef);
  }

  function prepared(session: UploadSession) {
    return {
      artifactId: session.artifactId,
      versionId: session.versionId,
      versionNumber: session.versionNumber,
      uploadId: session.id,
      expiresAt: iso(clock() + UPLOAD_TTL_MS),
      uploads: [...session.needed]
        .filter(([sha256]) => !state.stored.has(sha256))
        .map(([sha256, size]) => {
          const upload = session.multipart.get(sha256);
          return upload ? multipartTarget(sha256, size, upload) : uploadTarget(sha256, size);
        }),
    };
  }

  function multipartTarget(sha256: string, size: number, upload: FakeMultipart) {
    const doneParts = [...upload.reported.keys()].sort((a, b) => a - b);
    const parts = [];
    for (let partNumber = 1; partNumber <= upload.partCount; partNumber += 1) {
      if (upload.reported.has(partNumber)) continue;
      const offset = (partNumber - 1) * upload.partSize;
      const partSize = Math.min(upload.partSize, size - offset);
      const token = randomUUID();
      const expiresAt = clock() + state.urlTtlMs;
      state.urls.set(token, { sha256, size: partSize, expiresAt, partNumber });
      parts.push({
        partNumber,
        offset,
        size: partSize,
        method: "PUT",
        url: `${origin()}/r2/parts/${sha256}/${partNumber}?token=${token}`,
        headers: { "content-length": String(partSize) },
        expiresAt: iso(expiresAt),
      });
    }
    return {
      sha256,
      size,
      method: "MULTIPART",
      partSize: upload.partSize,
      partCount: upload.partCount,
      doneParts,
      parts,
    };
  }

  function reportPart(ownerId: string, id: string, raw: string): Reply {
    const session = state.sessions.get(id);
    if (!session || session.ownerId !== ownerId) return error("not_found", "Upload not found.");
    if (session.state !== "uploading") return error("upload_incomplete", "Upload is closed.");
    const parsed = UploadedPart.safeParse(parseJson(raw));
    if (!parsed.success) return error("invalid_input", "Invalid part.");
    const upload = session.multipart.get(parsed.data.sha256);
    if (!upload || parsed.data.partNumber > upload.partCount) {
      return error("invalid_input", "Not a part of this upload.");
    }
    upload.reported.set(parsed.data.partNumber, parsed.data.etag);
    state.partReports.push(parsed.data);
    return { status: 204 };
  }

  /** Assembles a multipart object at commit, as R2 does with the reported ETags. */
  function assemble(sha256: string, upload: FakeMultipart): boolean {
    const chunks: Buffer[] = [];
    for (let partNumber = 1; partNumber <= upload.partCount; partNumber += 1) {
      const stored = upload.stored.get(partNumber);
      if (!stored || stored.etag !== upload.reported.get(partNumber)) return false;
      chunks.push(stored.bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (sha256Of(bytes) !== sha256) return false;
    state.uploaded.set(sha256, bytes);
    return true;
  }

  function prepare(
    ownerId: string,
    key: string | undefined,
    raw: string,
    workspace?: string,
  ): Reply {
    const parsedKey = IdempotencyKey.safeParse(key);
    if (!parsedKey.success) return error("invalid_input", "Send an Idempotency-Key header.");
    const previous = idempotency.get(parsedKey.data);
    if (previous) {
      if (previous.hash !== raw) return error("invalid_input", "Key used for another request.");
      return previous.reply;
    }
    const reply = prepareOnce(ownerId, raw, workspace);
    idempotency.set(parsedKey.data, { hash: raw, reply });
    return reply;
  }

  function prepareOnce(ownerId: string, raw: string, workspace?: string): Reply {
    const parsed = PublishRequest.safeParse(parseJson(raw));
    if (!parsed.success) return error("invalid_input", "Invalid publish request.");
    const request = parsed.data;
    let artifactId = newArtifactId();
    let versionNumber = 1;
    let isNew = !request.artifactId;
    if (request.key !== undefined) {
      if (request.artifactId)
        return error("invalid_input", "Send an artifact ID or a key, not both.");
      const keyed = [...state.artifacts.values()].find(
        (artifact) =>
          artifact.key === request.key &&
          artifact.workspace === workspace &&
          artifact.state !== "deleted",
      );
      if (keyed) {
        if (keyed.state === "archived") {
          return error("artifact_archived", "Restore the artifact before publishing to it.");
        }
        artifactId = keyed.id;
        versionNumber = keyed.versions + 1;
        isNew = false;
      }
    }
    if (request.artifactId) {
      const artifact = state.artifacts.get(request.artifactId);
      if (!artifact || artifact.state === "deleted")
        return error("not_found", "Artifact not found.");
      if (artifact.state === "archived") {
        return error("artifact_archived", "Restore the artifact before publishing to it.");
      }
      if (artifact.type !== request.type) return error("invalid_input", "Type mismatch.");
      if (artifact.currentVersionId !== request.baseVersionId) {
        return error("version_conflict", "The artifact changed since you read it.");
      }
      artifactId = artifact.id;
      versionNumber = artifact.versions + 1;
    }
    const needed = new Map<string, number>();
    const multipart = new Map<string, FakeMultipart>();
    for (const file of request.files) {
      if (state.stored.has(file.sha256)) continue;
      needed.set(file.sha256, file.size);
      const config = state.multipart;
      if (request.multipart && config && file.size > config.thresholdBytes) {
        multipart.set(file.sha256, {
          partSize: config.partBytes,
          partCount: Math.ceil(file.size / config.partBytes),
          stored: new Map(),
          reported: new Map(),
        });
      }
    }
    const session: UploadSession = {
      id: `up_${randomUUID().replaceAll("-", "")}`,
      ownerId,
      artifactId,
      isNew,
      workspace: request.artifactId ? undefined : workspace,
      name: request.name,
      type: request.type,
      versionId: `ver_${randomUUID().replaceAll("-", "")}`,
      versionNumber,
      entrypoint: request.entrypoint,
      files: request.files,
      sourceOrigin: request.sourceOrigin ?? null,
      key: request.key,
      needed,
      multipart,
      state: "uploading",
    };
    state.sessions.set(session.id, session);
    return { status: 201, body: prepared(session) };
  }

  function progress(ownerId: string, id: string): Reply {
    const session = state.sessions.get(id);
    if (!session || session.ownerId !== ownerId) return error("not_found", "Upload not found.");
    if (session.state !== "uploading") return error("upload_incomplete", "Upload is closed.");
    return { status: 200, body: prepared(session) };
  }

  function commit(ownerId: string, id: string): Reply {
    const session = state.sessions.get(id);
    if (!session || session.ownerId !== ownerId) return error("not_found", "Upload not found.");
    if (session.state === "committed") return { status: 200, body: session.committed };
    if (session.state !== "uploading") return error("upload_incomplete", "Upload is closed.");
    for (const [sha256, upload] of session.multipart) {
      if (state.stored.has(sha256) || state.uploaded.has(sha256)) continue;
      if (!assemble(sha256, upload)) {
        upload.reported.clear();
        return error("upload_incomplete", `${sha256} could not be assembled from its parts.`);
      }
    }
    const missing = [...session.needed.keys()].filter(
      (sha256) => !state.stored.has(sha256) && !state.uploaded.has(sha256),
    );
    if (missing.length > 0) return error("upload_incomplete", "Some files are missing.");
    for (const sha256 of session.needed.keys()) {
      const bytes = state.uploaded.get(sha256);
      if (bytes) state.stored.set(sha256, bytes);
    }
    const now = clock();
    const existing = state.artifacts.get(session.artifactId);
    const artifact: FakeArtifact = existing ?? {
      id: session.artifactId,
      name: session.name,
      type: session.type,
      state: "active",
      currentVersionId: null,
      versions: 0,
      expiresAt: null,
      archivedAt: null,
      purgeAt: null,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      // New artifacts are private to their owner.
      access: {
        mode: "restricted",
        readers: [],
        indexable: false,
        embeddable: false,
        bar: true,
        commentVisibility: "owner",
        readerCommentVisibility: [],
      },
      policyGeneration: 1,
      workspace: session.workspace,
      key: session.key,
    };
    artifact.name = session.name;
    artifact.versions = session.versionNumber - 1;
    addVersion(artifact, {
      id: session.versionId,
      entrypoint: session.entrypoint,
      files: session.files.map((file) => ({ ...file })),
      sourceOrigin: session.sourceOrigin,
    });
    state.artifacts.set(artifact.id, artifact);
    session.state = "committed";
    session.committed = {
      artifactId: artifact.id,
      versionId: session.versionId,
      versionNumber: session.versionNumber,
      url: contentUrl(artifact.id),
      expiresAt: artifact.expiresAt === null ? null : iso(artifact.expiresAt),
    };
    return { status: 200, body: session.committed };
  }

  function abort(ownerId: string, id: string): Reply {
    const session = state.sessions.get(id);
    if (!session || session.ownerId !== ownerId) return error("not_found", "Upload not found.");
    if (session.state === "uploading") session.state = "aborted";
    return { status: 204 };
  }

  /** Pages by offset (`c<offset>`), like the artifact list; filters by `since` like the Worker. */
  function accessLog(id: string, url: URL): Reply {
    const artifact = state.artifacts.get(id);
    if (!artifact || artifact.state === "deleted") return error("not_found", "Artifact not found.");
    const query = AccessLogQuery.safeParse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
    });
    if (!query.success) return error("invalid_input", "Invalid cursor, limit or since.");
    const offset = query.data.cursor === undefined ? 0 : Number(query.data.cursor.slice(1));
    if (!Number.isInteger(offset)) return error("invalid_input", "Invalid cursor.");
    const since = query.data.since;
    const all = (state.accessLogs.get(id) ?? []).filter(
      (entry) => since === undefined || entry.openedAt >= since,
    );
    const body: AccessLogView = {
      artifactId: id,
      entries: all.slice(offset, offset + query.data.limit),
      nextCursor: offset + query.data.limit < all.length ? `c${offset + query.data.limit}` : null,
      windowMinutes: 30,
      retentionDays: 30,
    };
    return { status: 200, body };
  }

  function transfer(id: string, raw: string): Reply {
    const artifact = state.artifacts.get(id);
    if (!artifact || artifact.state === "deleted") return error("not_found", "Artifact not found.");
    const body = parseJson(raw) as { workspace?: unknown };
    const target = body?.workspace;
    if (target !== null && typeof target !== "string") return error("invalid_input", "workspace.");
    if (target !== null && !state.workspaces.some((w) => w.slug === target)) {
      return error("not_found", "Workspace not found.");
    }
    const from = state.workspaces.find((w) => w.slug === artifact.workspace);
    if (from && (target ?? undefined) !== artifact.workspace && from.role !== "admin") {
      return error("forbidden", "Your role on this workspace does not allow this.");
    }
    artifact.workspace = target ?? undefined;
    return { status: 200, body: summary(artifact, state.workspaces) };
  }

  function listArtifacts(url: URL, workspace?: string): Reply {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const cursor = url.searchParams.get("cursor");
    const offset = cursor === null ? 0 : Number(cursor.replace(/^c/, ""));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset)) {
      return error("invalid_input", "Invalid cursor or limit.");
    }
    const query = Object.fromEntries(
      ["search", "state", "type", "access", "annotations", "key", "expiring"].flatMap((name) => {
        const value = url.searchParams.get(name);
        return value ? [[name, value]] : [];
      }),
    );
    const filters = ArtifactListFilters.safeParse(query);
    if (!filters.success) return error("invalid_input", "Invalid filter.");
    const search = filters.data.search?.toLowerCase();
    const matches = (item: ArtifactSummary) =>
      (search === undefined ||
        item.name.toLowerCase().includes(search) ||
        item.id.includes(search)) &&
      (filters.data.state === undefined || item.state === filters.data.state) &&
      (filters.data.type === undefined || item.type === filters.data.type) &&
      (filters.data.access === undefined || item.accessMode === filters.data.access) &&
      (filters.data.annotations === undefined || item.annotations === filters.data.annotations) &&
      (filters.data.key === undefined || item.key === filters.data.key) &&
      (filters.data.expiring === undefined || expiringSoon(item, clock()));
    const all = [...state.artifacts.values()]
      .filter((artifact) => artifact.state !== "deleted" && artifact.workspace === workspace)
      .filter((artifact) => matches(summary(artifact, state.workspaces)));
    const items = all.slice(offset, offset + limit).map((artifact) => ({
      ...summary(artifact, state.workspaces),
      activity: activityOf(artifact),
      review: state.approvals.get(artifact.id)?.review ?? NO_APPROVAL_REVIEW,
    }));
    const nextCursor = offset + limit < all.length ? `c${offset + limit}` : null;
    return { status: 200, body: { items, nextCursor } };
  }

  function lifecycle(id: string, action: string): Reply {
    const artifact = state.artifacts.get(id);
    if (!artifact || artifact.state === "deleted") return error("not_found", "Artifact not found.");
    const now = clock();
    if (action === "pin" && !state.usage.plan.features.includes("pin")) return planRequired("pin");
    if (action === "renew" || action === "archive" || action === "pin" || action === "unpin") {
      if (artifact.state !== "active") {
        return error("artifact_archived", "Restore the artifact first.");
      }
    }
    if (action === "renew" && !artifact.pinned) artifact.expiresAt = now + 30 * DAY_MS;
    if (action === "pin") {
      artifact.pinned = true;
      artifact.expiresAt = null;
    }
    if (action === "unpin" && artifact.pinned) {
      artifact.pinned = false;
      artifact.expiresAt = now + 30 * DAY_MS;
    }
    if (action === "archive") {
      artifact.state = "archived";
      artifact.pinned = false;
      artifact.expiresAt = null;
      artifact.archivedAt = now;
      artifact.purgeAt = now + 182 * DAY_MS;
    }
    if (action === "restore") {
      artifact.state = "active";
      artifact.expiresAt = now + 30 * DAY_MS;
      artifact.archivedAt = null;
      artifact.purgeAt = null;
    }
    if (action === "delete") {
      artifact.state = "deleted";
      return {
        status: 200,
        body: { state: "deleted", expiresAt: null, purgeAt: null, pinned: false },
      };
    }
    artifact.updatedAt = now;
    return {
      status: 200,
      body: {
        state: artifact.state,
        expiresAt: artifact.expiresAt === null ? null : iso(artifact.expiresAt),
        purgeAt: artifact.purgeAt === null ? null : iso(artifact.purgeAt),
        pinned: artifact.pinned,
      },
    };
  }

  function shareLinks(method: string, id: string, linkId: string | undefined, raw: string): Reply {
    const artifact = state.artifacts.get(id);
    if (!artifact || artifact.state === "deleted") return error("not_found", "Artifact not found.");
    const links = state.shareLinks.get(id) ?? [];
    if (method === "GET" && !linkId) {
      return {
        status: 200,
        body: { artifactId: id, enabled: state.shareLinksEnabled, links, activeLimit: 20 },
      };
    }
    if (method === "POST" && !linkId) {
      const parsed = ShareLinkCreate.safeParse(parseJson(raw));
      if (!parsed.success) return error("invalid_input", "Invalid share link.");
      if (!state.shareLinksEnabled) return planRequired("shareLinks");
      const token = randomUUID().replaceAll("-", "").padEnd(43, "x");
      state.shareTokens.push(token);
      const link: ShareLinkView = {
        id: `sl_${randomUUID().replaceAll("-", "")}`,
        label: parsed.data.label,
        state: "active",
        hasPassword: parsed.data.password !== undefined,
        createdAt: new Date(clock()).toISOString(),
        expiresAt: parsed.data.expiresAt ?? null,
        lastUsedOn: null,
      };
      state.shareLinks.set(id, [link, ...links]);
      return { status: 201, body: { link, url: `${origin()}/s#${token}` } };
    }
    if (method === "DELETE" && linkId) {
      if (!links.some((link) => link.id === linkId)) {
        return error("not_found", "Share link not found.");
      }
      state.shareLinks.set(
        id,
        links.filter((link) => link.id !== linkId),
      );
      return { status: 200, body: { id: linkId, revoked: true } };
    }
    return error("not_found", "Not found.");
  }

  /**
   * Approval reviews, kept simple: the CLI only sends and prints, the services decide. A request
   * names its reviewers, a verdict is the signed-in person's, and every write needs a key.
   */
  function approvalReview(
    method: string,
    id: string,
    verdict: string | undefined,
    key: string | undefined,
    raw: string,
  ): Reply {
    const artifact = state.artifacts.get(id);
    if (!artifact || artifact.state === "deleted") return error("not_found", "Artifact not found.");
    const body = raw === "" ? undefined : parseJson(raw);
    if (method !== "GET")
      state.approvalCalls.push({
        method,
        path: `/artifacts/${id}/review${verdict ?? ""}`,
        key,
        body,
      });
    const none: ApprovalReviewView = {
      artifactId: id,
      role: "owner",
      available: true,
      review: NO_APPROVAL_REVIEW,
      request: null,
    };
    const current = state.approvals.get(id) ?? none;
    if (method === "GET" && !verdict) return { status: 200, body: current };
    if (method !== "DELETE" && key === undefined) {
      return error("invalid_input", "Send an Idempotency-Key header (8 to 128 characters).");
    }
    if (method === "DELETE" && !verdict) {
      if (current.request === null)
        return error("not_found", "This artifact has no open review request.");
      state.approvals.delete(id);
      return { status: 200, body: none };
    }
    if (method === "POST" && verdict) {
      const parsed = ApprovalVerdictInput.safeParse(body);
      if (!parsed.success || current.request === null) {
        return error("forbidden", "You are not one of this artifact's reviewers.");
      }
      const approvals = parsed.data.verdict === "approve" ? 1 : 0;
      const next: ApprovalReviewView = {
        ...current,
        role: "reviewer",
        review: {
          ...current.review,
          status: approvals === 1 ? "approved" : "changes_requested",
          approvals,
          changesRequested: 1 - approvals,
        },
      };
      state.approvals.set(id, next);
      return { status: 200, body: next };
    }
    if (method === "POST") {
      const parsed = ApprovalRequestInput.safeParse(body);
      if (!parsed.success) return error("invalid_input", "Invalid review request.");
      const reviewers = parsed.data.reviewers.length;
      const view: ApprovalReviewView = {
        ...none,
        review: {
          status: "pending",
          reviewers,
          required: parsed.data.requiredApprovals ?? reviewers,
          approvals: 0,
          changesRequested: 0,
        },
        request: {
          id: `ar_${"0".repeat(32)}`,
          versionId: artifact.currentVersionId ?? "ver_none",
          requiredApprovals: parsed.data.requiredApprovals ?? null,
          showStatus: parsed.data.showStatus ?? false,
          requestedAt: new Date(clock()).toISOString(),
          updatedAt: new Date(clock()).toISOString(),
          requestedBy: "Owner",
          reviewers: parsed.data.reviewers.map((email, i) => ({
            id: `rvw_${String(i).padStart(24, "0")}`,
            name: null,
            email,
            active: true,
            you: false,
            verdict: null,
            note: null,
            decidedAt: null,
          })),
          history: [],
        },
      };
      state.approvals.set(id, view);
      return { status: 201, body: view };
    }
    if (method === "PATCH") {
      const parsed = ApprovalChangeInput.safeParse(body);
      if (!parsed.success) return error("invalid_input", "Say what to change.");
      if (current.request === null)
        return error("not_found", "This artifact has no open review request.");
      return { status: 200, body: current };
    }
    return error("not_found", "Not found.");
  }

  function domainList(url: URL): Reply {
    const artifactId = url.searchParams.get("artifactId");
    const domains = [...state.domains.values()].filter(
      (domain) => artifactId === null || domain.artifactId === artifactId,
    );
    return {
      status: 200,
      body: {
        available: true,
        enabled: state.domainsEnabled,
        limit: state.domainsEnabled ? 1 : 0,
        used: [...state.domains.values()].filter(
          (d) => d.state === "active" || d.state === "provisioning",
        ).length,
        cnameTarget: "domains.portifact.dev",
        domains,
      },
    };
  }

  function addDomain(id: string, raw: string): Reply {
    const artifact = state.artifacts.get(id);
    if (!artifact || artifact.state === "deleted") return error("not_found", "Artifact not found.");
    if (!state.domainsEnabled) return planRequired("customDomains");
    const parsed = CustomDomainAdd.safeParse(parseJson(raw));
    if (!parsed.success) return error("invalid_input", "Invalid hostname.");
    const hostname = parsed.data.hostname.toLowerCase();
    const view: CustomDomainView = {
      hostname,
      artifactId: id,
      state: "pending",
      records: [
        {
          type: "TXT",
          name: `_portifact.${hostname}`,
          value: "portifact-verify=0123456789abcdef0123456789abcdef",
        },
        { type: "CNAME", name: hostname, value: "domains.portifact.dev" },
      ],
      claimExpiresAt: new Date(clock() + 7 * DAY_MS).toISOString(),
      verifiedAt: null,
      checkedAt: null,
      missedChecks: 0,
      problem: null,
    };
    state.domains.set(hostname, view);
    return { status: 201, body: view };
  }

  function domain(method: string, hostname: string, verify: boolean): Reply {
    const view = state.domains.get(hostname);
    if (!view) return error("not_found", "Custom domain not found.");
    if (method === "GET" && !verify) return { status: 200, body: view };
    if (method === "POST" && verify) return { status: 200, body: view };
    if (method === "DELETE" && !verify) {
      state.domains.set(hostname, { ...view, state: "removing" });
      return { status: 200, body: { hostname, removed: true } };
    }
    return error("not_found", "Not found.");
  }

  function access(method: string, id: string, raw: string): Reply {
    const artifact = state.artifacts.get(id);
    if (!artifact || artifact.state === "deleted") return error("not_found", "Artifact not found.");
    if (method === "PATCH") {
      const parsed = AccessUpdate.safeParse(parseJson(raw));
      if (!parsed.success) return error("invalid_input", "Invalid access change.");
      const change = parsed.data;
      if (change.mode === "public" && state.tooNewForPublic) {
        return error("account_too_new_for_public", "Your account is too new to share publicly.");
      }
      const groups = new Map((artifact.groups ?? []).map((group) => [group.id, group]));
      if ((change.addGroups ?? []).length > 0) {
        if (artifact.workspace === undefined) {
          return error("invalid_input", "Only workspace artifacts can list groups.");
        }
        if (!state.usage.plan.features.includes("workspaces")) return planRequired("workspaces");
      }
      for (const id of change.addGroups ?? []) {
        const group = state.groups.get(artifact.workspace ?? "")?.find((one) => one.id === id);
        if (!group) return error("invalid_input", `${id} is not a group of this workspace.`);
        if (!groups.has(id)) {
          groups.set(id, { id, name: group.name, members: group.members, commentVisibility: null });
        }
      }
      for (const id of change.removeGroups ?? []) groups.delete(id);
      for (const entry of change.groupCommentVisibility ?? []) {
        const group = groups.get(entry.group);
        if (!group) return error("invalid_input", "Not a group of the artifact.");
        group.commentVisibility =
          entry.commentVisibility === "inherit" ? null : entry.commentVisibility;
      }
      artifact.groups = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
      const readers = new Set(artifact.access.readers);
      for (const reader of change.addReaders ?? []) readers.add(reader);
      for (const reader of change.removeReaders ?? []) readers.delete(reader);
      const exceptions = new Map(
        artifact.access.readerCommentVisibility
          .filter((entry) => readers.has(entry.email))
          .map((entry) => [entry.email, entry.commentVisibility]),
      );
      for (const entry of change.readerCommentVisibility ?? []) {
        if (!readers.has(entry.email)) return error("invalid_input", "Not a reader.");
        if (entry.commentVisibility === "inherit") exceptions.delete(entry.email);
        else exceptions.set(entry.email, entry.commentVisibility);
      }
      artifact.access = {
        mode: change.mode ?? artifact.access.mode,
        readers: [...readers].sort(),
        indexable: change.indexable ?? artifact.access.indexable,
        embeddable: change.embeddable ?? artifact.access.embeddable,
        bar: change.bar ?? artifact.access.bar,
        commentVisibility: change.commentVisibility ?? artifact.access.commentVisibility,
        readerCommentVisibility: [...exceptions]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([email, commentVisibility]) => ({ email, commentVisibility })),
      };
      artifact.policyGeneration += 1;
    }
    const view: AccessPolicyView = {
      ...artifact.access,
      policyGeneration: artifact.policyGeneration,
      audience: artifact.audience ?? null,
      groups: artifact.groups ?? [],
    };
    return { status: 200, body: view };
  }

  /** /webhooks like the Worker: plan gate on create, enable and test; others never gated. */
  function webhookRoute(method: string, path: string, raw: string): Reply | undefined {
    const available = state.usage.plan.features.includes("webhooks");
    const missing = () => error("not_found", "Webhook not found.");
    if (path === "/webhooks" && method === "GET") {
      return {
        status: 200,
        body: {
          webhooks: [...state.webhooks.values()],
          available,
          serviceAvailable: state.webhooksOffered,
          limit: 10,
        },
      };
    }
    if (path === "/webhooks" && method === "POST") {
      const body = WebhookCreate.safeParse(JSON.parse(raw || "{}"));
      if (!body.success) return error("invalid_input", body.error.issues[0]?.message ?? "Invalid.");
      if (!available) return planRequired("webhooks");
      const url = new URL(body.data.url);
      if (url.protocol !== "https:")
        return error("invalid_input", "The URL must start with https://.");
      const id = `wh_${randomUUID().replaceAll("-", "")}`;
      const webhook: WebhookView = {
        id,
        host: url.hostname,
        format: body.data.format,
        events: body.data.events,
        state: "active",
        disabledReason: null,
        disabledAt: null,
        failures: 0,
        createdAt: new Date(clock()).toISOString(),
        createdVia: "portifact-cli",
        createdBy: "Ada",
        probation: false,
        lastAttempt: null,
      };
      state.webhooks.set(id, webhook);
      return {
        status: 201,
        body: { webhook, secret: body.data.format === "generic" ? "whsec_sample-for-tests" : null },
      };
    }
    const match = /^\/webhooks\/([^/]+)(\/test|\/deliveries)?$/.exec(path);
    if (!match) return undefined;
    const webhook = state.webhooks.get(decodeURIComponent(match[1] as string));
    if (!webhook) return missing();
    if (match[2] === "/deliveries" && method === "GET") {
      return {
        status: 200,
        body: {
          webhookId: webhook.id,
          attempts: state.webhookAttempts.get(webhook.id) ?? [],
          retentionDays: 7,
        },
      };
    }
    if (match[2] === "/test" && method === "POST") {
      if (!available) return planRequired("webhooks");
      state.webhookTests.push(webhook.id);
      return { status: 202, body: { webhookId: webhook.id, queued: true } };
    }
    if (!match[2] && method === "DELETE") {
      state.webhooks.delete(webhook.id);
      return { status: 200, body: { webhookId: webhook.id, removed: true } };
    }
    if (!match[2] && method === "PATCH") {
      const body = WebhookUpdate.safeParse(JSON.parse(raw || "{}"));
      if (!body.success) return error("invalid_input", body.error.issues[0]?.message ?? "Invalid.");
      const enabled = body.data.enabled ?? webhook.state !== "disabled";
      if (enabled && !available) return planRequired("webhooks");
      if (body.data.events) webhook.events = body.data.events;
      if (body.data.enabled === true) {
        Object.assign(webhook, {
          state: "active",
          disabledReason: null,
          disabledAt: null,
          failures: 0,
        });
      }
      if (body.data.enabled === false && webhook.state !== "disabled") {
        Object.assign(webhook, {
          state: "disabled",
          disabledReason: "manual",
          disabledAt: new Date(clock()).toISOString(),
        });
      }
      return { status: 200, body: webhook };
    }
    return undefined;
  }

  /** Answers an /api/v1 route other than /me, or undefined when there is none. */
  function api(method: string, url: URL, ownerId: string, key: string | undefined, raw: string) {
    const path = url.pathname.slice("/api/v1".length);
    const route = `${method} ${path}`;
    if (route === "GET /workspaces") {
      return {
        status: 200,
        body: {
          items: state.workspaces.map((workspace) => ({
            ...workspace,
            region: "default",
            createdAt: "2026-11-01T00:00:00.000Z",
            policy: workspace.policy ?? DEFAULT_POLICY,
            blocked: workspace.blocked ?? false,
          })),
        },
      };
    }
    const groupList = /^\/workspaces\/([^/]+)\/groups$/.exec(path);
    if (groupList && method === "GET") {
      const slug = decodeURIComponent(groupList[1] as string);
      const member = state.workspaces.find((one) => one.slug === slug);
      if (!member) return error("not_found", "Workspace not found.");
      if (member.role === "member") {
        return error("forbidden", "Your role on this workspace does not allow this.");
      }
      return {
        status: 200,
        body: {
          items: state.groups.get(slug) ?? [],
          available: state.usage.plan.features.includes("workspaces"),
          limit: 50,
        },
      };
    }
    const workspace = url.searchParams.get("workspace") ?? undefined;
    if (["POST /publishes", "GET /artifacts", "GET /usage", "GET /feedback"].includes(route)) {
      state.workspaceParams.push(`${route} ${workspace ?? "personal"}`);
      if (workspace !== undefined && !state.workspaces.some((w) => w.slug === workspace)) {
        return error("not_found", "Workspace not found.");
      }
    }
    if (route === "POST /publishes") return prepare(ownerId, key, raw, workspace);
    const moved = /^\/artifacts\/([^/]+)\/transfer$/.exec(path);
    if (moved && method === "POST") return transfer(decodeURIComponent(moved[1] as string), raw);
    const parts = /^\/publishes\/([^/]+)\/parts$/.exec(path);
    if (parts && method === "POST") {
      return reportPart(ownerId, decodeURIComponent(parts[1] as string), raw);
    }
    let match = /^\/publishes\/([^/]+)(\/commit)?$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1] as string);
      if (method === "GET" && !match[2]) return progress(ownerId, id);
      if (method === "POST" && match[2]) return commit(ownerId, id);
      if (method === "DELETE" && !match[2]) return abort(ownerId, id);
    }
    if (route === "GET /artifacts") return listArtifacts(url, workspace);
    if (route === "GET /usage") return { status: 200, body: state.usage };
    if (route === "GET /feedback") return feedbackPageOf(state, url, workspace);
    if (route === "GET /integrations") {
      const space = workspace ?? "personal";
      if (workspace !== undefined && !state.workspaces.some((w) => w.slug === workspace)) {
        return error("not_found", "Workspace not found.");
      }
      return {
        status: 200,
        body: state.integrations.get(space) ?? {
          connections: [],
          available: false,
          serviceAvailable: false,
          euResidency: false,
        },
      };
    }
    const statsPath = /^\/artifacts\/([^/]+)\/stats$/.exec(path);
    if (statsPath && method === "GET") {
      const id = decodeURIComponent(statsPath[1] as string);
      const artifact = state.artifacts.get(id);
      const body = state.stats.get(id);
      if (!artifact || artifact.state === "deleted" || !body) {
        return error("not_found", "Artifact not found.");
      }
      // The range asked for comes back as the range answered, so tests see what was sent.
      const from = url.searchParams.get("from") ?? body.from;
      const to = url.searchParams.get("to") ?? body.to;
      return { status: 200, body: { ...body, from, to } };
    }
    const hooks = webhookRoute(method, path, raw);
    if (hooks) return hooks;
    if (route === "GET /audit/export") {
      state.auditExportQueries.push(url.search);
      const space = url.searchParams.get("workspace") ?? "personal";
      const all = state.audit.get(space);
      if (!all) return error("not_found", "Workspace not found.");
      const format = AuditExportFormat.parse(url.searchParams.get("format"));
      const cursor = url.searchParams.get("cursor");
      const offset = Number(cursor ?? "0");
      const next = offset + state.auditExportPart;
      const text =
        (cursor === null ? auditExportPreamble(format) : "") +
        all
          .slice(offset, next)
          .map((event) => auditExportLine(format, event))
          .join("");
      return {
        status: 200,
        body: text,
        headers: {
          "content-type": auditExportContentType(format),
          ...(next < all.length ? { [AUDIT_EXPORT_CURSOR_HEADER]: String(next) } : {}),
        },
      };
    }
    if (route === "GET /search") {
      state.searchQueries.push(url.search);
      const body = state.search.get(url.searchParams.get("workspace") ?? "personal");
      return body ? { status: 200, body } : error("not_found", "Workspace not found.");
    }
    if (route === "GET /audit") {
      state.auditQueries.push(url.search);
      const space = url.searchParams.get("workspace") ?? "personal";
      const all = state.audit.get(space);
      if (!all) return error("not_found", "Workspace not found.");
      const offset = Number(url.searchParams.get("cursor") ?? "0");
      const size = Number(url.searchParams.get("limit") ?? "50");
      const next = offset + size;
      return {
        status: 200,
        body: {
          owner:
            space === "personal"
              ? { kind: "personal" }
              : { kind: "workspace", slug: space, name: space },
          events: all.slice(offset, next),
          nextCursor: next < all.length ? String(next) : null,
          retentionDays: 90,
          exportable: true,
        },
      };
    }
    const log = /^\/artifacts\/([^/]+)\/access-log$/.exec(path);
    if (log && method === "GET") return accessLog(decodeURIComponent(log[1] as string), url);
    if (route === "GET /domains") return domainList(url);
    const added = /^\/artifacts\/([^/]+)\/domain$/.exec(path);
    if (added && method === "POST") return addDomain(added[1] as string, raw);
    const named = /^\/domains\/([^/]+)(\/verify)?$/.exec(path);
    if (named)
      return domain(method, decodeURIComponent(named[1] as string), named[2] !== undefined);
    const reviewed = /^\/artifacts\/([^/]+)\/review\/(request|status|verdict)$/.exec(path);
    if (reviewed) {
      const part = reviewed[2] as string;
      if ((part === "status") !== (method === "GET")) return error("not_found", "Not found.");
      return approvalReview(
        method,
        reviewed[1] as string,
        part === "verdict" ? "/verdict" : undefined,
        key,
        raw,
      );
    }
    const shares = /^\/artifacts\/([^/]+)\/share-links(?:\/([^/]+))?$/.exec(path);
    if (shares) return shareLinks(method, shares[1] as string, shares[2], raw);
    const versions = versionRoute(method, path, url, key, raw);
    if (versions) return versions;
    match = /^\/artifacts\/([^/]+)(?:\/(renew|archive|restore|pin|unpin|access))?$/.exec(path);
    if (match) {
      const id = match[1] as string;
      const action = match[2];
      if (action === "access" && (method === "GET" || method === "PATCH")) {
        return access(method, id, raw);
      }
      if (action && action !== "access" && method === "POST") return lifecycle(id, action);
      if (!action && method === "DELETE") return lifecycle(id, "delete");
      if (!action && method === "GET") {
        const artifact = state.artifacts.get(id);
        if (!artifact || artifact.state === "deleted") {
          return error("not_found", "Artifact not found.");
        }
        return { status: 200, body: summary(artifact, state.workspaces) };
      }
    }
    return undefined;
  }

  return { state, storage, api };
}

/** The scope each API route needs, as apps/app/src/api/routes.ts checks it. */
/** A page of GET /feedback: the cursor is the index of the next item. */
function feedbackPageOf(state: FakeApiState, url: URL, workspace: string | undefined): Reply {
  if (workspace !== undefined && !state.usage.plan.features.includes("workspaces")) {
    return planRequired("workspaces");
  }
  const items = state.feedback.get(workspace ?? "personal") ?? [];
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const cursor = url.searchParams.get("cursor");
  const start = cursor === null ? 0 : Number(cursor);
  if (!Number.isInteger(start) || start < 0) return error("invalid_input", "Invalid cursor.");
  const page = items.slice(start, start + limit);
  const next = start + limit < items.length ? String(start + limit) : null;
  const ws = state.workspaces.find((one) => one.slug === workspace);
  return {
    status: 200,
    body: {
      notice: UNTRUSTED_ANNOTATIONS_NOTICE,
      owner: ws ? { kind: "workspace", slug: ws.slug, name: ws.name } : { kind: "personal" },
      role: "owner",
      items: page,
      nextCursor: next,
    },
  };
}

export function scopeFor(method: string, path: string): string {
  if (path === "/api/v1/feedback") return "annotations:read";
  if (path.startsWith("/api/v1/publishes")) return "artifacts:write";
  if (/\/access$/.test(path)) return method === "PATCH" ? "artifacts:share" : "artifacts:read";
  if (/\/share-links(\/|$)/.test(path)) return "artifacts:share";
  if (/\/review\/verdict$/.test(path)) return "annotations:write";
  if (/\/review\/status$/.test(path)) return "artifacts:read";
  if (/\/review\/request$/.test(path)) return "artifacts:write";
  if (/\/domain$|^\/api\/v1\/domains\//.test(path) && method !== "GET") return "artifacts:share";
  if (method === "DELETE") return "artifacts:delete";
  if (method === "POST") return "artifacts:write";
  return "artifacts:read";
}

/** An artifact as the list (and the search results) show it, in the personal space. */
export function listItemOf(artifact: FakeArtifact): ArtifactListItem {
  return {
    ...summary(artifact),
    review: NO_APPROVAL_REVIEW,
    activity: { versions: 1, currentBytes: null, openThreads: 0, lastAnnotationAt: null },
  };
}

/** `expiring: "soon"` as the service decides it: active, expiring within the notices' window. */
function expiringSoon(item: { state: string; expiresAt: string | null }, now = Date.now()) {
  if (item.state !== "active" || item.expiresAt === null) return false;
  const at = Date.parse(item.expiresAt);
  return at > now && at <= noticeWindowEnd(now);
}

function summary(artifact: FakeArtifact, workspaces: FakeWorkspace[] = []): ArtifactSummary {
  const workspace = workspaces.find((one) => one.slug === artifact.workspace);
  return {
    id: artifact.id,
    name: artifact.name,
    type: artifact.type,
    state: artifact.suspensionReason ? "suspended" : artifact.state,
    ...(artifact.suspensionReason ? { suspension: { reason: artifact.suspensionReason } } : {}),
    accessMode: artifact.access.mode,
    annotations: "off",
    currentVersionId: artifact.currentVersionId,
    url: contentUrl(artifact.id),
    owner: workspace
      ? { kind: "workspace", slug: workspace.slug, name: workspace.name }
      : { kind: "personal" },
    expiresAt: artifact.expiresAt === null ? null : iso(artifact.expiresAt),
    archivedAt: artifact.archivedAt === null ? null : iso(artifact.archivedAt),
    purgeAt: artifact.purgeAt === null ? null : iso(artifact.purgeAt),
    pinned: artifact.pinned,
    key: artifact.key ?? null,
    ...(artifact.customHost ? { customHost: artifact.customHost } : {}),
    createdAt: iso(artifact.createdAt),
    updatedAt: iso(artifact.updatedAt),
  };
}

export function error(code: ErrorCode, message: string): Reply {
  return { status: ERROR_STATUS[code], body: { error: { code, message } } };
}

/** The API's refusal of a paid feature the owner's plan does not include. */
export function planRequired(feature: PlanFeature): Reply {
  return error("plan_required", planRequiredMessage(feature));
}

function newArtifactId(): string {
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += ARTIFACT_ID_ALPHABET[Math.floor(Math.random() * ARTIFACT_ID_ALPHABET.length)];
  }
  return id;
}

function contentTypeOf(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  return "text/plain; charset=utf-8";
}

function contentUrl(id: string): string {
  return `https://${id}.portifact.dev/`;
}

export function sha256Of(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checksum(sha256: string): string {
  return Buffer.from(sha256, "hex").toString("base64");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
