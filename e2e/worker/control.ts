// Seeding and inspection for the end-to-end tests, through the same services and tables the
// Workers use. Only the e2e Worker has these routes, on a host the browsers cannot reach.
import { TERMS_VERSION } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import {
  commitPublish,
  createAnnotationThread,
  issueReviewHandoff,
  preparePublish,
  updateAccess,
} from "@portifact/services";
import type { Env as AppEnv } from "../../apps/app/src/env.ts";
import type { Env as ContentEnv } from "../../apps/content/src/index.ts";
import { setContentClockOffset } from "./clock.ts";

export const CONTROL_HOST = "control.e2e.test";
/** Where the e2e Worker keeps the last email sent to each address, in the local bucket. */
export const MAIL_PREFIX = "e2e-mail/";
export type E2eEnv = AppEnv & ContentEnv;

const DAY = 86_400_000;

/**
 * Seeded comments skip the human check on purpose: this Worker only runs in the e2e suite, and
 * the check itself is covered by the services and app tests.
 */
const HUMAN = { token: "e2e-seed", verify: async () => "passed" as const };

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The value Better Auth puts in its session cookie: the token and its HMAC, URL-encoded. */
async function signedToken(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(mac)))}`);
}

interface UserInput {
  email: string;
  name: string;
}

interface PublishInput {
  ownerId: string;
  type: "site" | "markdown" | "text";
  name: string;
  files: Record<string, string>;
  accessMode?: "public" | "authenticated" | "restricted";
  readers?: string[];
  annotations?: "off" | "open" | "locked";
  /** The Portifact bar; on by default, like a new artifact. */
  bar?: boolean;
  /** Publishes a new version of this artifact on `baseVersionId` instead of a new artifact. */
  update?: { artifactId: string; baseVersionId: string };
}

interface ThreadInput {
  userId: string;
  artifactId: string;
  versionId: string;
  body: string;
  path: string;
  /** Milliseconds in the past to write it at: the load test seeds earlier comments this way. */
  agoMs?: number;
}

interface ReviewCodeInput {
  userId: string;
  sessionId: string;
  artifactId: string;
  kind?: "frame" | "tab";
}

interface AccessInput {
  ownerId: string;
  artifactId: string;
  removeReaders?: string[];
  addReaders?: string[];
}

interface ClockInput {
  /** The artifact whose delivery runs on the moved clock; every other artifact keeps real time. */
  artifactId: string;
  /** How far ahead of real time the content Worker's clock runs for it; 0 puts it back. */
  offsetMs: number;
}

interface SqlInput {
  query: string;
  params?: (string | number | null)[];
  /** `access` runs it against the access log database instead of the control database. */
  database?: "control" | "access";
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  svg: "image/svg+xml",
};

/**
 * Local stand-in for R2's S3 endpoint, which presigned URLs target in production: the load test
 * (scripts/load-test.ts) sends each presigned upload here with the same signed headers. It refuses
 * a body whose length differs from the signed `content-length` and lets R2 refuse a wrong
 * checksum, as R2 does with the signature, and streams the body so a 250 MB publish never sits
 * in memory.
 */
async function storagePut(request: Request, env: E2eEnv, url: URL): Promise<Response> {
  const key = url.searchParams.get("key") ?? "";
  const size = Number(request.headers.get("content-length"));
  const uploadId = url.searchParams.get("uploadId");
  if (uploadId !== null) return partPut(request, env, key, uploadId, url, size);
  const checksum = request.headers.get("x-amz-checksum-sha256") ?? "";
  if (request.method !== "PUT" || !key.startsWith("objects/") || !request.body) {
    return new Response("Bad request", { status: 400 });
  }
  if (!Number.isSafeInteger(size) || size < 0 || checksum === "") {
    return new Response("Missing signed headers", { status: 400 });
  }
  const sha256 = [...atob(checksum)]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  try {
    await env.ARTIFACTS.put(key, request.body.pipeThrough(new FixedLengthStream(size)), {
      sha256,
    });
  } catch {
    return new Response("Upload refused", { status: 400 });
  }
  return new Response(null, { status: 200 });
}

/** S3 UploadPart into the R2 multipart upload the API opened, answering with the part's ETag. */
async function partPut(
  request: Request,
  env: E2eEnv,
  key: string,
  uploadId: string,
  url: URL,
  size: number,
): Promise<Response> {
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (request.method !== "PUT" || !key.startsWith("uploads/") || !request.body) {
    return new Response("Bad request", { status: 400 });
  }
  if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(partNumber)) {
    return new Response("Missing signed headers", { status: 400 });
  }
  try {
    const part = await env.ARTIFACTS.resumeMultipartUpload(key, uploadId).uploadPart(
      partNumber,
      request.body.pipeThrough(new FixedLengthStream(size)),
    );
    return new Response(null, { status: 200, headers: { etag: part.etag } });
  } catch {
    return new Response("Upload refused", { status: 400 });
  }
}

export async function control(request: Request, env: E2eEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/echo") return Response.json(Object.fromEntries(request.headers));
  if (path === "/storage") return storagePut(request, env, url);
  const input = (await request.json()) as unknown;
  const db = createDb(env.DB);
  const now = Date.now();

  if (path === "/user") {
    const { email, name } = input as UserInput;
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const token = crypto.randomUUID().replaceAll("-", "");
    const at = new Date(now - 30 * DAY);
    await db.insert(schema.users).values({
      id: userId,
      email,
      name,
      emailVerified: true,
      termsVersion: TERMS_VERSION,
      termsAcceptedAt: at,
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(schema.sessions).values({
      id: sessionId,
      token,
      userId,
      expiresAt: new Date(now + 7 * DAY),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    return Response.json({
      userId,
      sessionId,
      cookie: await signedToken(token, env.BETTER_AUTH_SECRET),
    });
  }

  if (path === "/publish") {
    const publish = input as PublishInput;
    const encoder = new TextEncoder();
    const entries = Object.entries(publish.files);
    const files = await Promise.all(
      entries.map(async ([file, body]) => ({
        path: file,
        kind: "published" as const,
        sha256: await sha256(encoder.encode(body)),
        size: encoder.encode(body).byteLength,
        contentType: CONTENT_TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream",
      })),
    );
    const prepared = await preparePublish(db, {
      ownerId: publish.ownerId,
      type: publish.type,
      name: publish.name,
      entrypoint: entries[0]?.[0] ?? "index.html",
      ...(publish.update
        ? { artifactId: publish.update.artifactId, baseVersionId: publish.update.baseVersionId }
        : { baseVersionId: null }),
      files,
      now,
    });
    if (!prepared.ok) return Response.json(prepared, { status: 400 });
    for (const [index, [, body]] of entries.entries()) {
      const hash = files[index]?.sha256 as string;
      await env.ARTIFACTS.put(`objects/${publish.ownerId}/${hash}`, body, { sha256: hash });
    }
    const committed = await commitPublish(db, env.ARTIFACTS, {
      ownerId: publish.ownerId,
      sessionId: prepared.value.sessionId,
      now,
    });
    if (!committed.ok) return Response.json(committed, { status: 400 });
    const artifactId = committed.value.artifactId;
    if (publish.update) {
      return Response.json({ artifactId, versionId: committed.value.versionId });
    }
    await env.DB.prepare(
      "UPDATE artifacts SET access_mode = ?, annotations = ?, bar = ?, policy_generation = policy_generation + 1 WHERE id = ?",
    )
      .bind(
        publish.accessMode ?? "restricted",
        publish.annotations ?? "open",
        publish.bar === false ? 0 : 1,
        artifactId,
      )
      .run();
    for (const email of publish.readers ?? []) {
      await env.DB.prepare("INSERT INTO artifact_readers (artifact_id, email) VALUES (?, ?)")
        .bind(artifactId, email)
        .run();
    }
    const version = await env.DB.prepare(
      "SELECT current_version_id AS id FROM artifacts WHERE id = ?",
    )
      .bind(artifactId)
      .first<{ id: string }>();
    return Response.json({ artifactId, versionId: version?.id });
  }

  if (path === "/thread") {
    const thread = input as ThreadInput;
    const result = await createAnnotationThread(db, {
      humanCheck: HUMAN,
      userId: thread.userId,
      artifactId: thread.artifactId,
      versionId: thread.versionId,
      target: { schema: 1, path: thread.path, anchor: { kind: "document" } },
      body: thread.body,
      now: now - (thread.agoMs ?? 0),
    });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  // A review code of another account, as the app's review route issues it: what an attacker
  // gets for an artifact they can read, to plant in someone else's viewer.
  if (path === "/review-code") {
    const { userId, sessionId, artifactId, kind } = input as ReviewCodeInput;
    const issued = await issueReviewHandoff(db, {
      artifactId,
      userId,
      authSessionId: sessionId,
      now,
      ...(kind ? { kind } : {}),
    });
    if (!issued.ok) return Response.json(issued, { status: 400 });
    return Response.json({ code: issued.value.code, sessionTag: issued.value.sessionTag });
  }

  // The owner's access change, through the same service the API, MCP and dashboard call.
  if (path === "/access") {
    const { ownerId, artifactId, removeReaders, addReaders } = input as AccessInput;
    const result = await updateAccess(db, {
      ownerId,
      artifactId,
      change: { removeReaders, addReaders },
      now,
    });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  if (path === "/clock") {
    const { artifactId, offsetMs } = input as ClockInput;
    setContentClockOffset(artifactId, offsetMs);
    return Response.json({ artifactId, offsetMs });
  }

  // The last email the app sent to an address (worker/index.ts keeps it), for sign-in codes.
  if (path === "/mail") {
    const { to } = input as { to: string };
    const object = await env.ARTIFACTS.get(`${MAIL_PREFIX}${to.toLowerCase()}`);
    return object
      ? new Response(object.body, { headers: { "content-type": "application/json" } })
      : Response.json({ error: "no email" }, { status: 404 });
  }

  if (path === "/sql") {
    const { query, params = [], database } = input as SqlInput;
    const target = database === "access" ? env.ACCESS_DB : env.DB;
    const { results } = await target
      .prepare(query)
      .bind(...params)
      .all();
    return Response.json(results);
  }

  return new Response("Not found", { status: 404 });
}
