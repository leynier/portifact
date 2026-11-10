// Issue integrations through the app Worker (decision 0018): connections answer only the
// dashboard's session (every bearer token refused, the CLI's `credentials:manage` included),
// the read and issue routes take their scopes, the API and MCP give the same bodies and errors,
// and without the switch nothing is offered. GitHub and Linear are FakeIssueTrackers.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { FakeIssueTrackers } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken, rawCall } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-02T09:00:00Z");
const TOKEN = "github_pat_app_suite_0123456789abcdefghijklmnop";
const SCOPES =
  "artifacts:read artifacts:write annotations:read annotations:write annotations:moderate offline_access";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const db = () => regionsFromEnv(env).get("default").db;

function fakes() {
  return new FakeIssueTrackers().github(TOKEN, "octo-bot", ["acme/site"]);
}

async function onTeam(ownerId: string) {
  await db()
    .global.insert(schema.ownerPlans)
    .values({ ownerId, plan: "team", seats: 1, grantedBy: "test", updatedAt: NOW })
    .onConflictDoUpdate({ target: schema.ownerPlans.ownerId, set: { plan: "team" } });
}

/** The dashboard's session for `email`: cookie, same-origin fetch metadata and the app origin. */
async function sessionOf(h: Harness, email: string) {
  const cookie = await h.signIn(email);
  return (path: string, init: RequestInit = {}) =>
    h.request(path, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        cookie,
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
      },
    });
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const CONNECT = { service: "github", label: "Repo", credential: TOKEN, targets: ["acme/site"] };

async function userIdOf(h: Harness, token: string) {
  return (await (await api(h, token, "/api/v1/me")).json<{ userId: string }>()).userId;
}

/** A document of `ownerId` with a thread the owner started, written as the routes write them. */
async function artifactWithThread(ownerId: string) {
  const id = Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32],
  ).join("");
  const version = `ver_${crypto.randomUUID()}`;
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId,
      type: "site",
      name: "Plan",
      state: "active",
      annotations: "open",
      accessMode: "restricted",
      expiresAt: NOW + 86_400_000,
      createdAt: NOW,
      updatedAt: NOW,
    });
  await db().insert(schema.versions).values({
    id: version,
    artifactId: id,
    number: 1,
    authorId: ownerId,
    state: "committed",
    entrypoint: "index.html",
    publishedBytes: 10,
    committedAt: NOW,
  });
  await db()
    .update(schema.artifacts)
    .set({ currentVersionId: version })
    .where(eq(schema.artifacts.id, id));
  const threadId = crypto.randomUUID();
  const target = JSON.stringify({ schema: 1, path: "index.html", anchor: { kind: "document" } });
  await db().insert(schema.annotationThreads).values({
    id: threadId,
    artifactId: id,
    versionId: version,
    ownerId,
    authorId: ownerId,
    target,
    targetBytes: target.length,
    path: "index.html",
    updatedAt: NOW,
  });
  return { id, threadId };
}

