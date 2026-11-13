// The routes of the rest of the text delivery of edit suggestions (decision 0027): previews of
// one's own draft and of unsaved edits through POST .../previews, and POST .../draft/rebase. The
// services' rules are tested in packages/services/test/suggestion-delivery.test.ts.
import { env } from "cloudflare:workers";
import {
  DraftView,
  type EditOperation,
  Plan,
  PreviewResponse,
  RebasedDraft,
} from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { commitPublish, createWorkspace, preparePublish, saveDraft } from "@portifact/services";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { publishSite, type TokenClient, tokenClient } from "./api-client.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";

const db = () => regionsFromEnv(env).get("default").db;
const SCOPES = "artifacts:read artifacts:write annotations:read annotations:write offline_access";
const OPERATION: EditOperation = {
  kind: "text",
  target: {
    schema: 1,
    path: "index.html",
    anchor: {
      kind: "text",
      quote: { exact: "draft", prefix: "", suffix: "" },
      position: { start: 5, end: 10 },
    },
  },
  after: "final",
};

let h: Harness;
let owner: TokenClient;
let artifactId: string;
let versionId: string;
const base = () => `/api/v1/artifacts/${artifactId}`;

function session(path: string, body?: unknown, method = "POST", cookie = owner.cookie) {
  return h.request(path, {
    method,
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
  h = createHarness({ env: { SUGGESTIONS_ENABLED: "true" } });
  owner = await tokenClient(h, `delivery-${crypto.randomUUID()}@example.test`, SCOPES);
  artifactId = await publishSite(owner, "Plan draft");
  await db()
    .update(schema.artifacts)
    .set({ annotations: "open" })
    .where(eq(schema.artifacts.id, artifactId));
  const [row] = await db()
    .select({ v: schema.artifacts.currentVersionId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  versionId = row?.v ?? "";
});

describe("previews through POST .../previews", () => {
  it("previews an unsaved edit and one's own draft's plan", async () => {
    const unsaved = await session(`${base()}/previews`, {
      unsaved: { versionId, as: "suggestion", edit: { operations: [OPERATION] } },
    });
    expect(unsaved.status).toBe(200);
    expect(PreviewResponse.parse(await unsaved.json())).toMatchObject({ state: "ready" });

    const saved = await session(
      `${base()}/draft`,
      {
        baseVersionId: versionId,
        edit: { operations: [OPERATION] },
        baseRevision: null,
        baseIncarnation: null,
      },
      "PUT",
    );
    DraftView.parse(await saved.json());
    const plan = Plan.parse(await (await session(`${base()}/draft/plan`)).json());
    const preview = await session(`${base()}/previews`, { digest: plan.digest });
    expect(PreviewResponse.parse(await preview.json())).toMatchObject({ state: "ready" });
  });

  it("refuses a malformed unsaved edit, a body of both kinds and bearer tokens", async () => {
    const bad = await session(`${base()}/previews`, {
      unsaved: { versionId, as: "suggestion", edit: { operations: [] } },
    });
    expect(bad.status).toBe(400);
    const both = await session(`${base()}/previews`, {
      digest: "0".repeat(64),
      unsaved: { versionId, as: "suggestion", edit: {} },
    });
    expect(both.status).toBe(400);
    const bearer = await owner.call(`${base()}/previews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unsaved: { versionId, as: "draft", edit: {} } }),
    });
    expect(bearer.status).toBe(403);
  });
});

describe("POST .../draft/rebase", () => {
  it("rebases one's own draft from the session only", async () => {
    const saved = DraftView.parse(
      await (
        await session(
          `${base()}/draft`,
          {
            baseVersionId: versionId,
            edit: { operations: [OPERATION] },
            baseRevision: null,
            baseIncarnation: null,
          },
          "PUT",
        )
      ).json(),
    );
    const body = { baseRevision: saved.revision, baseIncarnation: saved.incarnation };
    const rebased = await session(`${base()}/draft/rebase`, body);
    expect(rebased.status).toBe(200);
    expect(RebasedDraft.parse(await rebased.json())).toEqual({ draft: saved, conflicts: [] });
    const stale = await session(`${base()}/draft/rebase`, { ...body, baseRevision: 9 });
    expect(stale.status).toBe(409);
    expect((await session(`${base()}/draft/rebase`, { baseRevision: 1 })).status).toBe(400);
    const bearer = await owner.call(`${base()}/draft/rebase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(bearer.status).toBe(403);
    const stranger = await h.signIn(`delivery-other-${crypto.randomUUID()}@example.test`);
    expect((await session(`${base()}/draft/rebase`, body, "POST", stranger)).status).toBe(404);
    const off = createHarness();
    const switchedOff = await off.request(`${base()}/draft/rebase`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(switchedOff.status).toBe(404);
  });

  it("answers capacity_unavailable without the region's bucket", async () => {
    const unbound = createHarness({
      env: {
        SUGGESTIONS_ENABLED: "true",
        ARTIFACTS: undefined,
      } as unknown as Partial<Cloudflare.Env>,
    });
    const response = await unbound.request(`${base()}/draft/rebase`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ baseRevision: 1, baseIncarnation: "AAAAAAAAAAAAAAAAAAAAAA" }),
    });
    expect(response.status).toBe(503);
  });
});

describe("GET /api/v1/account/export", () => {
  it("holds the account's drafts in every region", async () => {
    const regions = regionsFromEnv(env);
    const workspace = await createWorkspace(regions.global, {
      slug: `delivery-eu-${crypto.randomUUID().slice(0, 8)}`,
      name: "EU team",
      adminUserId: owner.userId,
      region: "eu",
      now: Date.now(),
    });
    if (!workspace.ok) throw new Error(workspace.message);
    const eu = regions.get("eu");
    const body = "# Notes\n\nSecond paragraph here.\n";
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const pending = await preparePublish(eu.db, {
      userId: owner.userId,
      targetOwnerId: workspace.value.id,
      type: "markdown",
      name: "EU notes",
      entrypoint: "index.md",
      baseVersionId: null,
      files: [
        {
          path: "index.md",
          kind: "published",
          sha256: digest,
          size: body.length,
          contentType: "text/markdown",
        },
      ],
      now: Date.now(),
    });
    if (!pending.ok) throw new Error(pending.message);
    await env.ARTIFACTS_EU.put(`objects/${workspace.value.id}/${digest}`, body);
    const published = await commitPublish(eu.db, env.ARTIFACTS_EU, {
      userId: owner.userId,
      sessionId: pending.value.sessionId,
      now: Date.now(),
    });
    if (!published.ok) throw new Error(published.message);
    await eu.db
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, published.value.artifactId));
    const page = "Notes Second paragraph here.";
    const at = page.indexOf("Second");
    const saved = await saveDraft(eu.db, {
      userId: owner.userId,
      artifactId: published.value.artifactId,
      now: Date.now(),
      baseVersionId: published.value.versionId,
      baseRevision: null,
      baseIncarnation: null,
      edit: {
        operations: [
          {
            kind: "text",
            target: {
              schema: 1,
              path: "index.md",
              anchor: {
                kind: "text",
                quote: { exact: "Second", prefix: "", suffix: "" },
                position: { start: at, end: at + 6 },
              },
            },
            after: "Next",
          },
        ],
      },
    });
    if (!saved.ok) throw new Error(saved.message);
    const exported = await session("/api/v1/account/export", undefined, "GET");
    expect(exported.status).toBe(200);
    const json = await exported.json<{ drafts: { artifactId: string }[] }>();
    expect(json.drafts).toEqual([
      expect.objectContaining({ artifactId: published.value.artifactId }),
    ]);
  });
});
