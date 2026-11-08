// The /api/v1 publishing and artifact routes of the fake server, and a fake presigned storage
// target. They follow apps/app's contract: the same shapes (validated with packages/contracts),
// error codes, idempotency replay, deduplication by SHA-256 and lifecycle states. Storage checks
// the signed size and checksum headers, the bytes and the URL's expiry like R2 does.
import { createHash, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  type AccessMode,
  type AccessPolicyView,
  AccessUpdate,
  ARTIFACT_ID_ALPHABET,
  type ArtifactSummary,
  type ArtifactType,
  ERROR_STATUS,
  type ErrorCode,
  IdempotencyKey,
  PublishRequest,
} from "@portifact/contracts";

export interface Reply {
  status: number;
  body?: unknown;
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
  access: { mode: AccessMode; readers: string[]; indexable: boolean; embeddable: boolean };
  policyGeneration: number;
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
  /** Objects this upload must send; they stay pending until the commit verifies them. */
  needed: Map<string, number>;
  state: "uploading" | "committed" | "aborted";
  committed?: unknown;
}

export interface PutRecord {
  sha256: string;
  headers: IncomingHttpHeaders;
  bytes: number;
  status: number;
}

export interface FakeApiState {
  artifacts: Map<string, FakeArtifact>;
  /** Objects the account already stores, by SHA-256. */
  stored: Map<string, Buffer>;
  /** Objects uploaded and not committed yet. */
  uploaded: Map<string, Buffer>;
  sessions: Map<string, UploadSession>;
  puts: PutRecord[];
  /** Upload URLs the server handed out, by token. */
  urls: Map<string, { sha256: string; size: number; expiresAt: number }>;
  /** The account is in its first days, so it cannot make an artifact public. */
  tooNewForPublic: boolean;
  /** How long upload URLs stay valid. */
  urlTtlMs: number;
  /** Creates an artifact as if it had been published before the test. */
  seed(overrides?: Partial<FakeArtifact>): FakeArtifact;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = DAY_MS;

export function createFakeApi(origin: () => string, clock: () => number) {
  const idempotency = new Map<string, { hash: string; reply: Reply }>();
  const state: FakeApiState = {
    artifacts: new Map(),
    stored: new Map(),
    uploaded: new Map(),
    sessions: new Map(),
    puts: [],
    urls: new Map(),
    tooNewForPublic: false,
    urlTtlMs: 15 * 60 * 1000,
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
        access: { mode: "restricted", readers: [], indexable: false, embeddable: false },
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

  function prepared(session: UploadSession) {
    return {
      artifactId: session.artifactId,
      versionId: session.versionId,
      versionNumber: session.versionNumber,
      uploadId: session.id,
      expiresAt: iso(clock() + UPLOAD_TTL_MS),
      uploads: [...session.needed]
        .filter(([sha256]) => !state.stored.has(sha256))
        .map(([sha256, size]) => uploadTarget(sha256, size)),
    };
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
    for (const file of request.files) {
      if (!state.stored.has(file.sha256)) needed.set(file.sha256, file.size);
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
      needed,
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
      access: { mode: "restricted", readers: [], indexable: false, embeddable: false },
      policyGeneration: 1,
    };
    artifact.name = session.name;
    artifact.currentVersionId = session.versionId;
    artifact.versions = session.versionNumber;
    artifact.expiresAt = now + 30 * DAY_MS;
    artifact.updatedAt = now;
    state.artifacts.set(artifact.id, artifact);
    session.state = "committed";
    session.committed = {
      artifactId: artifact.id,
      versionId: session.versionId,
      versionNumber: session.versionNumber,
      url: contentUrl(artifact.id),
      expiresAt: iso(artifact.expiresAt),
    };
    return { status: 200, body: session.committed };
  }

  function abort(ownerId: string, id: string): Reply {
    const session = state.sessions.get(id);
    if (!session || session.ownerId !== ownerId) return error("not_found", "Upload not found.");
    if (session.state === "uploading") session.state = "aborted";
    return { status: 204 };
  }

  function listArtifacts(url: URL): Reply {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const cursor = url.searchParams.get("cursor");
    const offset = cursor === null ? 0 : Number(cursor.replace(/^c/, ""));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset)) {
      return error("invalid_input", "Invalid cursor or limit.");
    }
    const all = [...state.artifacts.values()].filter((artifact) => artifact.state !== "deleted");
    const items = all.slice(offset, offset + limit).map(summary);
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
      artifact.access = {
        mode: change.mode ?? artifact.access.mode,
        readers: [...readers].sort(),
        indexable: change.indexable ?? artifact.access.indexable,
        embeddable: change.embeddable ?? artifact.access.embeddable,
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
    let match = /^\/publishes\/([^/]+)(\/commit)?$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1] as string);
      if (method === "GET" && !match[2]) return progress(ownerId, id);
      if (method === "POST" && match[2]) return commit(ownerId, id);
      if (method === "DELETE" && !match[2]) return abort(ownerId, id);
    }
    if (route === "GET /artifacts") return listArtifacts(url);
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
    state: artifact.state,
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