describe("connections through the dashboard session", () => {
  it("connects, lists, tests, changes and removes; never returns the credential", async () => {
    const fake = fakes();
    const h = createHarness({ integrationFetch: fake.fetch });
    const email = "integrations-admin@example.test";
    const session = await sessionOf(h, email);
    const userId = await userIdOf(h, await apiToken(h, email));
    await onTeam(userId);

    const created = await session("/api/v1/integrations/connections", json("POST", CONNECT));
    expect(created.status).toBe(201);
    const connection = await created.json<{ id: string; credentialHint: string }>();
    expect(connection).toMatchObject({
      identity: "octo-bot",
      credentialHint: `…${TOKEN.slice(-4)}`,
    });
    const listed = await (await session("/api/v1/integrations/connections")).json<unknown>();
    expect(listed).toMatchObject({
      connections: [{ id: connection.id, label: "Repo" }],
      available: true,
      serviceAvailable: true,
      limit: 5,
    });
    for (const body of [connection, listed])
      expect(JSON.stringify(body)).not.toContain(TOKEN.slice(0, 20));
    expect(
      await (
        await session(`/api/v1/integrations/connections/${connection.id}/test`, json("POST"))
      ).json(),
    ).toMatchObject({ ok: true, identity: "octo-bot", problem: null });
    expect(
      await (
        await session(
          `/api/v1/integrations/connections/${connection.id}`,
          json("PATCH", { label: "Renamed" }),
        )
      ).json(),
    ).toMatchObject({ label: "Renamed" });
    // A wrong token is refused in plain words, with nothing stored.
    const refused = await session(
      "/api/v1/integrations/connections",
      json("POST", { ...CONNECT, credential: `${TOKEN}x` }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: {
        code: "invalid_input",
        message: "GitHub refused the token: it is wrong, expired or revoked.",
      },
    });
    const removed = await session(
      `/api/v1/integrations/connections/${connection.id}`,
      json("DELETE"),
    );
    expect(await removed.json()).toEqual({ connectionId: connection.id, removed: true });
    // An ID that is not well formed answers like a missing connection.
    expect((await session("/api/v1/integrations/connections/nope", json("DELETE"))).status).toBe(
      404,
    );
  });

  it("refuses every bearer token, the CLI's credentials:manage one included, and cross-origin requests", async () => {
    const h = createHarness({ integrationFetch: fakes().fetch });
    const email = "integrations-bearer@example.test";
    const cli = await apiToken(h, email, "artifacts:read credentials:manage");
    const product = await apiToken(h, email, SCOPES);
    for (const token of [cli, product]) {
      for (const [path, init] of [
        ["/api/v1/integrations/connections", json("GET")],
        ["/api/v1/integrations/connections", json("POST", CONNECT)],
        [`/api/v1/integrations/connections/ic_${"0".repeat(32)}`, json("DELETE")],
      ] as const) {
        const response = await api(h, token, path, init);
        expect(response.status, path).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
      }
    }
    const cookie = await h.signIn(email);
    const crossSite = await h.request("/api/v1/integrations/connections", {
      ...json("POST", CONNECT),
      headers: {
        "content-type": "application/json",
        cookie,
        "sec-fetch-site": "cross-site",
        origin: "https://evil.test",
      },
    });
    expect(crossSite.status).toBe(403);
    expect((await h.request("/api/v1/integrations/connections")).status).toBe(401);
  });

  it("offers nothing while switched off", async () => {
    const h = createHarness({
      integrationFetch: fakes().fetch,
      env: { INTEGRATIONS_ENABLED: undefined },
    });
    const email = "integrations-off@example.test";
    const session = await sessionOf(h, email);
    const token = await apiToken(h, email, SCOPES);
    await onTeam(await userIdOf(h, token));
    const created = await session("/api/v1/integrations/connections", json("POST", CONNECT));
    expect(created.status).toBe(503);
    expect(await created.json()).toEqual({
      error: { code: "capacity_unavailable", message: "Integrations are not available yet." },
    });
    expect(await (await api(h, token, "/api/v1/integrations")).json()).toMatchObject({
      connections: [],
      serviceAvailable: false,
    });
    const keyless = createHarness({ env: { INTEGRATIONS_KEY: undefined } });
    const keylessSession = await sessionOf(keyless, "integrations-keyless@example.test");
    expect(
      (await keylessSession("/api/v1/integrations/connections", json("POST", CONNECT))).status,
    ).toBe(503);
  });
});

