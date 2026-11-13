// The adapters of edit suggestions (decision 0027): the /api/v1 routes behind
// `SUGGESTIONS_ENABLED`, session-only where a person decides in the viewer, the change list for
// people's tokens, and the same answers from the MCP tools. The services' rules are tested in
// packages/services; these tests prove the wiring, the boundaries and the parity.
import { env } from "cloudflare:workers";
import {
  AcceptanceStarted,
  ChangeItemList,
  ChangeItemView,
  DraftView,
  type EditOperation,
  Plan,
  SuggestionThreadView,
  SuggestionView,
} from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { publishSite, type TokenClient, tokenClient } from "./api-client.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { callTool, connect, mcpToken } from "./mcp-helpers.ts";

const db = () => regionsFromEnv(env).get("default").db;
const ON = { SUGGESTIONS_ENABLED: "true" };
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

const ENVELOPE = JSON.stringify({
  format: 1,
  status: "listed",
  reason: "spans_nodes",
  operation: { kind: "text", before: "Plan", after: "Final" },
  binding: {
    artifactId: "x",
    versionId: "v",
    path: "index.html",
    fileSha256: "a".repeat(64),
    renderer: "portifact-render@1",
    route: null,
    subject: "th",
    revision: 1,
  },
  people: { submitter: true, acceptor: true },
  location: { unresolved: true },
  context: null,
  destinations: [],
  destinationsKnown: false,
});

let h: Harness;
let owner: TokenClient;
let ownerEmail: string;
let artifactId: string;
let versionId: string;

