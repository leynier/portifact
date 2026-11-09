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
  ARTIFACT_ID_ALPHABET,
  ArtifactListFilters,
  type ArtifactSummary,
  type ArtifactType,
  type CommentScope,
  type CommentVisibility,
  ERROR_STATUS,
  type ErrorCode,
  IdempotencyKey,
  type ManifestFile,
  PublishRequest,
  RollbackRequest,
  type SourceOrigin,
  UploadedPart,
} from "@portifact/contracts";

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
  name: string;
  type: ArtifactType;
  versionId: string;
  versionNumber: number;
  entrypoint: string;
  files: ManifestFile[];
  sourceOrigin: SourceOrigin | null;
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
  /** How long upload URLs stay valid. */
  urlTtlMs: number;
  /** Creates an artifact as if it had been published before the test. */
  seed(overrides?: Partial<FakeArtifact>): FakeArtifact;
  /** What GET /usage answers. */
  usage: AccountUsageView;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = DAY_MS;

export function createFakeApi(origin: () => string, clock: () => number) {
  const idempotency = new Map<string, { hash: string; reply: Reply }>();
  const state: FakeApiState = {
    artifacts: new Map(),
    accessLogs: new Map(),
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
    urlTtlMs: 15 * 60 * 1000,
    usage: {
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
    artifact.expiresAt = now + 30 * DAY_MS;
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
    return { status: 200, body: { artifactId: artifact.id, items, nextCursor } };
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
        expiresAt: iso(artifact.expiresAt ?? clock()),
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

  function prepare(ownerId: string, key: string | undefined, raw: string): Reply {
    const parsedKey = IdempotencyKey.safeParse(key);
    if (!parsedKey.success) return error("invalid_input", "Send an Idempotency-Key header.");
    const previous = idempotency.get(parsedKey.data);
    if (previous) {
      if (previous.hash !== raw) return error("invalid_input", "Key used for another request.");
      return previous.reply;
    }
    const reply = prepareOnce(ownerId, raw);
    idempotency.set(parsedKey.data, { hash: raw, reply });
    return reply;
  }

  function prepareOnce(ownerId: string, raw: string): Reply {
    const parsed = PublishRequest.safeParse(parseJson(raw));
    if (!parsed.success) return error("invalid_input", "Invalid publish request.");
    const request = parsed.data;
    let artifactId = newArtifactId();
    let versionNumber = 1;
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
      isNew: !request.artifactId,
      name: request.name,
      type: request.type,
      versionId: `ver_${randomUUID().replaceAll("-", "")}`,
      versionNumber,
      entrypoint: request.entrypoint,
      files: request.files,
      sourceOrigin: request.sourceOrigin ?? null,
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
      expiresAt: iso(artifact.expiresAt ?? now),
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

  function listArtifacts(url: URL): Reply {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const cursor = url.searchParams.get("cursor");
    const offset = cursor === null ? 0 : Number(cursor.replace(/^c/, ""));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset)) {
      return error("invalid_input", "Invalid cursor or limit.");
    }
    const query = Object.fromEntries(
      ["search", "state", "type", "access", "annotations"].flatMap((name) => {
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
      (filters.data.annotations === undefined || item.annotations === filters.data.annotations);
    const all = [...state.artifacts.values()]
      .filter((artifact) => artifact.state !== "deleted")
      .filter((artifact) => matches(summary(artifact)));
    const items = all
      .slice(offset, offset + limit)
      .map((artifact) => ({ ...summary(artifact), activity: activityOf(artifact) }));
    const nextCursor = offset + limit < all.length ? `c${offset + limit}` : null;
    return { status: 200, body: { items, nextCursor } };
  }

  function lifecycle(id: string, action: string): Reply {
    const artifact = state.artifacts.get(id);
    if (!artifact || artifact.state === "deleted") return error("not_found", "Artifact not found.");
    const now = clock();
    if (action === "renew" || action === "archive") {
      if (artifact.state !== "active") {
        return error("artifact_archived", "Restore the artifact first.");
      }
    }
    if (action === "renew") artifact.expiresAt = now + 30 * DAY_MS;
    if (action === "archive") {
      artifact.state = "archived";
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
      return { status: 200, body: { state: "deleted", expiresAt: null, purgeAt: null } };
    }
    artifact.updatedAt = now;
    return {
      status: 200,
      body: {
        state: artifact.state,
        expiresAt: artifact.expiresAt === null ? null : iso(artifact.expiresAt),
        purgeAt: artifact.purgeAt === null ? null : iso(artifact.purgeAt),
      },
    };
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
    };
    return { status: 200, body: view };
  }

  /** Answers an /api/v1 route other than /me, or undefined when there is none. */
  function api(method: string, url: URL, ownerId: string, key: string | undefined, raw: string) {
    const path = url.pathname.slice("/api/v1".length);
    const route = `${method} ${path}`;
    if (route === "POST /publishes") return prepare(ownerId, key, raw);
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
    if (route === "GET /artifacts") return listArtifacts(url);
    if (route === "GET /usage") return { status: 200, body: state.usage };
    const log = /^\/artifacts\/([^/]+)\/access-log$/.exec(path);
    if (log && method === "GET") return accessLog(decodeURIComponent(log[1] as string), url);
    const versions = versionRoute(method, path, url, key, raw);
    if (versions) return versions;
    match = /^\/artifacts\/([^/]+)(?:\/(renew|archive|restore|access))?$/.exec(path);
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
        return { status: 200, body: summary(artifact) };
      }
    }
    return undefined;
  }

  return { state, storage, api };
}

/** The scope each API route needs, as apps/app/src/api/routes.ts checks it. */
export function scopeFor(method: string, path: string): string {
  if (path.startsWith("/api/v1/publishes")) return "artifacts:write";
  if (/\/access$/.test(path)) return method === "PATCH" ? "artifacts:share" : "artifacts:read";
  if (method === "DELETE") return "artifacts:delete";
  if (method === "POST") return "artifacts:write";
  return "artifacts:read";
}

function summary(artifact: FakeArtifact): ArtifactSummary {
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
    expiresAt: artifact.expiresAt === null ? null : iso(artifact.expiresAt),
    archivedAt: artifact.archivedAt === null ? null : iso(artifact.archivedAt),
    purgeAt: artifact.purgeAt === null ? null : iso(artifact.purgeAt),
    createdAt: iso(artifact.createdAt),
    updatedAt: iso(artifact.updatedAt),
  };
}

export function error(code: ErrorCode, message: string): Reply {
  return { status: ERROR_STATUS[code], body: { error: { code, message } } };
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