describe("API and MCP parity for issue integrations", () => {
  it("lists choices and asks for an issue with the same bodies and errors", async () => {
    const fake = fakes();
    const h = createHarness({ integrationFetch: fake.fetch });
    const email = "integrations-parity@example.test";
    const token = await apiToken(h, email, SCOPES);
    const mcp = await connect(h, await mcpToken(h, email, SCOPES));
    const userId = await userIdOf(h, token);
    await onTeam(userId);
    const session = await sessionOf(h, email);
    const connection = await (
      await session("/api/v1/integrations/connections", json("POST", CONNECT))
    ).json<{ id: string }>();

    const listed = await callTool(mcp, "list_integrations", {});
    const viaApi = await (await api(h, token, "/api/v1/integrations")).json<unknown>();
    expect(listed.structuredContent).toEqual(viaApi);
    expect(viaApi).toEqual({
      connections: [
        {
          id: connection.id,
          service: "github",
          label: "Repo",
          targets: [{ id: "acme/site", name: "acme/site" }],
          usable: true,
        },
      ],
      available: true,
      serviceAvailable: true,
      euResidency: false,
    });
    expect(JSON.stringify(viaApi)).not.toContain("octo-bot");

    const { id, threadId } = await artifactWithThread(userId);
    const body = { connectionId: connection.id, target: "acme/site", title: "Fix it" };
    const path = `/api/v1/artifacts/${id}/annotations/threads/${threadId}/issue`;
    const key = crypto.randomUUID();
    const asked = await api(h, token, path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });
    expect(asked.status).toBe(202);
    const issue = await asked.json<{ id: string; state: string }>();
    expect(issue).toMatchObject({
      state: "pending",
      service: "github",
      target: "acme/site",
      key: null,
      url: null,
    });
    // The same key is the same request.
    const again = await api(h, token, path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });
    expect((await again.json<{ id: string }>()).id).toBe(issue.id);
    const tool = await callTool(mcp, "create_issue_from_thread", {
      artifactId: id,
      threadId,
      ...body,
      idempotencyKey: key,
    });
    expect(tool.structuredContent).toEqual(issue);

    // Errors: the same body through both.
    for (const wrong of [
      { ...body, target: "acme/other" },
      { ...body, connectionId: `ic_${"0".repeat(32)}` },
    ]) {
      const viaRoute = await api(h, token, path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(wrong),
      });
      const viaTool = await callTool(mcp, "create_issue_from_thread", {
        artifactId: id,
        threadId,
        ...wrong,
      });
      expect(viaTool.isError).toBe(true);
      expect(viaTool.structuredContent).toEqual(await viaRoute.json());
    }
    // The route needs its key.
    const keyless = await api(h, token, path, json("POST", body));
    expect(keyless.status).toBe(400);
    // Nothing is sent from the request: only the jobs Worker calls GitHub.
    expect(fake.issues).toHaveLength(0);
  });

  it("needs annotations:moderate to ask for an issue, and artifacts:read to list", async () => {
    const h = createHarness();
    const email = "integrations-scopes@example.test";
    const writer = await mcpToken(h, email, "annotations:read annotations:write");
    const denied = await rawCall(h, writer, "create_issue_from_thread", {
      artifactId: "abcdefghij",
      threadId: "t",
      connectionId: `ic_${"0".repeat(32)}`,
      target: "a/b",
      title: "x",
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain('scope="annotations:moderate"');
    const reader = await apiToken(h, email, "annotations:read");
    const refused = await api(
      h,
      reader,
      "/api/v1/artifacts/abcdefghij/annotations/threads/t/issue",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ connectionId: `ic_${"0".repeat(32)}`, target: "a/b", title: "x" }),
      },
    );
    expect(refused.status).toBe(403);
    const noRead = await mcpToken(h, email, "artifacts:write");
    expect((await rawCall(h, noRead, "list_integrations", {})).status).toBe(403);
    // No MCP tool manages connections.
    const all = await connect(h, await mcpToken(h, email, SCOPES));
    for (const name of ["create_integration", "remove_integration", "test_integration"]) {
      await expect(callTool(all, name, {}), name).rejects.toThrow(`Tool ${name} not found`);
    }
  });
});

