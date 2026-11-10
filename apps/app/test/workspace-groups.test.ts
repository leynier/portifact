// Workspace groups through /api/v1, MCP and the dashboard's session (premium plan T3, decision
// 0014): management only through the session and only for admins, listing names and counts for
// the owner side with a bearer token or MCP, and groups in access with the same bodies in both.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { commitPublish, createWorkspace, preparePublish } from "@portifact/services";
import { FakeDomains } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken, type ToolResult } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-10T09:00:00Z");
const SCOPES =
  "artifacts:read artifacts:write artifacts:share artifacts:delete annotations:read offline_access";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const regions = () => regionsFromEnv(env);
const db = () => regions().get("default").db;

interface Client {
  userId: string;
  email: string;
  h: Harness;
  apiCall: (path: string, init?: RequestInit) => Promise<Response>;
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

async function client(email: string, dns: FakeDomains): Promise<Client> {
  const h = createHarness({ emailDomains: dns });
  const apiAccess = await apiToken(h, email, SCOPES);
  const mcp = await connect(h, await mcpToken(h, email, SCOPES));
  const apiCall = (path: string, init?: RequestInit) => api(h, apiAccess, path, init);
  const { userId } = await (await apiCall("/api/v1/me")).json<{ userId: string }>();
  return { userId, email, h, apiCall, tool: (name, args) => callTool(mcp, name, args) };
}

function dashboard(cookie: string, method = "GET", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function team(prefix: string, plan: "team" | null = "team") {
  const dns = new FakeDomains();
  const [admin, editor, member, outsider] = await Promise.all(
    ["admin", "editor", "member", "outsider"].map((role) =>
      client(`${prefix}-${role}@example.test`, dns),
    ),
  );
  const slug = `${prefix}-team`;
  const created = await createWorkspace(regions().global, {
    slug,
    name: "Team",
    adminUserId: (admin as Client).userId,
    now: NOW,
  });
  if (!created.ok) throw new Error(created.message);
  await db()
    .insert(schema.workspaceMembers)
    .values([
      {
        workspaceId: created.value.id,
        userId: (editor as Client).userId,
        role: "editor",
        updatedAt: NOW,
      },
      {
        workspaceId: created.value.id,
        userId: (member as Client).userId,
        role: "member",
        updatedAt: NOW,
      },
    ]);
  if (plan) {
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId: created.value.id, plan, seats: 10, grantedBy: "test", updatedAt: NOW });
  }
  return {
    id: created.value.id,
    slug,
    dns,
    admin: admin as Client,
    editor: editor as Client,
    member: member as Client,
    outsider: outsider as Client,
  };
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function publishIn(ownerId: string, userId: string): Promise<string> {
  const content = `# ${crypto.randomUUID()}`;
  const sha = await sha256(content);
  const prepared = await preparePublish(db(), {
    userId,
    targetOwnerId: ownerId,
    type: "markdown",
    name: "Doc",
    entrypoint: "index.md",
    baseVersionId: null,
    files: [
      {
        path: "index.md",
        kind: "published",
        sha256: sha,
        size: content.length,
        contentType: "text/markdown; charset=utf-8",
      },
    ],
    now: NOW,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  await env.ARTIFACTS.put(`objects/${ownerId}/${sha}`, content, { sha256: sha });
  const committed = await commitPublish(db(), env.ARTIFACTS, {
    userId,
    sessionId: prepared.value.sessionId,
    now: NOW,
  });
  if (!committed.ok) throw new Error(committed.message);
  return committed.value.artifactId;
}

async function access(
  c: Client,
  artifactId: string,
  change: Record<string, unknown>,
  tool: string,
  args: Record<string, unknown>,
) {
  const response = await c.apiCall(`/api/v1/artifacts/${artifactId}/access`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  const api = { status: response.status, body: await response.json<unknown>() };
  const result = await c.tool(tool, args);
  return { api, mcp: { ok: result.isError !== true, body: result.structuredContent } };
}

describe("group management through the dashboard's session", () => {
  it("lets admins create, fill, rename and delete groups, and nobody else", async () => {
    const t = await team("wgm");
    const cookie = await t.admin.h.signIn(t.admin.email);
    const base = `/api/v1/workspaces/${t.slug}/groups`;
    const created = await t.admin.h.request(base, dashboard(cookie, "POST", { name: " Design " }));
    expect(created.status).toBe(201);
    const group = await created.json<{ id: string; name: string; members: number }>();
    expect(group).toMatchObject({ name: "Design", members: 0 });
    const added = await t.admin.h.request(
      `${base}/${group.id}/members`,
      dashboard(cookie, "POST", { userId: t.member.userId }),
    );
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      group: { id: group.id, members: 1 },
      items: [{ userId: t.member.userId, email: t.member.email, role: "member" }],
      limit: 500,
    });
    const renamed = await t.admin.h.request(
      `${base}/${group.id}`,
      dashboard(cookie, "PATCH", { name: "Research" }),
    );
    expect(await renamed.json()).toMatchObject({ name: "Research", members: 1 });
    const removed = await t.admin.h.request(
      `${base}/${group.id}/members/${t.member.userId}`,
      dashboard(cookie, "DELETE"),
    );
    expect(removed.status).toBe(204);
    expect(
      (await t.admin.h.request(`${base}/${group.id}`, dashboard(cookie, "DELETE"))).status,
    ).toBe(204);
    expect((await t.admin.h.request(`${base}/${group.id}`, dashboard(cookie))).status).toBe(404);

    // An editor's session lists names but cannot manage or see members; a member sees nothing.
    const editor = await t.editor.h.signIn(t.editor.email);
    expect((await t.editor.h.request(base, dashboard(editor, "POST", { name: "X" }))).status).toBe(
      403,
    );
    expect((await t.editor.h.request(base, dashboard(editor))).status).toBe(200);
    const member = await t.member.h.signIn(t.member.email);
    expect((await t.member.h.request(base, dashboard(member))).status).toBe(403);
    const outsider = await t.outsider.h.signIn(t.outsider.email);
    expect(await (await t.outsider.h.request(base, dashboard(outsider))).json()).toEqual({
      error: { code: "not_found", message: "Workspace not found." },
    });
    // A malformed group ID answers like a missing group.
    expect((await t.admin.h.request(`${base}/wg_nope`, dashboard(cookie))).status).toBe(404);
  });

  it("refuses every management route to a bearer token, even the admin's", async () => {
    const t = await team("wgb");
    const base = `/api/v1/workspaces/${t.slug}/groups`;
    const group = `${base}/wg_${"0".repeat(32)}`;
    for (const [path, init] of [
      [base, { method: "POST", body: JSON.stringify({ name: "Bots" }) }],
      [group, {}],
      [group, { method: "PATCH", body: JSON.stringify({ name: "Bots" }) }],
      [group, { method: "DELETE" }],
      [`${group}/members`, { method: "POST", body: JSON.stringify({ userId: t.member.userId }) }],
      [`${group}/members/${t.member.userId}`, { method: "DELETE" }],
    ] as const) {
      const response = await t.admin.apiCall(path, {
        ...init,
        headers: { "content-type": "application/json" },
      });
      expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(403);
      expect(await response.json(), path).toEqual({
        error: { code: "forbidden", message: "Groups are managed from the dashboard." },
      });
    }
    const groups = await db()
      .select()
      .from(schema.workspaceGroups)
      .where(eq(schema.workspaceGroups.workspaceId, t.id));
    expect(groups).toEqual([]);
  });

  it("refuses creating a group without the plan, with the plan's message", async () => {
    const t = await team("wgp", null);
    const cookie = await t.admin.h.signIn(t.admin.email);
    const response = await t.admin.h.request(
      `/api/v1/workspaces/${t.slug}/groups`,
      dashboard(cookie, "POST", { name: "Design" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "plan_required" } });
  });
});

describe("groups in the API and MCP", () => {
  async function withGroup(prefix: string) {
    const t = await team(prefix);
    const cookie = await t.admin.h.signIn(t.admin.email);
    const created = await t.admin.h.request(
      `/api/v1/workspaces/${t.slug}/groups`,
      dashboard(cookie, "POST", { name: "Design" }),
    );
    const group = await created.json<{ id: string }>();
    await t.admin.h.request(
      `/api/v1/workspaces/${t.slug}/groups/${group.id}/members`,
      dashboard(cookie, "POST", { userId: t.member.userId }),
    );
    return { t, group };
  }

  it("lists names and counts with the same body in both, never the members", async () => {
    const { t, group } = await withGroup("wgl");
    const response = await t.editor.apiCall(`/api/v1/workspaces/${t.slug}/groups`);
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({
      items: [{ id: group.id, name: "Design", members: 1, createdAt: new Date(NOW).toISOString() }],
      available: true,
      limit: 50,
    });
    const result = await t.editor.tool("list_groups", { workspace: t.slug });
    expect(result.structuredContent).toEqual(body);
    expect(JSON.stringify(body)).not.toContain(t.member.email);
    const refused = await t.member.apiCall(`/api/v1/workspaces/${t.slug}/groups`);
    const toolRefused = await t.member.tool("list_groups", { workspace: t.slug });
    expect(refused.status).toBe(403);
    expect(toolRefused.structuredContent).toEqual(await refused.json());
    const missing = await t.outsider.apiCall(`/api/v1/workspaces/${t.slug}/groups`);
    expect(await missing.json()).toEqual(
      (await t.outsider.tool("list_groups", { workspace: t.slug })).structuredContent,
    );
  });

  it("adds and removes a group with the same checks and bodies", async () => {
    const { t, group } = await withGroup("wga");
    const artifactId = await publishIn(t.id, t.editor.userId);
    const added = await access(t.editor, artifactId, { addGroups: [group.id] }, "add_group", {
      artifactId,
      groups: [group.id],
    });
    expect(added.api.status).toBe(200);
    expect(added.mcp.body).toMatchObject({
      groups: [{ id: group.id, name: "Design", members: 1, commentVisibility: null }],
    });
    expect((added.api.body as { groups: unknown[] }).groups).toHaveLength(1);
    const foreign = `wg_${"9".repeat(32)}`;
    const refused = await access(t.editor, artifactId, { addGroups: [foreign] }, "add_group", {
      artifactId,
      groups: [foreign],
    });
    expect(refused.api).toEqual({
      status: 400,
      body: {
        error: { code: "invalid_input", message: `${foreign} is not a group of this workspace.` },
      },
    });
    expect(refused.mcp).toEqual({ ok: false, body: refused.api.body });
    const memberTry = await access(t.member, artifactId, { addGroups: [group.id] }, "add_group", {
      artifactId,
      groups: [group.id],
    });
    expect(memberTry.api.status).toBe(403);
    expect(memberTry.mcp).toEqual({ ok: false, body: memberTry.api.body });
    const removed = await access(
      t.editor,
      artifactId,
      { removeGroups: [group.id] },
      "remove_group",
      {
        artifactId,
        groups: [group.id],
      },
    );
    expect(removed.api.status).toBe(200);
    expect(removed.mcp.body).toMatchObject({ groups: [] });
  });
});