/** A request from the dashboard's own pages with the session cookie. */
function session(
  path: string,
  cookie: string,
  init: { method?: string; body?: unknown; key?: string } = {},
) {
  return h.request(path, {
    method: init.method ?? "GET",
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.key ? { "idempotency-key": init.key } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const base = () => `/api/v1/artifacts/${artifactId}`;

async function submit(cookie = owner.cookie) {
  const response = await session(`${base()}/suggestions`, cookie, {
    method: "POST",
    key: crypto.randomUUID(),
    body: { versionId, edit: { operations: [OPERATION] }, body: "Better word" },
  });
  expect(response.status).toBe(201);
  return (await response.json<{ id: string }>()).id;
}

async function seedItem(): Promise<string> {
  const id = `chg_${artifactId}`;
  await db().insert(schema.changeItems).values({
    id,
    artifactId,
    ownerId: owner.userId,
    origin: "suggestion",
    versionId,
    path: "index.html",
    envelope: ENVELOPE,
    bytes: ENVELOPE.length,
    reason: "spans_nodes",
    createdBy: owner.userId,
    createdAt: Date.now(),
  });
  return id;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
  h = createHarness({ env: ON });
  ownerEmail = `sugg-owner-${crypto.randomUUID()}@example.test`;
  owner = await tokenClient(h, ownerEmail, SCOPES);
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

describe("suggestion routes", () => {
  it("submit, read, plan and accept a suggestion from the viewer's session", async () => {
    const threadId = await submit();
    const read = await owner.call(`${base()}/suggestions/${threadId}`);
    expect(read.status).toBe(200);
    expect(SuggestionView.parse(await read.json())).toMatchObject({
      state: "pending",
      revision: 1,
    });

    const thread = await session(
      `${base()}/annotations/threads/${threadId}?fields=suggestion`,
      owner.cookie,
    );
    expect(SuggestionThreadView.parse(await thread.json())).toMatchObject({
      kind: "suggestion",
      suggestion: { threadId, state: "pending" },
    });
    const plain = await (
      await session(`${base()}/annotations/threads/${threadId}`, owner.cookie)
    ).json<Record<string, unknown>>();
    expect(plain).not.toHaveProperty("kind");

    const planned = await session(`${base()}/suggestions/${threadId}/plan`, owner.cookie, {
      method: "POST",
    });
    expect(planned.status).toBe(200);
    const plan = Plan.parse(await planned.json());
    expect(plan.applied).toHaveLength(1);

    const key = crypto.randomUUID();
    const accept = () =>
      session(`${base()}/suggestions/${threadId}/accept`, owner.cookie, {
        method: "POST",
        key,
        body: { digest: plan.digest },
      });
    const first = await accept();
    expect(first.status).toBe(202);
    const started = AcceptanceStarted.parse(await first.json());
    const replay = await accept();
    expect(replay.status).toBe(202);
    expect(AcceptanceStarted.parse(await replay.json())).toEqual(started);
    const after = SuggestionView.parse(
      await (await owner.call(`${base()}/suggestions/${threadId}`)).json(),
    );
    expect(after.state).toBe("applying");
  });

  it("tells a changed plan apart with details.reason", async () => {
    const threadId = await submit();
    const response = await session(`${base()}/suggestions/${threadId}/accept`, owner.cookie, {
      method: "POST",
      key: crypto.randomUUID(),
      body: { digest: "0".repeat(64) },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "version_conflict", details: { reason: "plan_changed" } },
    });
  });

  it("withdraws and rejects at the revision the caller saw", async () => {
    const withdrawn = await submit();
    const stale = await session(`${base()}/suggestions/${withdrawn}/withdraw`, owner.cookie, {
      method: "POST",
      body: { revision: 7 },
    });
    expect(stale.status).toBe(409);
    const ok = await session(`${base()}/suggestions/${withdrawn}/withdraw`, owner.cookie, {
      method: "POST",
      body: { revision: 1 },
    });
    expect(SuggestionView.parse(await ok.json())).toMatchObject({ state: "withdrawn", edit: null });

    const rejected = await submit();
    const response = await session(`${base()}/suggestions/${rejected}/reject`, owner.cookie, {
      method: "POST",
      body: { revision: 1 },
    });
    expect(SuggestionView.parse(await response.json()).state).toBe("rejected");
  });

  it("refuse bearer tokens on the viewer's routes, and do not exist while switched off", async () => {
    const threadId = await submit();
    for (const [method, path] of [
      ["POST", `${base()}/suggestions`],
      ["POST", `${base()}/suggestions/${threadId}/plan`],
      ["POST", `${base()}/suggestions/${threadId}/accept`],
      ["POST", `${base()}/suggestions/${threadId}/reject`],
      ["POST", `${base()}/suggestions/${threadId}/withdraw`],
      ["GET", `${base()}/draft`],
      ["PUT", `${base()}/draft`],
      ["DELETE", `${base()}/draft`],
      ["POST", `${base()}/draft/plan`],
      ["POST", `${base()}/draft/publish`],
    ] as const) {
      const response = await owner.call(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    const off = createHarness();
    expect((await off.request(`${base()}/suggestions/${threadId}`)).status).toBe(404);
    const offRead = await off.request(`${base()}/changes`, {
      headers: { cookie: owner.cookie, "sec-fetch-site": "same-origin" },
    });
    expect(offRead.status).toBe(404);
  });

  it("answer another account like a missing artifact", async () => {
    const threadId = await submit();
    const stranger = await h.signIn(`sugg-stranger-${crypto.randomUUID()}@example.test`);
    const hidden = await session(`${base()}/suggestions/${threadId}/plan`, stranger, {
      method: "POST",
    });
    const missing = await session(
      `/api/v1/artifacts/zzzzzzzzzz/suggestions/${threadId}/plan`,
      stranger,
      { method: "POST" },
    );
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    expect((await session(`/api/v1/artifacts/NOT-AN-ID/suggestions/x`, stranger)).status).toBe(404);
  });
});

describe("the owner's draft routes", () => {
  it("save, read, plan and discard one's own draft", async () => {
    const saved = await session(`${base()}/draft`, owner.cookie, {
      method: "PUT",
      body: { baseVersionId: versionId, edit: { operations: [OPERATION] }, baseRevision: null },
    });
    expect(saved.status).toBe(200);
    expect(DraftView.parse(await saved.json())).toMatchObject({ revision: 1, publishing: false });
    const conflict = await session(`${base()}/draft`, owner.cookie, {
      method: "PUT",
      body: { baseVersionId: versionId, edit: { operations: [OPERATION] }, baseRevision: null },
    });
    expect(conflict.status).toBe(409);
    expect((await session(`${base()}/draft`, owner.cookie)).status).toBe(200);
    const planned = await session(`${base()}/draft/plan`, owner.cookie, { method: "POST" });
    expect(Plan.parse(await planned.json()).applied).toHaveLength(1);
    const gone = await session(`${base()}/draft`, owner.cookie, { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect((await session(`${base()}/draft`, owner.cookie)).status).toBe(404);
    const invalid = await session(`${base()}/draft`, owner.cookie, {
      method: "PUT",
      body: { baseVersionId: versionId, edit: { operations: [] }, baseRevision: null },
    });
    expect(invalid.status).toBe(400);
  });
});

describe("the change list, through the API and MCP alike", () => {
  it("lists, reads and marks items once per key, with the same bodies as the tools", async () => {
    const itemId = await seedItem();
    const listed = await owner.call(`${base()}/changes?state=open`);
    expect(listed.status).toBe(200);
    const list = ChangeItemList.parse(await listed.json());
    expect(list.items.map((item) => item.id)).toEqual([itemId]);
    expect((await owner.call(`${base()}/changes?state=nope`)).status).toBe(400);
    const one = await owner.call(`${base()}/changes/${itemId}`);
    expect(ChangeItemView.parse(await one.json()).id).toBe(itemId);

    const client = await connect(h, await mcpToken(h, ownerEmail, SCOPES));
    const tool = await callTool(client, "list_change_items", { artifactId, state: "open" });
    expect(tool.isError).not.toBe(true);
    expect(ChangeItemList.parse(tool.structuredContent)).toEqual(list);

    const mark = (key: string | null, state: string) =>
      owner.call(`${base()}/changes/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify({ state, baseRevision: 1 }),
      });
    expect((await mark(null, "applied")).status).toBe(400);
    const marked = await mark("mark-key-1", "applied");
    expect(marked.status).toBe(200);
    const body = ChangeItemView.parse(await marked.json());
    expect(body).toMatchObject({ state: "applied", revision: 2 });
    const replayed = await mark("mark-key-1", "applied");
    expect(ChangeItemView.parse(await replayed.json())).toEqual(body);
    expect((await mark("mark-key-1", "dismissed")).status).toBe(400);

    // The tool marks the same way: a stale revision is the API's conflict, a fresh one the body.
    const stale = await callTool(client, "mark_change_item", {
      artifactId,
      itemId,
      state: "dismissed",
      baseRevision: 1,
      idempotencyKey: "tool-key-1",
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({ error: { code: "version_conflict" } });
    const apiStale = await owner.call(`${base()}/changes/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": "mark-key-2" },
      body: JSON.stringify({ state: "dismissed", baseRevision: 1 }),
    });
    expect(await apiStale.json()).toEqual(stale.structuredContent);
    const fresh = await callTool(client, "mark_change_item", {
      artifactId,
      itemId,
      state: "open",
      baseRevision: 2,
      idempotencyKey: "tool-key-2",
    });
    const reopened = ChangeItemView.parse(fresh.structuredContent);
    expect(reopened).toMatchObject({ state: "open", revision: 3 });
    expect(
      ChangeItemView.parse(await (await owner.call(`${base()}/changes/${itemId}`)).json()),
    ).toEqual(reopened);
  });

  it("refuses another account and a token without the annotation scopes alike", async () => {
    const itemId = await seedItem();
    const strangerEmail = `sugg-other-${crypto.randomUUID()}@example.test`;
    const stranger = await tokenClient(h, strangerEmail, SCOPES);
    const viaApi = await stranger.call(`${base()}/changes`);
    expect(viaApi.status).toBe(404);
    const client = await connect(h, await mcpToken(h, strangerEmail, SCOPES));
    const viaTool = await callTool(client, "list_change_items", { artifactId });
    expect(viaTool.structuredContent).toEqual(await viaApi.json());
    const narrow = await tokenClient(h, ownerEmail);
    expect((await narrow.call(`${base()}/changes/${itemId}`)).status).toBe(403);
  });

  it("registers the tools only while suggestions are on, and no tool decides", async () => {
    const on = await connect(h, await mcpToken(h, ownerEmail, SCOPES));
    const names = (await on.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_change_items", "mark_change_item"]));
    expect(names.filter((name) => /suggest|accept|draft|reject|withdraw/.test(name))).toEqual([]);
    const off = createHarness();
    const offClient = await connect(off, await mcpToken(off, ownerEmail, SCOPES));
    const offNames = (await offClient.listTools()).tools.map((tool) => tool.name);
    expect(offNames).not.toContain("list_change_items");
  });
});