describe("refusals through every route and tool", () => {
  async function team(h: Harness) {
    const adminEmail = `int-admin-${crypto.randomUUID()}@example.test`;
    const memberEmail = `int-member-${crypto.randomUUID()}@example.test`;
    const adminToken = await apiToken(h, adminEmail, SCOPES);
    const memberToken = await apiToken(h, memberEmail, SCOPES);
    const adminId = await userIdOf(h, adminToken);
    const memberId = await userIdOf(h, memberToken);
    const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    const slug = id.slice(3, 23);
    await db()
      .global.insert(schema.workspaces)
      .values({ id, slug, name: "Team", createdBy: adminId, updatedAt: NOW });
    await db()
      .global.insert(schema.workspaceMembers)
      .values([
        { workspaceId: id, userId: adminId, role: "admin", updatedAt: NOW },
        { workspaceId: id, userId: memberId, role: "editor", updatedAt: NOW },
      ]);
    await onTeam(id);
    return { slug, adminEmail, memberEmail, adminToken, memberToken };
  }

  it("answers bad or foreign spaces, roles, bodies and IDs the same way the services decide", async () => {
    const fake = fakes();
    const h = createHarness({ integrationFetch: fake.fetch });
    const t = await team(h);
    const admin = await sessionOf(h, t.adminEmail);
    const editor = await sessionOf(h, t.memberEmail);
    const missing = `ic_${"9".repeat(32)}`;
    const base = "/api/v1/integrations/connections";
    const status = async (response: Promise<Response>) => (await response).status;

    // The read route: a malformed slug, a workspace the caller is not in.
    expect(
      await status(api(h, t.adminToken, "/api/v1/integrations?workspace=Not%20A%20Slug!")),
    ).toBe(404);
    expect(await status(api(h, t.adminToken, "/api/v1/integrations?workspace=nosuchspace"))).toBe(
      404,
    );
    // Session routes.
    expect(await status(admin(`${base}?workspace=Not%20A%20Slug!`))).toBe(404);
    expect(await status(admin(`${base}?workspace=nosuchspace`))).toBe(404);
    expect(await status(editor(`${base}?workspace=${t.slug}`))).toBe(403);
    expect(
      await status(admin(`${base}?workspace=${t.slug}`, json("POST", { service: "github" }))),
    ).toBe(400);
    expect(await status(admin(`${base}?workspace=nosuchspace`, json("POST", CONNECT)))).toBe(404);
    expect(await status(editor(`${base}?workspace=${t.slug}`, json("POST", CONNECT)))).toBe(403);
    const created = await (await admin(`${base}?workspace=${t.slug}`, json("POST", CONNECT))).json<{
      id: string;
    }>();
    for (const [method, suffix, body] of [
      ["PATCH", "", { label: "X" }],
      ["POST", "/test", undefined],
      ["DELETE", "", undefined],
    ] as const) {
      expect(
        await status(admin(`${base}/nope${suffix}?workspace=${t.slug}`, json(method, body))),
        method,
      ).toBe(404);
      expect(
        await status(admin(`${base}/${missing}${suffix}?workspace=${t.slug}`, json(method, body))),
        method,
      ).toBe(404);
      expect(
        await status(
          admin(`${base}/${created.id}${suffix}?workspace=nosuchspace`, json(method, body)),
        ),
        method,
      ).toBe(404);
    }
    expect(
      await status(admin(`${base}/${created.id}?workspace=${t.slug}`, json("PATCH", {}))),
    ).toBe(400);
    expect(
      await status(
        admin(`${base}/${created.id}?workspace=${t.slug}`, json("PATCH", { label: "Renamed" })),
      ),
    ).toBe(200);
    expect(
      await status(admin(`${base}/${created.id}/test?workspace=${t.slug}`, json("POST"))),
    ).toBe(200);
    // A session whose account is gone counts as none.
    const cookie = await h.signIn(`int-gone-${crypto.randomUUID()}@example.test`);
    const gone = await h.request(base, {
      headers: { cookie: `${cookie}x`, "sec-fetch-site": "same-origin", origin: ORIGIN },
    });
    expect(gone.status).toBe(401);
    // The issue route refuses a body that is not one.
    const issue = await api(
      h,
      t.adminToken,
      "/api/v1/artifacts/abcdefghij/annotations/threads/t/issue",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ target: "a/b" }),
      },
    );
    expect(issue.status).toBe(400);
  });

  it("lists through MCP with the same refusals, and says what is missing", async () => {
    const fake = fakes();
    const h = createHarness({ integrationFetch: fake.fetch });
    const t = await team(h);
    const admin = await sessionOf(h, t.adminEmail);
    await admin(
      `/api/v1/integrations/connections?workspace=${t.slug}`,
      json("POST", { ...CONNECT, targets: ["acme/site"] }),
    );
    await db()
      .update(schema.integrationConnections)
      .set({
        attention: "credential_rejected",
        targets: JSON.stringify([{ id: "a/b", name: "Renamed repo" }]),
      });
    const tool = await connect(h, await mcpToken(h, t.adminEmail, SCOPES));
    const listed = await callTool(tool, "list_integrations", { workspace: t.slug });
    expect(
      String(listed.content?.[0] && "text" in listed.content[0] ? listed.content[0].text : ""),
    ).toContain("(needs an admin)");
    for (const workspace of ["Not A Slug!", "nosuchspace"]) {
      const refused = await callTool(tool, "list_integrations", { workspace });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ error: { code: "not_found" } });
    }
    const memberTool = await connect(
      h,
      await mcpToken(h, `int-outsider-${crypto.randomUUID()}@example.test`, SCOPES),
    );
    const empty = await callTool(memberTool, "list_integrations", {});
    expect(empty.structuredContent).toMatchObject({ connections: [], available: false });
    const off = createHarness({ env: { INTEGRATIONS_ENABLED: undefined } });
    const offTool = await connect(
      off,
      await mcpToken(off, `int-off-${crypto.randomUUID()}@example.test`, SCOPES),
    );
    const offList = await callTool(offTool, "list_integrations", {});
    expect(JSON.stringify(offList.content)).toContain("does not offer integrations yet");
  });
});
