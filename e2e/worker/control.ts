// Seeding and inspection for the end-to-end tests, through the same services and tables the
// Workers use. Only the e2e Worker has these routes, on a host the browsers cannot reach.
import { type JobMessage, type Region, TERMS_VERSION } from "@portifact/contracts";
import { type RegionEnv, regionsFromEnv, schema } from "@portifact/db";
import {
  commitPublish,
  createAnnotationThread,
  createShareLink,
  createWorkspace,
  customDomainsServing,
  issueReviewHandoff,
  preparePublish,
  revokeShareLink,
  runJob,
  runMaintenance,
  scheduleCommentNotices,
  updateAccess,
} from "@portifact/services";
import type { Env as AppEnv } from "../../apps/app/src/env.ts";
import type { Env as ContentEnv } from "../../apps/content/src/index.ts";
import { type Env as JobsEnv, runQueue } from "../../apps/jobs/src/index.ts";
import { issueDepsFromEnv } from "../../apps/jobs/src/integrations.ts";
import { commentNotifierFromEnv } from "../../apps/jobs/src/notices.ts";
import { runOperator } from "../../apps/jobs/src/operator.ts";
import { auditStreamDepsFromWebhooks, webhookDepsFromEnv } from "../../apps/jobs/src/webhooks.ts";
import { setContentClockOffset } from "./clock.ts";
import { e2eDomains } from "./domains.ts";
import { e2eTrackers } from "./integrations.ts";
import { setNextIdentity } from "./sso.ts";

export const CONTROL_HOST = "control.e2e.test";
/** Where the e2e Worker keeps the last email sent to each address, in the local bucket. */
export const MAIL_PREFIX = "e2e-mail/";
/** Where the stand-in webhook receiver keeps each request it got, in the local bucket. */
export const WEBHOOK_PREFIX = "e2e-webhooks/";
/** The receiver's host: webhook deliveries to it never leave the stack. */
export const RECEIVER_HOST = "hooks.receiver-e2e.example.com";
/** Where the stand-in SIEM collector keeps each audit stream request it got (decision 0019). */
export const COLLECTOR_PREFIX = "e2e-audit-streams/";
/** The collector's host: audit stream requests to it never leave the stack. */
export const COLLECTOR_HOST = "siem.collector-e2e.example.com";
export type E2eEnv = AppEnv & ContentEnv & RegionEnv;

const DAY = 86_400_000;

/**
 * One region's raw bindings (decision 0005): the e2e Worker binds the default region to `DB`,
 * `ACCESS_DB` and `ARTIFACTS` and the EU to `DB_EU`, `ACCESS_DB_EU` and `ARTIFACTS_EU`. Raw
 * statements here arrange and inspect rows, like a test file; product code reaches them only
 * through `regionsFromEnv` and its guard.
 */
function regionBindings(env: E2eEnv, region: Region = "default") {
  if (region === "default") return { db: env.DB, access: env.ACCESS_DB, bucket: env.ARTIFACTS };
  if (!env.DB_EU || !env.ACCESS_DB_EU || !env.ARTIFACTS_EU) throw new Error("eu is not bound");
  return { db: env.DB_EU, access: env.ACCESS_DB_EU, bucket: env.ARTIFACTS_EU };
}

/**
 * The bucket a presigned URL names, by its bucket name (the first segment of its path), or null
 * for any other name: an upload signed for a bucket the stack does not have is refused, never
 * written to the default one.
 */
function bucketNamed(env: E2eEnv, name: string | null): R2Bucket | null {
  if (name !== null && name === env.R2_BUCKET) return env.ARTIFACTS;
  if (name !== null && name === env.R2_BUCKET_EU && env.ARTIFACTS_EU) return env.ARTIFACTS_EU;
  return null;
}

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
  /** A workspace to publish into as `ownerId`; the personal space without it. */
  targetOwnerId?: string;
  type: "site" | "markdown" | "text";
  name: string;
  files: Record<string, string>;
  accessMode?: "public" | "authenticated" | "restricted" | "workspace" | "domain";
  readers?: string[];
  annotations?: "off" | "open" | "locked";
  /** The Portifact bar; on by default, like a new artifact. */
  bar?: boolean;
  /** Publishes a new version of this artifact on `baseVersionId` instead of a new artifact. */
  update?: { artifactId: string; baseVersionId: string };
  /** The owner's region (decision 0005); the default one without it. */
  region?: Region;
}

