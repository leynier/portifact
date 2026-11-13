// The app's part of built previews (decision 0027, "Previews"): POST
// /api/v1/artifacts/:id/previews issues a one-use URL on the preview origin for a stored plan,
// behind `SUGGESTIONS_ENABLED`, for the dashboard's session only. The service's rules are in
// packages/services/test/suggestion-previews.test.ts; the host's in apps/content.
import { env } from "cloudflare:workers";
import { ANCHOR_SCHEMA_VERSION, PreviewResponse } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { buildPlan, planPageUrl } from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { publishSite, type TokenClient, tokenClient } from "./api-client.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";

const db = () => regionsFromEnv(env).get("default").db;
const ON = { SUGGESTIONS_ENABLED: "true" };

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A pending suggestion on the site `publishSite` made, and the owner's stored plan for it. */
async function seedPlan(owner: TokenClient, artifactId: string): Promise<string> {
  const source = "<h1>Plan draft</h1>";
  const [artifact] = await db()
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  const versionId = artifact?.currentVersionId ?? "";
  await db()
    .update(schema.artifacts)
    .set({ annotations: "open" })
    .where(eq(schema.artifacts.id, artifactId));
  const operation = {
    kind: "text" as const,
    target: {
      schema: ANCHOR_SCHEMA_VERSION,
      path: "index.html",
      anchor: {
        kind: "text" as const,
        quote: { exact: "draft", prefix: "", suffix: "" },
        position: { start: 5, end: 10 },
      },
    },
    after: "final",
  };
  const edit = JSON.stringify({ operations: [operation] });
  const threadId = `th_${crypto.randomUUID()}`;
  await db()
    .insert(schema.annotationThreads)
    .values({
      id: threadId,
      artifactId,
      versionId,
      ownerId: owner.userId,
      authorId: owner.userId,
      target: JSON.stringify(operation.target),
      targetBytes: JSON.stringify(operation.target).length,
      path: "index.html",
      updatedAt: Date.now(),
      kind: "suggestion",
      suggestionState: "pending",
      suggestionRevision: 1,
      edit,
      editBytes: edit.length,
    });
  const plan = await buildPlan({
    binding: {
      artifactId,
      versionId,
      path: "index.html",
      fileSha256: await sha256(source),
      renderer: DOCUMENT_RENDERER.label,
      subject: threadId,
      revision: 1,
    },
    people: { submitter: true, acceptor: true },
    kind: "html",
    source,
    operations: [operation],
    pageUrl: planPageUrl("html", artifactId, "portifact.dev", "index.html"),
    renderer: DOCUMENT_RENDERER,
  });
  expect(plan.output).not.toBeNull();
  const { newSource: _n, proofs: _p, work: _w, ...exported } = plan;
  await db()
    .insert(schema.suggestionPlans)
    .values({
      userId: owner.userId,
      digest: plan.digest,
      artifactId,
      threadId,
      plan: JSON.stringify(exported),
      expiresAt: Date.now() + 600_000,
    });
  return plan.digest;
}

function ask(h: Harness, artifactId: string, cookie: string, body: unknown, extra = {}) {
  return h.request(`/api/v1/artifacts/${artifactId}/previews`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

let h: Harness;
let owner: TokenClient;
let artifactId: string;
let digest: string;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
  h = createHarness({ env: ON });
  owner = await tokenClient(h, `preview-owner-${crypto.randomUUID()}@example.test`);
  artifactId = await publishSite(owner, "Plan draft");
  digest = await seedPlan(owner, artifactId);
});

describe("preview codes from the dashboard", () => {
  it("gives the owner a one-use URL on the preview origin, bound to the dashboard session", async () => {
    const response = await ask(h, artifactId, owner.cookie, { digest });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = PreviewResponse.parse(await response.json());
    if (body.state !== "ready") throw new Error("not ready");
    const url = new URL(body.url);
    expect(url.origin).toBe("https://preview.portifact.dev");
    expect(url.pathname).toMatch(/^\/p\/[A-Za-z0-9_-]{43}$/);
    const [row] = await db()
      .select()
      .from(schema.previewCodes)
      .where(eq(schema.previewCodes.artifactId, artifactId));
    const [session] = await db()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, owner.userId));
    expect(row?.sessionId).toBe(session?.id);
    expect(row?.userId).toBe(owner.userId);
  });

  it("does not exist while suggestions are switched off", async () => {
    const off = createHarness();
    const response = await ask(off, artifactId, owner.cookie, { digest });
    expect(response.status).toBe(404);
  });

  it("refuses bearer tokens, cross-origin requests and requests without a session", async () => {
    const bearer = await owner.call(`/api/v1/artifacts/${artifactId}/previews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digest }),
    });
    expect(bearer.status).toBe(403);
    expect((await ask(h, artifactId, "", { digest })).status).toBe(401);
    const sibling = await ask(
      h,
      artifactId,
      owner.cookie,
      { digest },
      {
        "sec-fetch-site": "cross-site",
        origin: `https://${artifactId}.portifact.dev`,
      },
    );
    expect(sibling.status).toBe(403);
    expect(
      (await db().select().from(schema.previewCodes)).filter((r) => r.artifactId === artifactId),
    ).toEqual([]);
  });

  it("answers another account, a malformed ID and a bad body without revealing anything", async () => {
    const stranger = await h.signIn(`preview-stranger-${crypto.randomUUID()}@example.test`);
    const forbidden = await ask(h, artifactId, stranger, { digest });
    const missing = await ask(h, "zzzzzzzzzz", stranger, { digest });
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await forbidden.json()).toEqual(await missing.json());
    expect((await ask(h, "NOT-AN-ID", owner.cookie, { digest })).status).toBe(404);
    expect((await ask(h, artifactId, owner.cookie, { digest: "x" })).status).toBe(400);
    expect((await ask(h, artifactId, owner.cookie, { digest, extra: 1 })).status).toBe(400);
  });
});
