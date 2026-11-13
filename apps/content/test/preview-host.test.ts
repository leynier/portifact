// The preview origin of edit suggestions (decision 0027, "Previews"): `preview.portifact.dev` is
// answered before any artifact lookup, serves only a redeemed code's document from a frame, with
// exactly the preview headers, and sets, reads, charges and logs nothing.
import { env } from "cloudflare:test";
import { ArtifactId } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { previewKey } from "@portifact/services";
import { beforeEach, describe, expect, it } from "vitest";
import { artifactIdFromHost, handle } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const ID = "k7d2qm4xab";
const OWNER = "u_preview_owner";
const SESSION = "s_preview";
const THREAD = "th_preview";
const CODE = `${"A".repeat(42)}B`;
const OTHER_CODE = "C".repeat(43);
const HOST = "https://preview.portifact.dev";
const DOCUMENT = "<!doctype html><html><head></head><body><p>Built preview</p></body></html>";
const POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors https://app.portifact.com; sandbox";
const db = () => regionsFromEnv(env).get("default").db;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function code(value: string) {
  const r2Key = previewKey(NOW);
  await env.ARTIFACTS.put(r2Key, DOCUMENT);
  await db()
    .insert(schema.previewCodes)
    .values({
      codeSha256: await sha256(value),
      userId: OWNER,
      sessionId: SESSION,
      artifactId: ID,
      threadId: THREAD,
      r2Key,
      createdAt: NOW,
      expiresAt: NOW + 60_000,
    });
  return r2Key;
}

beforeEach(async () => {
  for (const table of [
    "preview_codes",
    "annotation_threads",
    "versions",
    "artifacts",
    "sessions",
    "users",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const at = new Date(NOW - 30 * DAY);
  await db().insert(schema.users).values({
    id: OWNER,
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
    createdAt: at,
    updatedAt: at,
  });
  await db()
    .insert(schema.sessions)
    .values({
      id: SESSION,
      token: "token-preview",
      userId: OWNER,
      expiresAt: new Date(NOW + 7 * DAY),
      createdAt: at,
      updatedAt: at,
    });
  await db()
    .insert(schema.artifacts)
    .values({
      id: ID,
      ownerId: OWNER,
      type: "markdown",
      name: "Plan",
      state: "active",
      accessMode: "restricted",
      annotations: "open",
      currentVersionId: "v1",
      expiresAt: NOW + 10 * DAY,
    });
  await db()
    .insert(schema.versions)
    .values({
      id: "v1",
      artifactId: ID,
      number: 1,
      authorId: OWNER,
      entrypoint: "index.md",
      publishedBytes: 10,
      state: "committed",
      createdAt: NOW - DAY,
    });
  const edit = JSON.stringify({ operations: [] });
  await db().insert(schema.annotationThreads).values({
    id: THREAD,
    artifactId: ID,
    versionId: "v1",
    ownerId: OWNER,
    authorId: OWNER,
    target: "{}",
    targetBytes: 2,
    path: "index.md",
    updatedAt: NOW,
    kind: "suggestion",
    suggestionState: "pending",
    suggestionRevision: 1,
    edit,
    editBytes: edit.length,
  });
});

const fromFrame = {
  "Sec-Fetch-Dest": "iframe",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
};

async function ask(path: string, init: RequestInit = {}, now = NOW, workerEnv = env) {
  const calls = { traffic: 0, openings: 0, views: 0 };
  const response = await handle(
    new Request(`${HOST}${path}`, { headers: fromFrame, ...init }),
    workerEnv,
    now,
    () => {
      calls.traffic++;
    },
    () => {
      calls.openings++;
    },
    () => {
      calls.views++;
    },
  );
  return { response, calls };
}

describe("the preview host", () => {
  it("is never an artifact origin", () => {
    expect(artifactIdFromHost("preview.portifact.dev", "portifact.dev")).toBeNull();
    expect(ArtifactId.safeParse("preview").success).toBe(false);
  });

  it("serves a redeemed code's document with exactly the preview headers, once", async () => {
    const key = await code(CODE);
    const { response, calls } = await ask(`/p/${CODE}`, {
      headers: {
        ...fromFrame,
        // Cookies a sibling planted on the shared domain: never read, cleared or set here.
        Cookie: Array.from({ length: 40 }, (_, i) => `planted${i}=x`).join("; "),
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DOCUMENT);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": POLICY,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-site",
    });
    expect(calls).toEqual({ traffic: 0, openings: 0, views: 0 });
    expect(await env.ARTIFACTS.get(key)).toBeNull();
    expect((await ask(`/p/${CODE}`)).response.status).toBe(404);
  });

  it("refuses anything but a frame's GET of /p/<code>, without spending the code", async () => {
    await code(CODE);
    const refusals = [
      await ask(`/p/${CODE}`, { headers: { "Sec-Fetch-Dest": "document" } }),
      await ask(`/p/${CODE}`, { headers: {} }),
      await ask(`/p/${CODE}?x=1`),
      await ask(`/p/${CODE}/x`),
      await ask("/"),
      await ask("/__portifact/bridge.js"),
      await ask(`/p/${CODE}`, { method: "POST" }),
      await ask(`/p/${CODE}`, { method: "HEAD" }),
    ];
    for (const { response, calls } of refusals) {
      expect(Object.fromEntries(response.headers)).toEqual({
        "content-type": "text/plain; charset=utf-8",
        "content-security-policy": POLICY,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        ...(response.status === 405 ? { allow: "GET" } : {}),
      });
      expect(calls).toEqual({ traffic: 0, openings: 0, views: 0 });
    }
    expect(refusals.map(({ response }) => response.status)).toEqual([
      404, 404, 404, 404, 404, 404, 405, 405,
    ]);
    expect(await refusals[0]?.response.text()).toBe("This preview has expired or was already used");
    // None of them spent it.
    const [row] = await db().select().from(schema.previewCodes);
    expect(row?.redeemedAt).toBeNull();
    expect((await ask(`/p/${CODE}`)).response.status).toBe(200);
  });

  it("refuses unknown and expired codes and ended sessions alike", async () => {
    await code(CODE);
    expect((await ask(`/p/${OTHER_CODE}`)).response.status).toBe(404);
    expect((await ask(`/p/${CODE}`, {}, NOW + 60_000)).response.status).toBe(404);

    await code(OTHER_CODE);
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(SESSION).run();
    expect((await ask(`/p/${OTHER_CODE}`)).response.status).toBe(404);
  });

  it("refuses a code whose suggestion was withdrawn", async () => {
    await code(CODE);
    await env.DB.prepare(
      "UPDATE annotation_threads SET suggestion_state = 'withdrawn', edit = NULL, edit_bytes = 0 WHERE id = ?",
    )
      .bind(THREAD)
      .run();
    expect((await ask(`/p/${CODE}`)).response.status).toBe(404);
  });

  it("is the preview host whatever custom domains say", async () => {
    await code(CODE);
    const on = { ...env, CUSTOM_DOMAINS_ENABLED: "true" };
    expect((await ask(`/p/${CODE}`, {}, NOW, on)).response.status).toBe(200);
  });
});