interface ThreadInput {
  region?: Region;
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
  region?: Region;
  /** A new access mode, as the owner's access change sets it. */
  mode?: "public" | "authenticated" | "restricted" | "workspace" | "domain";
  ownerId: string;
  artifactId: string;
  removeReaders?: string[];
  addReaders?: string[];
}

interface ShareLinkInput {
  region?: Region;
  ownerId: string;
  artifactId: string;
  label?: string;
  expiresAt?: number;
  password?: string;
  /** Revokes this link instead of creating one. */
  revoke?: string;
}

interface ClockInput {
  /** The artifact whose delivery runs on the moved clock; every other artifact keeps real time. */
  artifactId: string;
  /** How far ahead of real time the content Worker's clock runs for it; 0 puts it back. */
  offsetMs: number;
}

interface WorkspaceInput {
  slug: string;
  name: string;
  adminUserId: string;
  /** The plan the operator grants it, `team` with 10 seats by default. */
  seats?: number;
  members?: { userId: string; role: "admin" | "editor" | "member" }[];
}

interface SqlInput {
  query: string;
  params?: (string | number | null)[];
  /** `access` runs it against the access log database instead of the control database. */
  database?: "control" | "access";
  /** The region whose databases it runs against; the default one without it. */
  region?: Region;
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
  // The bucket the URL was signed for: an EU workspace's uploads go to the EU bucket.
  const bucket = bucketNamed(env, url.searchParams.get("bucket"));
  if (!bucket) return new Response("Unknown bucket", { status: 400 });
  // A presigned download: the object as R2 holds it.
  if (request.method === "GET") {
    const object = key.startsWith("objects/") ? await bucket.get(key) : null;
    return object ? new Response(object.body) : new Response("Not found", { status: 404 });
  }
  const size = Number(request.headers.get("content-length"));
  const uploadId = url.searchParams.get("uploadId");
  if (uploadId !== null) return partPut(request, bucket, key, uploadId, url, size);
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
    await bucket.put(key, request.body.pipeThrough(new FixedLengthStream(size)), { sha256 });
  } catch {
    return new Response("Upload refused", { status: 400 });
  }
  return new Response(null, { status: 200 });
}

