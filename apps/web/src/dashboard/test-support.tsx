// Test support for the dashboard: an in-memory /api/v1 and session endpoint behind the real
// API client, and a renderer with memory history. Only used by tests.
import type { I18n } from "@lingui/core";
import {
  type AccessLogEntry,
  type AccessLogView,
  type AccessPolicyView,
  AccessUpdate,
  type AccountSettings,
  type AccountUsageView,
  type AnnotationMessageView,
  type AnnotationRole,
  type AnnotationsState,
  type AnnotationThreadView,
  type ArtifactActivity,
  ArtifactListQuery,
  type ArtifactSummary,
  type BrowserSession,
  type CommentScope,
  type ConnectedApp,
  DocumentPreviewRequest,
  type ErrorCode,
  LIMITS,
  type ManifestFile,
  PLANS,
  type PreparedPublish,
  PublishRequest,
  type ReviewStart,
  RollbackRequest,
  type ShareLinkCreated,
  type ShareLinkList,
  type ShareLinkView,
  UNTRUSTED_ANNOTATIONS_NOTICE,
  type UploadTarget,
  type UsageBlock,
  type VersionSummary,
  type ViewerInfo,
} from "@portifact/contracts";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { HumanCheckWidget } from "../human-check/turnstile.ts";
import { dashboardApi } from "./api.ts";
import { DashboardApp } from "./app.tsx";
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
    expiresAt: "2026-12-08T12:00:00.000Z",
    archivedAt: null,
    purgeAt: null,
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

export interface FakeServer {
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
  /** The body of GET /api/v1/usage. */
  usage: AccountUsageView;
  /** Access log entries by artifact ID, newest first, paged by `pageSize` like the Worker. */
  accessLogs: Record<string, AccessLogEntry[]>;
  /** Share links by artifact ID, newest first, as the API lists them. */
  shareLinks: Record<string, ShareLinkView[]>;
  /** Whether the owner's plan includes share links. */
  shareLinksEnabled: boolean;
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
      locale: null,
    },
    usage: usageView(),
    accessLogs: {},
    shareLinks: {},
    shareLinksEnabled: true,
    bodies: [],
    pageSize: 50,
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
        expiresAt: null,
        archivedAt: null,
        purgeAt: null,
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

function route(server: FakeServer, method: string, url: URL, headers: Headers): Response {
  const publishing = publishingRoute(server, method, url, headers);
  if (publishing) return publishing;
  const path = url.pathname;
  const viewed = /^\/api\/v1\/artifacts\/([^/]+)\/viewer$/.exec(path);
  if (viewed && method === "GET") return viewerRoute(server, viewed[1] ?? "");
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
  if (path === "/api/v1/usage" && method === "GET") {
    return Response.json(server.usage);
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
    const policy = server.access[owned.id] ?? {
      mode: owned.accessMode,
      readers: [],
      indexable: false,
      embeddable: false,
      bar: true,
      commentVisibility: "owner",
      readerCommentVisibility: [],
      policyGeneration: 1,
    };
    server.access[owned.id] = policy;
    if (method === "GET") return Response.json(policy);
    return applyAccess(owned, policy, server.bodies.at(-1));
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
    const matching = server.artifacts.filter(
      (a) =>
        (search === undefined || a.name.toLowerCase().includes(search) || a.id.includes(search)) &&
        (filters.state === undefined || a.state === filters.state) &&
        (filters.type === undefined || a.type === filters.type) &&
        (filters.access === undefined || a.accessMode === filters.access) &&
        (filters.annotations === undefined || a.annotations === filters.annotations),
    );
    const start = Number(cursor ?? 0);
    const items = matching
      .slice(start, start + server.pageSize)
      .map((a) => ({ ...a, activity: server.activity[a.id] ?? DEFAULT_ACTIVITY }));
    const next = start + server.pageSize;
    return Response.json({
      items,
      nextCursor: next < matching.length ? String(next) : null,
    });
  }
  const match = /^\/api\/v1\/artifacts\/([^/]+)(?:\/(renew|archive|restore))?$/.exec(path);
  const found = match && server.artifacts.find((a) => a.id === match[1]);
  if (!match || !found) {
    return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
  }
  if (method === "GET" && !match[2]) return Response.json(found);
  if (method === "DELETE" && !match[2]) {
    server.artifacts = server.artifacts.filter((a) => a !== found);
    return Response.json({ state: "deleted", expiresAt: null, purgeAt: null });
  }
  const action = match[2];
  if (action === "archive") {
    Object.assign(found, {
      state: "archived",
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
  return Response.json({ state: found.state, expiresAt: found.expiresAt, purgeAt: found.purgeAt });
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
    });
  if (!info) return missing();
  if (server.email === null) {
    return info.accessMode === "public" ? Response.json({ ...info, role: "anonymous" }) : missing();
  }
  return Response.json(info);
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
function applyAccess(artifact: ArtifactSummary, policy: AccessPolicyView, body: unknown): Response {
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
  } = change.data;
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
