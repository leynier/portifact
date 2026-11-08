// Seeding and inspection for the end-to-end tests, through the same services and tables the
// Workers use. Only the e2e Worker has these routes, on a host the browsers cannot reach.
import { TERMS_VERSION } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import {
  commitPublish,
  createAnnotationThread,
  issueReviewHandoff,
  preparePublish,
} from "@portifact/services";
import type { Env as AppEnv } from "../../apps/app/src/env.ts";
import type { Env as ContentEnv } from "../../apps/content/src/index.ts";

export const CONTROL_HOST = "control.e2e.test";
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
}

interface ThreadInput {
  userId: string;
  artifactId: string;
  versionId: string;
  body: string;
  path: string;
}

interface ReviewCodeInput {
  userId: string;
  sessionId: string;
  artifactId: string;
  kind?: "frame" | "tab";
}

interface SqlInput {
  query: string;
  params?: (string | number | null)[];
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

export async function control(request: Request, env: E2eEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/echo") return Response.json(Object.fromEntries(request.headers));
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
      baseVersionId: null,
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
    await env.DB.prepare(
      "UPDATE artifacts SET access_mode = ?, annotations = ?, policy_generation = policy_generation + 1 WHERE id = ?",
    )
      .bind(publish.accessMode ?? "restricted", publish.annotations ?? "open", artifactId)
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
      now,
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

  if (path === "/sql") {
    const { query, params = [] } = input as SqlInput;
    const { results } = await env.DB.prepare(query)
      .bind(...params)
      .all();
    return Response.json(results);
  }

  return new Response("Not found", { status: 404 });
}