/** S3 UploadPart into the R2 multipart upload the API opened, answering with the part's ETag. */
async function partPut(
  request: Request,
  bucket: R2Bucket,
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
    const part = await bucket
      .resumeMultipartUpload(key, uploadId)
      .uploadPart(partNumber, request.body.pipeThrough(new FixedLengthStream(size)));
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
  const db = regionsFromEnv(env).get("default").db;
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
    const region = publish.region ?? "default";
    const raw = regionBindings(env, region);
    const db = regionsFromEnv(env).get(region).db;
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
      userId: publish.ownerId,
      ...(publish.targetOwnerId ? { targetOwnerId: publish.targetOwnerId } : {}),
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
      await raw.bucket.put(`objects/${publish.targetOwnerId ?? publish.ownerId}/${hash}`, body, {
        sha256: hash,
      });
    }
    const committed = await commitPublish(db, raw.bucket, {
      userId: publish.ownerId,
      sessionId: prepared.value.sessionId,
      now,
    });
    if (!committed.ok) return Response.json(committed, { status: 400 });
    const artifactId = committed.value.artifactId;
    if (publish.update) {
      return Response.json({ artifactId, versionId: committed.value.versionId });
    }
    await raw.db
      .prepare(
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
      await raw.db
        .prepare("INSERT INTO artifact_readers (artifact_id, email) VALUES (?, ?)")
        .bind(artifactId, email)
        .run();
    }
    const version = await raw.db
      .prepare("SELECT current_version_id AS id FROM artifacts WHERE id = ?")
      .bind(artifactId)
      .first<{ id: string }>();
    return Response.json({ artifactId, versionId: version?.id });
  }

  if (path === "/thread") {
    const thread = input as ThreadInput;
    const result = await createAnnotationThread(
      regionsFromEnv(env).get(thread.region ?? "default").db,
      {
        humanCheck: HUMAN,
        userId: thread.userId,
        artifactId: thread.artifactId,
        versionId: thread.versionId,
        target: { schema: 1, path: thread.path, anchor: { kind: "document" } },
        body: thread.body,
        now: now - (thread.agoMs ?? 0),
      },
    );
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
      contentDomain: env.CONTENT_DOMAIN,
      customDomains: customDomainsServing(env),
    });
    if (!issued.ok) return Response.json(issued, { status: 400 });
    return Response.json({ code: issued.value.code, sessionTag: issued.value.sessionTag });
  }

  // The owner's access change, through the same service the API, MCP and dashboard call.
  if (path === "/access") {
    const { ownerId, artifactId, removeReaders, addReaders, mode, region } = input as AccessInput;
    const result = await updateAccess(regionsFromEnv(env).get(region ?? "default").db, {
      userId: ownerId,
      artifactId,
      change: { removeReaders, addReaders, ...(mode ? { mode } : {}) },
      now,
    });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  // The owner's share links, through the same services the API, MCP and dashboard call. The
  // owner's plan must include them; tests grant it with a row in owner_plans.
  if (path === "/share-link") {
    const { ownerId, artifactId, label, expiresAt, password, revoke, region } =
      input as ShareLinkInput;
    const db = regionsFromEnv(env).get(region ?? "default").db;
    if (revoke) {
      const result = await revokeShareLink(db, {
        userId: ownerId,
        artifactId,
        linkId: revoke,
        now,
      });
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }
    const result = await createShareLink(db, {
      userId: ownerId,
      artifactId,
      label: label ?? "E2E",
      expiresAt: expiresAt ?? null,
      password,
      now,
    });
    if (!result.ok) return Response.json(result, { status: 400 });
    return Response.json({
      id: result.value.link.id,
      url: `${env.APP_ORIGIN}/s#${result.value.token}`,
      token: result.value.token,
    });
  }

  // The 15-minute maintenance run of the default region, as the jobs Worker runs it, at a moment
  // `offsetMs` from now: tests move time past a plan's grace (decision 0022) without waiting.
  if (path === "/maintenance") {
    const { offsetMs = 0 } = input as { offsetMs?: number };
    const result = await runMaintenance(
      regionsFromEnv(env).get("default").db,
      env.ARTIFACTS,
      now + offsetMs,
    );
    return Response.json(result);
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

  // The jobs Worker's content search indexing (decision 0012), run now: each waiting job.
  if (path === "/search-index") {
    const { results } = await env.DB.prepare(
      "select id from outbox where topic = 'search_index'",
    ).all<{ id: number }>();
    const outcomes = [];
    for (const { id } of results) {
      outcomes.push(await runJob(db, env.ARTIFACTS, { id, topic: "search_index" }, now));
    }
    return Response.json({ ran: outcomes.length, outcomes });
  }

  // The jobs Worker's comment notices, run now: the scan, then each job with the real notifier,
  // whose emails land where `/mail` reads them instead of Email Service.
  if (path === "/comment-notices") {
    const scheduled = await scheduleCommentNotices(db, now);
    const captured = {
      async send(message: { to: string }) {
        await env.ARTIFACTS.put(
          `${MAIL_PREFIX}${message.to.toLowerCase()}`,
          JSON.stringify(message),
        );
        return { messageId: crypto.randomUUID() };
      },
    } as unknown as SendEmail;
    const commentNotifier = commentNotifierFromEnv({
      EMAIL: captured,
      APP_ORIGIN: env.APP_ORIGIN,
      CONTENT_DOMAIN: env.CONTENT_DOMAIN,
      UNSUBSCRIBE_SECRET: env.UNSUBSCRIBE_SECRET,
    });
    const { results } = await env.DB.prepare(
      "select id from outbox where topic = 'comment_notice'",
    ).all<{ id: number }>();
    for (const { id } of results) {
      await runJob(db, env.ARTIFACTS, { id, topic: "comment_notice" }, now, { commentNotifier });
    }
    return Response.json({ scheduled: scheduled.recipients, ran: results.length });
  }

  // The jobs Worker's webhook deliveries, run now with its real deps, except the network: requests
  // to RECEIVER_HOST land in the local bucket (the receiver answers 200), anything else fails.
  if (path === "/webhooks") {
    const receive = async (url: string, init: RequestInit) => {
      if (new URL(url).hostname !== RECEIVER_HOST) throw new TypeError("not the e2e receiver");
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      await env.ARTIFACTS.put(
        `${WEBHOOK_PREFIX}${Date.now()}-${crypto.randomUUID()}`,
        JSON.stringify({ url, headers, body: String(init.body) }),
      );
      return new Response("ok");
    };
    const webhooks = await webhookDepsFromEnv(env, receive);
    const { results } = await env.DB.prepare(
      "select id from outbox where topic = 'webhook_delivery' and available_at <= ?",
    )
      .bind(now)
      .all<{ id: number }>();
    for (const { id } of results) {
      await runJob(db, env.ARTIFACTS, { id, topic: "webhook_delivery" }, now, { webhooks });
    }
    const listed = await env.ARTIFACTS.list({ prefix: WEBHOOK_PREFIX });
    const received = [];
    for (const object of listed.objects.sort((a, b) => a.key.localeCompare(b.key))) {
      received.push(await (await env.ARTIFACTS.get(object.key))?.json());
    }
    return Response.json({ ran: results.length, received });
  }

  // The jobs Worker's audit stream deliveries (decision 0019), run with its real deps `laterMs`
  // from now and no settle window, except the network: requests to
  // COLLECTOR_HOST land in the local bucket (the collector answers 200), anything else fails.
  if (path === "/audit-streams") {
    const { laterMs = 0 } = input as { laterMs?: number };
    const at = now + laterMs;
    const receive = async (target: string, init: RequestInit) => {
      if (new URL(target).hostname !== COLLECTOR_HOST) throw new TypeError("not the collector");
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      await env.ARTIFACTS.put(
        `${COLLECTOR_PREFIX}${Date.now()}-${crypto.randomUUID()}`,
        JSON.stringify({ url: target, headers, body: String(init.body) }),
      );
      return new Response("ok");
    };
    // Events are sent once the database recorded them two minutes ago; the stack cannot wait.
    const auditStreams = auditStreamDepsFromWebhooks(await webhookDepsFromEnv(env, receive), 0);
    const { results } = await env.DB.prepare(
      "select id from outbox where topic = 'audit_stream' and available_at <= ?",
    )
      .bind(at)
      .all<{ id: number }>();
    for (const { id } of results) {
      await runJob(db, env.ARTIFACTS, { id, topic: "audit_stream" }, at, { auditStreams });
    }
    const listed = await env.ARTIFACTS.list({ prefix: COLLECTOR_PREFIX });
    const received = [];
    for (const object of listed.objects.sort((a, b) => a.key.localeCompare(b.key))) {
      received.push(await (await env.ARTIFACTS.get(object.key))?.json());
    }
    return Response.json({ ran: results.length, received });
  }

  // The jobs Worker's issues from threads (decision 0018), run now with its real deps against the
  // fake GitHub and Linear; answers what the fakes received.
  if (path === "/issues") {
    const issues = await issueDepsFromEnv(env, e2eTrackers.fetch);
    const { results } = await env.DB.prepare(
      "select id from outbox where topic = 'thread_issue' and available_at <= ?",
    )
      .bind(now)
      .all<{ id: number }>();
    for (const { id } of results) {
      await runJob(db, env.ARTIFACTS, { id, topic: "thread_issue" }, now, { issues });
    }
    return Response.json({ ran: results.length, issues: e2eTrackers.issues });
  }

  // Single sign-on: who signs in at the fake identity provider next (decision 0016).
  if (path === "/sso-identity") {
    const { sub, email, name } = input as { sub: string; email: string; name?: string };
    setNextIdentity({ sub, email, ...(name ? { name } : {}) });
    return Response.json({ ok: true });
  }

  // Custom domains: what DNS holds and what Cloudflare reports, as a customer and Cloudflare would.
  if (path === "/domains") {
    const { txt, activate, attach } = input as {
      txt?: { name: string; value: string };
      activate?: string;
      /** An active domain as the jobs leave it, without going through the dashboard. */
      attach?: { hostname: string; artifactId: string };
    };
    if (txt) e2eDomains.publishTxt(txt.name, txt.value);
    if (activate) e2eDomains.activate(activate);
    if (attach) {
      const now = Date.now();
      const inserted = await env.DB.prepare(
        `INSERT INTO custom_domains (hostname, owner_id, artifact_id, region, state, token, verified_at, checked_at)
         SELECT ?, owner_id, id, 'default', 'active', ?, ?, ? FROM artifacts WHERE id = ?`,
      )
        .bind(attach.hostname, "e".repeat(32), now, now, attach.artifactId)
        .run();
      if (inserted.meta.changes !== 1) return new Response("Not found", { status: 404 });
      await env.DB.prepare("UPDATE artifacts SET custom_host = ? WHERE id = ?")
        .bind(attach.hostname, attach.artifactId)
        .run();
    }
    return Response.json({ ok: true });
  }

  // A workspace as the operator tool creates it (`workspace-create`, then `set-plan`), with any
  // other members inserted as the services' tests do. Test-only: no product surface creates one.
  if (path === "/workspace") {
    const { slug, name, adminUserId, seats = 10, members = [] } = input as WorkspaceInput;
    const created = await createWorkspace(db.global, { slug, name, adminUserId, now });
    if (!created.ok) return Response.json(created, { status: 400 });
    for (const member of members) {
      await db.insert(schema.workspaceMembers).values({
        workspaceId: created.value.id,
        userId: member.userId,
        role: member.role,
        updatedAt: now,
      });
    }
    await db.insert(schema.ownerPlans).values({
      ownerId: created.value.id,
      plan: "team",
      seats,
      grantedBy: "e2e",
      updatedAt: now,
    });
    return Response.json({ id: created.value.id, slug, name });
  }

  // The operator tool, as `bun run --cwd apps/jobs operator` runs it against the deployment's
  // databases (workspace-create --region, set-plan, workspace-delete; docs/operations.md).
  if (path === "/operator") {
    const { argv } = input as { argv: string[] };
    const result = await runOperator(regionsFromEnv(env), argv, now, undefined, e2eDomains);
    return Response.json(result, { status: result.exitCode === 0 ? 200 : 400 });
  }

  // The jobs Worker's queue consumer, run now on every row waiting in each region's outbox, as
  // the relay would send them (`JobMessage.region`): purges, deletions, erasures. Notices land
  // where `/mail` reads them. Repeats while a round finished something, at most five rounds.
  if (path === "/jobs") {
    const { topics } = input as { topics?: string[] };
    const captured = {
      async send(message: { to: string }) {
        await env.ARTIFACTS.put(
          `${MAIL_PREFIX}${message.to.toLowerCase()}`,
          JSON.stringify(message),
        );
        return { messageId: crypto.randomUUID() };
      },
    } as unknown as SendEmail;
    const jobsEnv = { ...env, EMAIL: captured } as unknown as JobsEnv;
    const ran: { region: Region; topic: string; acked: boolean }[] = [];
    for (let round = 0; round < 5; round += 1) {
      const before = ran.length;
      for (const handles of regionsFromEnv(env).all()) {
        const { results } = await regionBindings(env, handles.region)
          .db.prepare("select id, topic from outbox order by id")
          .all<{ id: number; topic: string }>();
        const due = results.filter(
          (row: { id: number; topic: string }) => !topics || topics.includes(row.topic),
        );
        for (const row of due) {
          let acked = false;
          const body: JobMessage = {
            id: row.id,
            topic: row.topic as JobMessage["topic"],
            ...(handles.region === "default" ? {} : { region: handles.region }),
          };
          const message = {
            id: `e2e-${row.id}`,
            timestamp: new Date(now),
            attempts: 1,
            body,
            ack: () => {
              acked = true;
            },
            retry: () => {},
          };
          const batch = {
            queue: "portifact-jobs",
            messages: [message],
            ackAll: () => {},
            retryAll: () => {},
          } as unknown as MessageBatch<unknown>;
          await runQueue(batch, jobsEnv, now, e2eDomains);
          ran.push({ region: handles.region, topic: row.topic, acked });
        }
      }
      if (!ran.slice(before).some((job) => job.acked)) break;
    }
    return Response.json({ ran });
  }

  // Where an owner's rows and objects are (decision 0005, E5.8): counts per region's control
  // database, access log database and bucket, and in the global tables, for an owner and its
  // artifacts. Raw reads, so a row in the wrong database is seen, not refused by the guard.
  if (path === "/where") {
    const {
      ownerId,
      artifactIds = [],
      actorIds = [],
    } = input as { ownerId: string; artifactIds?: string[]; actorIds?: string[] };
    const actors = JSON.stringify(actorIds);
    const ids = JSON.stringify(artifactIds);
    const count = async (database: D1Database, query: string, ...params: string[]) =>
      (
        await database
          .prepare(query)
          .bind(...params)
          .first<{ n: number }>()
      )?.n ?? 0;
    const regional = async (region: Region) => {
      const { db: d, access, bucket } = regionBindings(env, region);
      const listed = await bucket.list({ prefix: `objects/${ownerId}/` });
      return {
        artifacts: await count(
          d,
          "select count(*) as n from artifacts where id in (select value from json_each(?)) or owner_id = ?",
          ids,
          ownerId,
        ),
        versions: await count(
          d,
          "select count(*) as n from versions where artifact_id in (select value from json_each(?))",
          ids,
        ),
        versionFiles: await count(
          d,
          "select count(*) as n from version_files where owner_id = ?",
          ownerId,
        ),
        objects: await count(d, "select count(*) as n from objects where owner_id = ?", ownerId),
        usage: await count(
          d,
          "select count(*) as n from account_usage where owner_id = ?",
          ownerId,
        ),
        threads: await count(
          d,
          "select count(*) as n from annotation_threads where owner_id = ?",
          ownerId,
        ),
        messages: await count(
          d,
          "select count(*) as n from annotation_messages where owner_id = ?",
          ownerId,
        ),
        shareLinks: await count(
          d,
          "select count(*) as n from share_links where artifact_id in (select value from json_each(?))",
          ids,
        ),
        accessEvents: await count(
          access,
          "select count(*) as n from access_events where artifact_id in (select value from json_each(?)) or owner_id = ?",
          ids,
          ownerId,
        ),
        // Idempotency records of the people who acted: they hold responses (decision 0005).
        operations: await count(
          d,
          "select count(*) as n from operations where actor_id in (select value from json_each(?))",
          actors,
        ),
        traffic: await count(
          d,
          "select count(*) as n from traffic_counters where owner_id = ?",
          ownerId,
        ),
        views: await count(
          access,
          "select count(*) as n from artifact_views where artifact_id in (select value from json_each(?)) or owner_id = ?",
          ids,
          ownerId,
        ),
        r2Objects: listed.objects.length,
      };
    };
    const global = env.DB;
    return Response.json({
      default: await regional("default"),
      eu: await regional("eu"),
      global: {
        directory: (
          await global
            .prepare(
              "select id, region from artifact_directory where id in (select value from json_each(?)) order by id",
            )
            .bind(ids)
            .all<{ id: string; region: string }>()
        ).results,
        workspaces: await count(
          global,
          "select count(*) as n from workspaces where id = ?",
          ownerId,
        ),
        members: await count(
          global,
          "select count(*) as n from workspace_members where workspace_id = ?",
          ownerId,
        ),
        plans: await count(
          global,
          "select count(*) as n from owner_plans where owner_id = ?",
          ownerId,
        ),
        tombstones: (
          await global
            .prepare(
              "select id, kind from tombstones where id = ? or id in (select value from json_each(?)) order by id",
            )
            .bind(ownerId, ids)
            .all<{ id: string; kind: string }>()
        ).results,
      },
      // A global table's copy in the EU database stays empty (decision 0005, section 1).
      euGlobalCopies: {
        workspaces: await count(
          regionBindings(env, "eu").db,
          "select count(*) as n from workspaces",
        ),
        directory: await count(
          regionBindings(env, "eu").db,
          "select count(*) as n from artifact_directory",
        ),
        tombstones: await count(
          regionBindings(env, "eu").db,
          "select count(*) as n from tombstones",
        ),
      },
    });
  }

  if (path === "/sql") {
    const { query, params = [], database, region } = input as SqlInput;
    const raw = regionBindings(env, region);
    const target = database === "access" ? raw.access : raw.db;
    const { results } = await target
      .prepare(query)
      .bind(...params)
      .all();
    return Response.json(results);
  }

  return new Response("Not found", { status: 404 });
}
