// Workspace policies through /api/v1, MCP and the dashboard's session (premium plan E4, decision
// 0015): reading, previewing and changing them only through the session, and the refusals they
// cause answered with the same body by the API and MCP.
import { env } from "cloudflare:workers";
import { DEFAULT_POLICY, planRequiredMessage, type WorkspacePolicy } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { POLICY_MESSAGES } from "@portifact/domain";
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

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function team(prefix: string, plan: "enterprise" | "team" = "enterprise") {
  const dns = new FakeDomains();
  const [admin, editor, member] = await Promise.all(
    ["admin", "editor", "member"].map((role) => client(`${prefix}-${role}@example.test`, dns)),
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
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId: created.value.id, plan, seats: 10, grantedBy: "test", updatedAt: NOW });
  // Old enough accounts, so making an artifact public is refused only by the policy.
  for (const who of [admin, editor, member] as Client[]) {
    await db()
      .update(schema.users)
      .set({ createdAt: new Date(NOW - 30 * 86_400_000) })
      .where(eq(schema.users.id, who.userId));
  }
  return {
    id: created.value.id,
    slug,
    admin: admin as Client,
    editor: editor as Client,
    member: member as Client,
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

const policy = (overrides: Partial<WorkspacePolicy> = {}): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...overrides,
});
const refusedBody = (message: string) => ({ error: { code: "policy_refused", message } });

describe("policies through the dashboard's session", () => {
  it("lets members read, only admins preview and save, and refuses bearer tokens", async () => {
    const t = await team("pol-session");
    const base = `/api/v1/workspaces/${t.slug}/policies`;
    const adminCookie = await t.admin.h.signIn(t.admin.email);
    const read = await t.admin.h.request(base, dashboard(adminCookie));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      policy: DEFAULT_POLICY,
      revision: 0,
      enabled: true,
      editable: true,
      domainVerified: false,
    });
    const preview = await t.admin.h.request(
      `${base}/preview`,
      dashboard(adminCookie, "POST", { policy: policy({ publicAccess: "forbidden" }) }),
    );
    expect(await preview.json()).toEqual({
      publicArtifacts: 0,
      readersOutside: 0,
      linksRevoked: 0,
      linksWithoutPassword: 0,
      linksOverLifetime: 0,
    });
    const saved = await t.admin.h.request(
      base,
      dashboard(adminCookie, "PUT", { policy: policy({ publicAccess: "forbidden" }), revision: 0 }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      revision: 1,
      policy: { publicAccess: "forbidden" },
    });
    // The workspace list (API and MCP) carries the policy in effect.
    const listed = await (await t.member.apiCall("/api/v1/workspaces")).json<{
      items: { slug: string; policy: WorkspacePolicy }[];
    }>();
    expect(listed.items.find((item) => item.slug === t.slug)?.policy.publicAccess).toBe(
      "forbidden",
    );
    const tool = await t.member.tool("list_workspaces", {});
    expect(tool.structuredContent).toEqual(listed);
    expect(JSON.stringify(tool.content)).toContain("public access forbidden");

    const memberCookie = await t.member.h.signIn(t.member.email);
    const memberRead = await t.member.h.request(base, dashboard(memberCookie));
    expect(await memberRead.json()).toMatchObject({ editable: false, revision: 1 });
    const memberSave = await t.member.h.request(
      base,
      dashboard(memberCookie, "PUT", { policy: DEFAULT_POLICY, revision: 1 }),
    );
    expect(memberSave.status).toBe(403);
    const memberPreview = await t.member.h.request(
      `${base}/preview`,
      dashboard(memberCookie, "POST", { policy: DEFAULT_POLICY }),
    );
    expect(memberPreview.status).toBe(403);
    // A bearer token never reaches them, whatever it asks.
    for (const [path, init] of [
      [base, undefined],
      [base, json("PUT", { policy: DEFAULT_POLICY, revision: 1 })],
      [`${base}/preview`, json("POST", { policy: DEFAULT_POLICY })],
    ] as const) {
      const response = await t.admin.apiCall(path, init);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: {
          code: "forbidden",
          message: "Workspace policies are managed from the dashboard.",
        },
      });
    }
    // Without a session cookie or from another origin, refused too.
    expect((await t.admin.h.request(base)).status).toBe(401);
    expect(
      (
        await t.admin.h.request(base, {
          method: "PUT",
          headers: {
            cookie: adminCookie,
            "sec-fetch-site": "cross-site",
            origin: "https://evil.example",
          },
        })
      ).status,
    ).toBe(403);
    // An unknown or malformed slug answers like a missing workspace.
    expect(
      (await t.admin.h.request("/api/v1/workspaces/NOPE/policies", dashboard(adminCookie))).status,
    ).toBe(404);
  });

  it("answers plan_required, policy_refused, conflicts and bad input with their bodies", async () => {
    const t = await team("pol-gate", "team");
    const base = `/api/v1/workspaces/${t.slug}/policies`;
    const cookie = await t.admin.h.signIn(t.admin.email);
    const gated = await t.admin.h.request(
      base,
      dashboard(cookie, "PUT", { policy: policy({ shareLinks: "disabled" }), revision: 0 }),
    );
    expect(gated.status).toBe(403);
    expect(await gated.json()).toEqual({
      error: { code: "plan_required", message: planRequiredMessage("policies") },
    });
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "enterprise" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    const artifactId = await publishIn(t.id, t.editor.userId);
    await t.editor.apiCall(
      `/api/v1/artifacts/${artifactId}/access`,
      json("PATCH", { mode: "public" }),
    );
    const unconfirmed = await t.admin.h.request(
      base,
      dashboard(cookie, "PUT", { policy: policy({ publicAccess: "forbidden" }), revision: 0 }),
    );
    expect(unconfirmed.status).toBe(403);
    expect(await unconfirmed.json()).toMatchObject({ error: { code: "policy_refused" } });
    const stale = await t.admin.h.request(
      base,
      dashboard(cookie, "PUT", { policy: DEFAULT_POLICY, revision: 7 }),
    );
    expect(stale.status).toBe(409);
    const bad = await t.admin.h.request(
      base,
      dashboard(cookie, "PUT", { policy: { publicAccess: "maybe" }, revision: 0 }),
    );
    expect(bad.status).toBe(400);
    const badPreview = await t.admin.h.request(
      `${base}/preview`,
      dashboard(cookie, "POST", { policy: policy({ readerDomains: ["not a domain"] }) }),
    );
    expect(badPreview.status).toBe(400);
    const confirmed = await t.admin.h.request(
      base,
      dashboard(cookie, "PUT", {
        policy: policy({ publicAccess: "forbidden" }),
        revision: 0,
        confirm: true,
      }),
    );
    expect(confirmed.status).toBe(200);
  });
});

