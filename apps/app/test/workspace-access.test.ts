// The `workspace` and `domain` access modes and workspace email domains through /api/v1 and MCP
// (premium plan T2, decision 0010): the same checks and bodies in both, domain management only
// through the dashboard's session and only for admins, and no MCP tool for it.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { commitPublish, createWorkspace, preparePublish } from "@portifact/services";
import { FakeDomains } from "@portifact/services/testing";
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

async function setMode(c: Client, artifactId: string, mode: string) {
  const response = await c.apiCall(`/api/v1/artifacts/${artifactId}/access`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const result = await c.tool("set_access", { artifactId, mode });
  return {
    api: { status: response.status, body: await response.json<unknown>() },
    mcp: { ok: result.isError !== true, body: result.structuredContent },
  };
}

describe("the workspace modes in the API and MCP", () => {
  it("refuse a personal artifact with the same typed body in both", async () => {
    const dns = new FakeDomains();
    const solo = await client("wam-solo@example.test", dns);
    const artifactId = await publishIn(solo.userId, solo.userId);
    const body = {
      error: {
        code: "invalid_input",
        message: "Only workspace artifacts can be shared with a workspace or an email domain.",
      },
    };
    for (const mode of ["workspace", "domain"]) {
      expect(await setMode(solo, artifactId, mode)).toEqual({
        api: { status: 400, body },
        mcp: { ok: false, body },
      });
    }
  });

  it("answer a member forbidden and an outsider exactly like a missing artifact", async () => {
    const t = await team("wam");
    const artifactId = await publishIn(t.id, t.admin.userId);
    const forbidden = {
      error: { code: "forbidden", message: "Your role on this workspace does not allow this." },
    };
    expect(await setMode(t.member, artifactId, "workspace")).toEqual({
      api: { status: 403, body: forbidden },
      mcp: { ok: false, body: forbidden },
    });
    const missing = await setMode(t.outsider, "zzzzzzzzzz", "workspace");
    expect(await setMode(t.outsider, artifactId, "workspace")).toEqual(missing);
    expect(missing.api.status).toBe(404);
  });

  it("let an editor share with the workspace and show who that is", async () => {
    const t = await team("wae");
    const artifactId = await publishIn(t.id, t.editor.userId);
    const answers = await setMode(t.editor, artifactId, "workspace");
    expect(answers.api.status).toBe(200);
    expect(answers.api.body).toMatchObject({
      mode: "workspace",
      audience: { members: 3, domains: [], featureAvailable: true },
    });
    expect(answers.mcp).toMatchObject({ ok: true, body: { mode: "workspace" } });
    const read = await t.editor.apiCall(`/api/v1/artifacts/${artifactId}/access`);
    expect(await read.json()).toMatchObject({ audience: { members: 3 } });
  });

  it("make a moved artifact restricted", async () => {
    const t = await team("wat");
    const artifactId = await publishIn(t.id, t.admin.userId);
    await setMode(t.admin, artifactId, "workspace");
    const moved = await t.admin.apiCall(`/api/v1/artifacts/${artifactId}/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: null }),
    });
    expect(await moved.json()).toMatchObject({ accessMode: "restricted" });
  });
});

describe("email domain routes", () => {
  it("answer only the dashboard's session and have no MCP tool", async () => {
    const t = await team("wad");
    const path = `/api/v1/workspaces/${t.slug}/domains`;
    expect((await t.admin.apiCall(path)).status).toBe(403);
    const posted = await t.admin.apiCall(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "acme-wad.com" }),
    });
    expect(posted.status).toBe(403);
    for (const name of TOOL_SCOPES.keys()) {
      expect(name).not.toMatch(/email_domain|workspace_domain|verify_domain/);
    }
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
      body: JSON.stringify({ domain: "acme-wad.com" }),
    });
    expect(crossSite.status).toBe(403);
  });

  it("add, verify, list and remove a domain for an admin, and refuse everyone else", async () => {
    const t = await team("wav");
    const path = `/api/v1/workspaces/${t.slug}/domains`;
    const admin = await t.admin.h.signIn(t.admin.email);
    const added = await t.admin.h.request(
      path,
      dashboard(admin, "POST", { domain: "Acme-WAV.com" }),
    );
    expect(added.status).toBe(201);
    const claim = await added.json<{
      id: string;
      domain: string;
      state: string;
      record: { name: string; value: string };
    }>();
    expect(claim).toMatchObject({
      domain: "acme-wav.com",
      state: "pending",
      record: { name: "_portifact-email.acme-wav.com" },
    });
    expect(claim.record.value).toMatch(/^portifact-email-verify=[0-9a-f]{32}$/);

    const verify = `${path}/${claim.id}/verify`;
    const early = await t.admin.h.request(verify, dashboard(admin, "POST"));
    expect(early.status).toBe(400);
    t.dns.publishTxt(claim.record.name, claim.record.value);
    const done = await t.admin.h.request(verify, dashboard(admin, "POST"));
    expect(await done.json()).toMatchObject({
      state: "verified",
      failedChecks: 0,
      expiresAt: null,
    });

    const listed = await (await t.admin.h.request(path, dashboard(admin))).json<{
      items: unknown[];
      available: boolean;
      limit: number;
    }>();
    expect(listed).toMatchObject({ available: true, limit: 10 });
    expect(listed.items).toHaveLength(1);

    const editor = await t.editor.h.signIn(t.editor.email);
    expect((await t.editor.h.request(path, dashboard(editor))).status).toBe(403);
    const outsider = await t.outsider.h.signIn(t.outsider.email);
    const answer = await t.outsider.h.request(path, dashboard(outsider));
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({
      error: { code: "not_found", message: "Workspace not found." },
    });

    const artifactId = await publishIn(t.id, t.admin.userId);
    expect((await setMode(t.admin, artifactId, "domain")).api.body).toMatchObject({
      mode: "domain",
      audience: { domains: ["acme-wav.com"] },
    });

    const removed = await t.admin.h.request(`${path}/${claim.id}`, dashboard(admin, "DELETE"));
    expect(await removed.json()).toEqual({ id: claim.id, removed: true });
    const malformed = await t.admin.h.request(`${path}/nope`, dashboard(admin, "DELETE"));
    expect(malformed.status).toBe(404);
  });

  it("gate adding on the workspace's plan with the plan_required body", async () => {
    const t = await team("wap", null);
    const admin = await t.admin.h.signIn(t.admin.email);
    const added = await t.admin.h.request(
      `/api/v1/workspaces/${t.slug}/domains`,
      dashboard(admin, "POST", { domain: "acme-wap.com" }),
    );
    expect(added.status).toBe(403);
    expect(await added.json()).toEqual({
      error: { code: "plan_required", message: "Using workspaces is part of the Team plan." },
    });
  });

  it("answer verification capacity_unavailable without DNS", async () => {
    const h = createHarness();
    const email = "wan-admin@example.test";
    await apiToken(h, email, SCOPES);
    const cookie = await h.signIn(email);
    const response = await h.request(
      `/api/v1/workspaces/nobody-team/domains/wd_${"0".repeat(32)}/verify`,
      dashboard(cookie, "POST"),
    );
    expect(response.status).toBe(503);
  });

  it("refuse malformed names and IDs and explain every refusal", async () => {
    const t = await team("wax");
    const admin = await t.admin.h.signIn(t.admin.email);
    const base = `/api/v1/workspaces/${t.slug}/domains`;
    const status = async (path: string, init: RequestInit) =>
      (await t.admin.h.request(path, init)).status;
    expect(await status("/api/v1/workspaces/Bad!/domains", dashboard(admin))).toBe(404);
    expect(
      await status(
        "/api/v1/workspaces/Bad!/domains",
        dashboard(admin, "POST", { domain: "a.com" }),
      ),
    ).toBe(404);
    expect(
      await status(
        `/api/v1/workspaces/Bad!/domains/wd_${"0".repeat(32)}/verify`,
        dashboard(admin, "POST"),
      ),
    ).toBe(404);
    expect(await status(`${base}/nope/verify`, dashboard(admin, "POST"))).toBe(404);
    expect(
      await status(
        `/api/v1/workspaces/Bad!/domains/wd_${"0".repeat(32)}`,
        dashboard(admin, "DELETE"),
      ),
    ).toBe(404);
    expect(await status(`${base}/wd_${"0".repeat(32)}/verify`, dashboard(admin, "POST"))).toBe(404);
    expect(await status(`${base}/wd_${"0".repeat(32)}`, dashboard(admin, "DELETE"))).toBe(404);
    expect(await status(base, dashboard(admin, "POST", { nope: 1 }))).toBe(400);
    const gmail = await t.admin.h.request(base, dashboard(admin, "POST", { domain: "gmail.com" }));
    expect(gmail.status).toBe(400);
    expect(await gmail.json()).toMatchObject({ error: { code: "invalid_input" } });
    const member = await t.member.h.signIn(t.member.email);
    expect(
      (await t.member.h.request(`${base}/wd_${"0".repeat(32)}`, dashboard(member, "DELETE")))
        .status,
    ).toBe(403);
  });
});

describe("set_access in the workspace modes", () => {
  it("says who a domain artifact reaches, and that a lapsed plan leaves members only", async () => {
    const t = await team("wam2");
    const admin = await t.admin.h.signIn(t.admin.email);
    const added = await (
      await t.admin.h.request(
        `/api/v1/workspaces/${t.slug}/domains`,
        dashboard(admin, "POST", { domain: "acme-wam2.com" }),
      )
    ).json<{ id: string; record: { name: string; value: string } }>();
    t.dns.publishTxt(added.record.name, added.record.value);
    await t.admin.h.request(
      `/api/v1/workspaces/${t.slug}/domains/${added.id}/verify`,
      dashboard(admin, "POST"),
    );
    const artifactId = await publishIn(t.id, t.admin.userId);
    const text = (result: ToolResult) =>
      (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    const set = await t.admin.tool("set_access", { artifactId, mode: "domain" });
    expect(text(set)).toContain("anyone signed in with a verified address at acme-wam2.com");
    const workspace = await t.admin.tool("set_access", { artifactId, mode: "workspace" });
    expect(text(workspace)).toContain("the 3 member(s) of its workspace, after signing in");
    await t.admin.tool("set_access", { artifactId, mode: "domain" });
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    const lapsed = await t.admin.tool("set_access", { artifactId, mode: "domain" });
    expect(text(lapsed)).toContain("only, because the workspace's plan does not include");
  });

  it("names no domain while none is verified", async () => {
    const t = await team("wam3");
    const artifactId = await publishIn(t.id, t.admin.userId);
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "domain" })
      .where(eq(schema.artifacts.id, artifactId));
    const result = await t.admin.tool("set_access", { artifactId, mode: "domain" });
    const body = (result.content as { text: string }[]).map((c) => c.text).join("");
    expect(body).toContain("no verified domain yet");
  });
});
