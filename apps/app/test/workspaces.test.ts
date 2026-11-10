// Workspaces through /api/v1 and MCP (premium plan T1): the `workspace` parameter of owner-scoped
// routes and tools, the caller's workspaces, transfers, and the member and invitation routes that
// only the dashboard's session reaches. The same actor gets the same answer from the API and MCP.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace } from "@portifact/services";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_SCOPES } from "../src/mcp/tools.ts";
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

interface Client {
  userId: string;
  email: string;
  h: Harness;
  apiCall: (path: string, init?: RequestInit) => Promise<Response>;
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

async function client(email: string): Promise<Client> {
  const h = createHarness();
  const apiAccess = await apiToken(h, email, SCOPES);
  const mcp = await connect(h, await mcpToken(h, email, SCOPES));
  const apiCall = (path: string, init?: RequestInit) => api(h, apiAccess, path, init);
  const { userId } = await (await apiCall("/api/v1/me")).json<{ userId: string }>();
  return { userId, email, h, apiCall, tool: (name, args) => callTool(mcp, name, args) };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** What the dashboard's fetch sends: the session cookie and same-origin fetch metadata. */
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

async function team(prefix: string) {
  const [admin, editor, member, outsider] = await Promise.all(
    ["admin", "editor", "member", "outsider"].map((role) =>
      client(`${prefix}-${role}@example.test`),
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
  const db = regions().get("default").db;
  await db.insert(schema.workspaceMembers).values([
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
  await db.insert(schema.ownerPlans).values({
    ownerId: created.value.id,
    plan: "team",
    seats: 10,
    grantedBy: "test",
    updatedAt: NOW,
  });
  return {
    id: created.value.id,
    slug,
    admin: admin as Client,
    editor: editor as Client,
    member: member as Client,
    outsider: outsider as Client,
  };
}

async function viaApi(c: Client, path: string, init?: RequestInit) {
  const response = await c.apiCall(path, init);
  return { status: response.status, body: await response.json<unknown>() };
}

async function viaMcp(c: Client, tool: string, args: Record<string, unknown>) {
  const result = await c.tool(tool, args);
  return { ok: result.isError !== true, body: result.structuredContent };
}

const missingWorkspace = { error: { code: "not_found", message: "Workspace not found." } };
const forbidden = {
  error: { code: "forbidden", message: "Your role on this workspace does not allow this." },
};

describe("naming a workspace in the API and MCP", () => {
  it("lists the caller's workspaces with their role, the same in both", async () => {
    const t = await team("wsl");
    for (const [who, c] of [
      ["admin", t.admin],
      ["member", t.member],
    ] as const) {
      const a = await viaApi(c, "/api/v1/workspaces");
      expect(a).toEqual({
        status: 200,
        body: {
          items: [
            {
              slug: t.slug,
              name: "Team",
              role: who,
              region: "default",
              createdAt: new Date(NOW).toISOString(),
            },
          ],
        },
      });
      expect(await viaMcp(c, "list_workspaces", {})).toEqual({ ok: true, body: a.body });
    }
    expect((await viaApi(t.outsider, "/api/v1/workspaces")).body).toEqual({ items: [] });
  });

  it("publishes into, lists and reports the usage of a workspace, the same in both", async () => {
    const t = await team("wsp");
    const published = await viaMcp(t.editor, "publish_document", {
      workspace: t.slug,
      type: "markdown",
      name: "Team notes",
      content: "# Notes",
    });
    expect(published.ok).toBe(true);
    const artifactId = (published.body as { artifactId: string }).artifactId;

    const listed = await viaApi(t.editor, `/api/v1/artifacts?workspace=${t.slug}`);
    expect(listed.status).toBe(200);
    const items = (listed.body as { items: { id: string; owner: unknown }[] }).items;
    expect(items.map((item) => [item.id, item.owner])).toEqual([
      [artifactId, { kind: "workspace", slug: t.slug, name: "Team" }],
    ]);
    expect(await viaMcp(t.editor, "list_artifacts", { workspace: t.slug })).toEqual({
      ok: true,
      body: listed.body,
    });
    // The personal list never shows it.
    expect((await viaApi(t.editor, "/api/v1/artifacts")).body).toMatchObject({ items: [] });
    const summary = await viaApi(t.admin, `/api/v1/artifacts/${artifactId}`);
    expect(summary.body).toMatchObject({ owner: { kind: "workspace", slug: t.slug } });

    const usage = await viaApi(t.editor, `/api/v1/usage?workspace=${t.slug}`);
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({ activeArtifacts: { used: 1 }, plan: { name: "team" } });
    expect(await viaMcp(t.editor, "get_usage", { workspace: t.slug })).toEqual({
      ok: true,
      body: usage.body,
    });
  });

  it("refuses members and answers outsiders and unknown slugs like a missing workspace", async () => {
    const t = await team("wsr");
    const routes: [string, string, Record<string, unknown>][] = [
      [`/api/v1/artifacts?workspace=${t.slug}`, "list_artifacts", { workspace: t.slug }],
      [`/api/v1/usage?workspace=${t.slug}`, "get_usage", { workspace: t.slug }],
    ];
    for (const [path, tool, args] of routes) {
      const member = await viaApi(t.member, path);
      expect(member, `member ${tool}`).toEqual({ status: 403, body: forbidden });
      expect(await viaMcp(t.member, tool, args)).toEqual({ ok: false, body: forbidden });
      const outsider = await viaApi(t.outsider, path);
      expect(outsider, `outsider ${tool}`).toEqual({ status: 404, body: missingWorkspace });
      expect(await viaMcp(t.outsider, tool, args)).toEqual({ ok: false, body: missingWorkspace });
      expect(await viaApi(t.admin, path.replace(t.slug, "no-such-team"))).toEqual({
        status: 404,
        body: missingWorkspace,
      });
    }
    expect(await viaApi(t.admin, "/api/v1/artifacts?workspace=Not%20A%20Slug")).toEqual({
      status: 404,
      body: missingWorkspace,
    });
    const publish = {
      workspace: t.slug,
      type: "markdown",
      name: "Nope",
      content: "# Nope",
    };
    expect(await viaMcp(t.member, "publish_document", publish)).toEqual({
      ok: false,
      body: forbidden,
    });
    expect(await viaMcp(t.outsider, "publish_document", publish)).toEqual({
      ok: false,
      body: missingWorkspace,
    });
  });

  it("opens an upload in the workspace the query names", async () => {
    const t = await team("wsu");
    const content = "# Upload";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const body = {
      type: "markdown",
      name: "Uploaded",
      entrypoint: "index.md",
      files: [{ path: "index.md", sha256, size: content.length, contentType: "text/markdown" }],
    };
    const prepare = (c: Client, query: string) =>
      c.apiCall(`/api/v1/publishes${query}`, {
        ...json("POST", body),
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      });
    expect((await prepare(t.member, `?workspace=${t.slug}`)).status).toBe(403);
    expect((await prepare(t.outsider, `?workspace=${t.slug}`)).status).toBe(404);
    const prepared = await prepare(t.editor, `?workspace=${t.slug}`);
    expect(prepared.status).toBe(201);
    const { uploadId } = await prepared.json<{ uploadId: string }>();
    await env.ARTIFACTS.put(`objects/${t.id}/${sha256}`, content, { sha256 });
    const committed = await t.editor.apiCall(`/api/v1/publishes/${uploadId}/commit`, {
      method: "POST",
    });
    expect(committed.status).toBe(200);
    const { artifactId } = await committed.json<{ artifactId: string }>();
    const [artifact] = await regions()
      .get("default")
      .db.select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(artifact?.ownerId).toBe(t.id);
  });

  it("moves an artifact between spaces, the same through both, for admins and editors only", async () => {
    const t = await team("wst");
    const mine = await viaMcp(t.editor, "publish_document", {
      type: "markdown",
      name: "Mine",
      content: "# Mine",
    });
    const artifactId = (mine.body as { artifactId: string }).artifactId;
    const toTeam = await viaApi(
      t.editor,
      `/api/v1/artifacts/${artifactId}/transfer`,
      json("POST", { workspace: t.slug }),
    );
    expect(toTeam.status).toBe(200);
    expect(toTeam.body).toMatchObject({
      id: artifactId,
      owner: { kind: "workspace", slug: t.slug, name: "Team" },
    });
    // A retry answers the same.
    expect(
      await viaMcp(t.editor, "transfer_artifact", { artifactId, workspace: t.slug }),
    ).toMatchObject({ ok: true, body: { id: artifactId, owner: { kind: "workspace" } } });

    const notMine = await viaApi(
      t.member,
      `/api/v1/artifacts/${artifactId}/transfer`,
      json("POST", { workspace: null }),
    );
    expect(notMine).toEqual({ status: 403, body: forbidden });
    expect(await viaMcp(t.member, "transfer_artifact", { artifactId, workspace: null })).toEqual({
      ok: false,
      body: forbidden,
    });
    const outsider = await viaApi(
      t.outsider,
      `/api/v1/artifacts/${artifactId}/transfer`,
      json("POST", { workspace: null }),
    );
    expect(outsider.status).toBe(404);
    expect(await viaMcp(t.outsider, "transfer_artifact", { artifactId, workspace: null })).toEqual({
      ok: false,
      body: outsider.body,
    });

    const back = await viaMcp(t.admin, "transfer_artifact", { artifactId, workspace: null });
    expect(back).toMatchObject({ ok: true, body: { owner: { kind: "personal" } } });
    expect((await viaApi(t.admin, `/api/v1/artifacts/${artifactId}`)).body).toMatchObject({
      owner: { kind: "personal" },
    });
    expect(
      await viaApi(t.admin, `/api/v1/artifacts/${artifactId}/transfer`, json("POST", {})),
    ).toMatchObject({ status: 400 });
  });

  it("lists members to every member, through bearer tokens too", async () => {
    const t = await team("wsm");
    const listed = await viaApi(t.member, `/api/v1/workspaces/${t.slug}/members`);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      workspace: { slug: t.slug, role: "member" },
      seats: { used: 3, limit: 10 },
    });
    const items = (listed.body as { items: { email: string; role: string; you: boolean }[] }).items;
    expect(items.map((item) => [item.role, item.you]).sort()).toEqual([
      ["admin", false],
      ["editor", false],
      ["member", true],
    ]);
    expect(await viaApi(t.outsider, `/api/v1/workspaces/${t.slug}/members`)).toEqual({
      status: 404,
      body: missingWorkspace,
    });
  });
});

describe("scopes", () => {
  it("give each new tool the scope of its API route, and no tool manages members", async () => {
    expect(TOOL_SCOPES.get("list_workspaces")).toBe("artifacts:read");
    expect(TOOL_SCOPES.get("transfer_artifact")).toBe("artifacts:write");
    for (const name of TOOL_SCOPES.keys()) {
      expect(name).not.toMatch(/member|invit/);
    }
    const h = createHarness();
    const readOnly = await apiToken(h, "wsscope@example.test", "artifacts:read offline_access");
    const listed = await api(h, readOnly, "/api/v1/workspaces");
    expect(listed.status).toBe(200);
    const moved = await api(
      h,
      readOnly,
      "/api/v1/artifacts/abcdefghij/transfer",
      json("POST", { workspace: null }),
    );
    expect(moved.status).toBe(403);
    const mcp = await connect(
      h,
      await mcpToken(h, "wsscope@example.test", "artifacts:read offline_access"),
    );
    expect((await callTool(mcp, "list_workspaces", {})).isError).not.toBe(true);
  });
});

describe("member and invitation routes", () => {
  it("answer only the dashboard's session", async () => {
    const t = await team("wss");
    const path = `/api/v1/workspaces/${t.slug}/invitations`;
    const bearer = await viaApi(t.admin, path);
    expect(bearer).toEqual({
      status: 403,
      body: {
        error: { code: "forbidden", message: "Managing members needs a dashboard session." },
      },
    });
    const anonymous = await t.admin.h.request(path, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(anonymous.status).toBe(401);
    const cookie = await t.admin.h.signIn(t.admin.email);
    const crossSite = await t.admin.h.request(path, {
      method: "POST",
      headers: {
        cookie,
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "x@example.test", role: "member" }),
    });
    expect(crossSite.status).toBe(403);
    const listed = await t.admin.h.request(path, dashboard(cookie));
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
  });

  it("invite by email, and the invitee accepts once with the link's token", async () => {
    const t = await team("wsi");
    const h = t.admin.h;
    const adminCookie = await h.signIn(t.admin.email);
    const editorCookie = await t.editor.h.signIn(t.editor.email);
    const path = `/api/v1/workspaces/${t.slug}/invitations`;
    const refused = await t.editor.h.request(
      path,
      dashboard(editorCookie, "POST", { email: "wsi-new@example.test", role: "member" }),
    );
    expect(refused.status).toBe(403);

    const before = h.outbox.length;
    const sent = await h.request(
      path,
      dashboard(adminCookie, "POST", { email: "WSI-New@example.test", role: "editor" }),
    );
    expect(sent.status).toBe(201);
    const invitation = await sent.json<{ id: string; email: string; role: string }>();
    expect(invitation).toMatchObject({ email: "wsi-new@example.test", role: "editor" });
    const email = h.outbox[before];
    expect(email?.to).toBe("wsi-new@example.test");
    expect(email?.subject).toBe("You are invited to a workspace on Portifact");
    const token = /invitations\?token=([A-Za-z0-9_-]{43})/.exec(email?.text ?? "")?.[1];
    expect(token).toBeDefined();

    const invitee = createHarness();
    const inviteeCookie = await invitee.signIn("wsi-new@example.test");
    const incoming = await invitee.request("/api/v1/account/invitations", dashboard(inviteeCookie));
    expect(await incoming.json()).toMatchObject({
      items: [{ id: invitation.id, workspace: { slug: t.slug, name: "Team" }, role: "editor" }],
    });
    const accept = () =>
      invitee.request("/api/v1/invitations/accept", dashboard(inviteeCookie, "POST", { token }));
    // Someone else's session cannot use the link.
    const stranger = await h.request(
      "/api/v1/invitations/accept",
      dashboard(editorCookie, "POST", { token }),
    );
    expect(stranger.status).toBe(404);
    const accepted = await accept();
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ slug: t.slug, role: "editor" });
    expect((await accept()).status).toBe(404);
  });

  it("change roles, remove members, revoke invitations and let members leave", async () => {
    const t = await team("wsc");
    const adminCookie = await t.admin.h.signIn(t.admin.email);
    const base = `/api/v1/workspaces/${t.slug}`;
    const changed = await t.admin.h.request(
      `${base}/members/${t.member.userId}`,
      dashboard(adminCookie, "PATCH", { role: "editor" }),
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ userId: t.member.userId, role: "editor" });
    const demoteSelf = await t.admin.h.request(
      `${base}/members/${t.admin.userId}`,
      dashboard(adminCookie, "PATCH", { role: "member" }),
    );
    expect(demoteSelf.status).toBe(409);
    expect(await demoteSelf.json()).toMatchObject({ error: { code: "sole_workspace_admin" } });

    const sent = await t.admin.h.request(
      `${base}/invitations`,
      dashboard(adminCookie, "POST", { email: "wsc-later@example.test", role: "member" }),
    );
    const { id } = await sent.json<{ id: string }>();
    const revoked = await t.admin.h.request(
      `${base}/invitations/${id}`,
      dashboard(adminCookie, "DELETE"),
    );
    expect(revoked.status).toBe(204);

    const removed = await t.admin.h.request(
      `${base}/members/${t.member.userId}`,
      dashboard(adminCookie, "DELETE"),
    );
    expect(removed.status).toBe(204);
    const editorCookie = await t.editor.h.signIn(t.editor.email);
    const left = await t.editor.h.request(`${base}/leave`, dashboard(editorCookie, "POST"));
    expect(left.status).toBe(204);
    const adminLeaves = await t.admin.h.request(`${base}/leave`, dashboard(adminCookie, "POST"));
    expect(adminLeaves.status).toBe(409);
    expect((await viaApi(t.editor, "/api/v1/workspaces")).body).toEqual({ items: [] });
  });

  it("refuse malformed slugs and IDs, and answer invitations from the invitee's list", async () => {
    const t = await team("wsx");
    const adminCookie = await t.admin.h.signIn(t.admin.email);
    const h = t.admin.h;
    for (const [path, method, body] of [
      ["/api/v1/workspaces/Bad%20Slug/members/u_1", "PATCH", { role: "member" }],
      ["/api/v1/workspaces/Bad%20Slug/members/u_1", "DELETE", undefined],
      ["/api/v1/workspaces/Bad%20Slug/leave", "POST", undefined],
      ["/api/v1/workspaces/Bad%20Slug/invitations", "GET", undefined],
      ["/api/v1/workspaces/Bad%20Slug/invitations", "POST", { email: "a@b.io", role: "member" }],
      [`/api/v1/workspaces/${t.slug}/invitations/not-an-id`, "DELETE", undefined],
      ["/api/v1/account/invitations/not-an-id/accept", "POST", undefined],
    ] as [string, string, unknown][]) {
      const response = await h.request(path, dashboard(adminCookie, method, body));
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect((await viaApi(t.admin, "/api/v1/workspaces/Bad%20Slug/members")).status).toBe(404);
    expect((await viaApi(t.admin, "/api/v1/usage?workspace=Bad%20Slug")).status).toBe(404);
    const bad = await h.request(
      `/api/v1/workspaces/${t.slug}/members/${t.member.userId}`,
      dashboard(adminCookie, "PATCH", { role: "owner" }),
    );
    expect(bad.status).toBe(400);
    expect(
      (
        await h.request(
          `/api/v1/workspaces/${t.slug}/invitations`,
          dashboard(adminCookie, "POST", { email: "nope", role: "member" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request(
          "/api/v1/invitations/decline",
          dashboard(adminCookie, "POST", { token: "short" }),
        )
      ).status,
    ).toBe(400);

    for (const decision of ["decline", "accept"] as const) {
      const address = `wsx-${decision}@example.test`;
      const sent = await h.request(
        `/api/v1/workspaces/${t.slug}/invitations`,
        dashboard(adminCookie, "POST", { email: address, role: "member" }),
      );
      const { id } = await sent.json<{ id: string }>();
      const invitee = createHarness();
      const cookie = await invitee.signIn(address);
      const answered = await invitee.request(
        `/api/v1/account/invitations/${id}/${decision}`,
        dashboard(cookie, "POST"),
      );
      expect(answered.status).toBe(decision === "accept" ? 200 : 204);
      const again = await invitee.request(
        `/api/v1/account/invitations/${id}/${decision}`,
        dashboard(cookie, "POST"),
      );
      expect(again.status).toBe(404);
    }
    const token = "A".repeat(43);
    const declined = await h.request(
      "/api/v1/invitations/decline",
      dashboard(adminCookie, "POST", { token }),
    );
    expect(declined.status).toBe(404);
  });

  it("opens an MCP upload in the workspace named, and refuses one the user cannot publish to", async () => {
    const t = await team("wsy");
    const content = "# Upload";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const args = (key: string) => ({
      workspace: t.slug,
      type: "markdown",
      name: "Uploaded",
      entrypoint: "index.md",
      files: [{ path: "index.md", sha256, size: content.length, contentType: "text/markdown" }],
      idempotencyKey: key,
    });
    expect(await viaMcp(t.member, "prepare_upload", args("member-key-1"))).toEqual({
      ok: false,
      body: forbidden,
    });
    expect(await viaMcp(t.outsider, "prepare_upload", args("outsider-key-1"))).toEqual({
      ok: false,
      body: missingWorkspace,
    });
    const prepared = await viaMcp(t.editor, "prepare_upload", args("editor-key-1"));
    expect(prepared.ok).toBe(true);
    const bad = await viaMcp(t.editor, "prepare_upload", {
      ...args("editor-key-2"),
      entrypoint: "",
    });
    expect(bad.ok).toBe(false);
  });
});