describe("refusals, the same through the API and MCP", () => {
  it("public access, readers, share links and transfers", async () => {
    const t = await team("pol-parity");
    value(
      await (async () => {
        const cookie = await t.admin.h.signIn(t.admin.email);
        const response = await t.admin.h.request(
          `/api/v1/workspaces/${t.slug}/policies`,
          dashboard(cookie, "PUT", {
            policy: policy({
              publicAccess: "forbidden",
              readerDomains: ["corp.example"],
              shareLinks: "password_required",
            }),
            revision: 0,
          }),
        );
        return response.status === 200;
      })(),
    );
    const artifactId = await publishIn(t.id, t.editor.userId);
    const cases: [string, RequestInit, string, Record<string, unknown>, string][] = [
      [
        `/api/v1/artifacts/${artifactId}/access`,
        json("PATCH", { mode: "public" }),
        "set_access",
        { artifactId, mode: "public" },
        POLICY_MESSAGES.publicForbidden,
      ],
      [
        `/api/v1/artifacts/${artifactId}/access`,
        json("PATCH", { addReaders: ["eve@evil.example"] }),
        "add_reader",
        { artifactId, emails: ["eve@evil.example"] },
        POLICY_MESSAGES.readerOutside("eve@evil.example", ["corp.example"]),
      ],
      [
        `/api/v1/artifacts/${artifactId}/share-links`,
        json("POST", { label: "Ana" }),
        "create_share_link",
        { artifactId, label: "Ana" },
        POLICY_MESSAGES.passwordRequired,
      ],
    ];
    for (const [path, init, tool, args, message] of cases) {
      const response = await t.editor.apiCall(path, init);
      expect(response.status, tool).toBe(403);
      const body = await response.json();
      expect(body, tool).toEqual(refusedBody(message));
      const result = await t.editor.tool(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.structuredContent, tool).toEqual(body);
    }
    // A transfer into the workspace of a public personal artifact.
    await db()
      .insert(schema.ownerPlans)
      .values({
        ownerId: t.editor.userId,
        plan: "pro",
        seats: 1,
        grantedBy: "test",
        updatedAt: NOW,
      })
      .onConflictDoNothing();
    const personal = await publishIn(t.editor.userId, t.editor.userId);
    await t.editor.apiCall(
      `/api/v1/artifacts/${personal}/access`,
      json("PATCH", { mode: "public" }),
    );
    const moved = await t.editor.apiCall(
      `/api/v1/artifacts/${personal}/transfer`,
      json("POST", { workspace: t.slug }),
    );
    expect(moved.status).toBe(403);
    const movedBody = await moved.json();
    expect(movedBody).toEqual(refusedBody(POLICY_MESSAGES.transferPublic));
    const viaTool = await t.editor.tool("transfer_artifact", {
      artifactId: personal,
      workspace: t.slug,
    });
    expect(viaTool.structuredContent).toEqual(movedBody);
  });
});

function value(ok: boolean) {
  if (!ok) throw new Error("The policy was not saved");
}
