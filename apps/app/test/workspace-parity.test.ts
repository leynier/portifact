// Workspace roles through /api/v1 and MCP (premium plan F3): the same actor gets the same answer
// from both, admins and editors manage a workspace's artifacts, members manage nothing, and a
// user with no role on the workspace gets exactly what a missing artifact gives, in status, code
// and body. Workspaces and members are inserted as rows: nothing creates them yet.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { commitPublish, preparePublish } from "@portifact/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken, type ToolResult } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-02T09:00:00Z");
const SCOPES =
  "artifacts:read artifacts:write artifacts:share artifacts:delete annotations:read annotations:moderate offline_access";
const MISSING = "zzzzzzzzzz";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface Client {
  userId: string;
  apiCall: (path: string, init?: RequestInit) => Promise<Response>;
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

async function client(email: string): Promise<Client> {
  const h = createHarness();
  const apiAccess = await apiToken(h, email, SCOPES);
  const mcp = await connect(h, await mcpToken(h, email, SCOPES));
  const apiCall = (path: string, init?: RequestInit) => api(h, apiAccess, path, init);
  const { userId } = await (await apiCall("/api/v1/me")).json<{ userId: string }>();
  return { userId, apiCall, tool: (name, args) => callTool(mcp, name, args) };
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const db = () => regionsFromEnv(env).get("default").db;

/** Publishes a Markdown document in the workspace as `userId`, through the services. */
async function publishIn(workspaceId: string, userId: string) {
  const content = `# ${crypto.randomUUID()}`;
  const sha = await sha256(content);
  const prepared = await preparePublish(db(), {
    userId,
    targetOwnerId: workspaceId,
    type: "markdown",
    name: "Team doc",
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
  await env.ARTIFACTS.put(`objects/${workspaceId}/${sha}`, content, { sha256: sha });
  const committed = await commitPublish(db(), env.ARTIFACTS, {
    userId,
    sessionId: prepared.value.sessionId,
    now: NOW,
  });
  if (!committed.ok) throw new Error(committed.message);
  return committed.value;
}

/** One operation, as the API route and as the MCP tool. */
interface Operation {
  name: string;
  api: (id: string) => [string, RequestInit?];
  tool: string;
  args: (id: string) => Record<string, unknown>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const OPERATIONS: Operation[] = [
  {
    name: "get the artifact",
    api: (id) => [`/api/v1/artifacts/${id}`],
    tool: "get_artifact",
    args: (id) => ({ artifactId: id }),
  },
  {
    name: "list versions",
    api: (id) => [`/api/v1/artifacts/${id}/versions`],
    tool: "list_versions",
    args: (id) => ({ artifactId: id }),
  },
  {
    name: "read the access log",
    api: (id) => [`/api/v1/artifacts/${id}/access-log`],
    tool: "get_access_logs",
    args: (id) => ({ artifactId: id }),
  },
  {
    name: "change access",
    api: (id) => [`/api/v1/artifacts/${id}/access`, json("PATCH", { mode: "restricted" })],
    tool: "set_access",
    args: (id) => ({ artifactId: id, mode: "restricted" }),
  },
  {
    name: "set annotations",
    api: (id) => [`/api/v1/artifacts/${id}/annotations/mode`, json("PUT", { mode: "locked" })],
    tool: "set_annotations",
    args: (id) => ({ artifactId: id, mode: "locked" }),
  },
  {
    name: "renew",
    api: (id) => [`/api/v1/artifacts/${id}/renew`, { method: "POST" }],
    tool: "renew_artifact",
    args: (id) => ({ artifactId: id }),
  },
];

async function viaApi(c: Client, op: Operation, id: string) {
  const [path, init] = op.api(id);
  const response = await c.apiCall(path, init);
  return { status: response.status, body: await response.json<unknown>() };
}

async function viaMcp(c: Client, op: Operation, id: string) {
  const result = await c.tool(op.tool, op.args(id));
  return { ok: result.isError !== true, body: result.structuredContent };
}

/** Bodies that carry the moment they were read, which differs between the two calls. */
function stable(body: unknown): unknown {
  if (body && typeof body === "object" && "policyGeneration" in body) {
    const { policyGeneration: _generation, ...rest } = body as Record<string, unknown>;
    return rest;
  }
  return body;
}

describe("workspace roles through the API and MCP", () => {
  it("gives each role the same answer in both, and a non-member the answer of a missing artifact", async () => {
    const [admin, editor, member, outsider] = await Promise.all([
      client("ws-admin@example.test"),
      client("ws-editor@example.test"),
      client("ws-member@example.test"),
      client("ws-outsider@example.test"),
    ]);
    const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    await db().insert(schema.workspaces).values({
      id: workspaceId,
      slug: "parity-team",
      name: "Team",
      createdBy: admin.userId,
      updatedAt: NOW,
    });
    await db()
      .insert(schema.workspaceMembers)
      .values([
        { workspaceId, userId: admin.userId, role: "admin", updatedAt: NOW },
        { workspaceId, userId: editor.userId, role: "editor", updatedAt: NOW },
        { workspaceId, userId: member.userId, role: "member", updatedAt: NOW },
      ]);
    const { artifactId } = await publishIn(workspaceId, editor.userId);

    for (const op of OPERATIONS) {
      for (const [who, c] of [
        ["admin", admin],
        ["editor", editor],
      ] as const) {
        const a = await viaApi(c, op, artifactId);
        const m = await viaMcp(c, op, artifactId);
        expect(a.status, `${who} ${op.name}`).toBeLessThan(300);
        expect(m.ok, `${who} ${op.name}`).toBe(true);
        expect(stable(m.body), `${who} ${op.name}`).toEqual(stable(a.body));
      }

      const forbidden = {
        error: { code: "forbidden", message: "Your role on this workspace does not allow this." },
      };
      const memberApi = await viaApi(member, op, artifactId);
      const memberMcp = await viaMcp(member, op, artifactId);
      if (op.tool === "set_annotations") {
        // Annotations answer anyone who cannot read the artifact like a missing one.
        expect(memberApi).toEqual(await viaApi(member, op, MISSING));
      } else {
        expect(memberApi, `member ${op.name}`).toEqual({ status: 403, body: forbidden });
      }
      expect(memberMcp, `member ${op.name}`).toEqual({ ok: false, body: memberApi.body });

      // A user with no role on the workspace cannot tell the artifact exists.
      const outsiderApi = await viaApi(outsider, op, artifactId);
      expect(outsiderApi, `outsider ${op.name}`).toEqual(await viaApi(outsider, op, MISSING));
      expect(outsiderApi.status).toBe(404);
      expect(await viaMcp(outsider, op, artifactId), `outsider ${op.name}`).toEqual(
        await viaMcp(outsider, op, MISSING),
      );
    }
  });

  it("lists only the personal space's artifacts, so a workspace's never show up there", async () => {
    const editor = await client("ws-lister@example.test");
    const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    await db().insert(schema.workspaces).values({
      id: workspaceId,
      slug: "list-team",
      name: "T",
      createdBy: editor.userId,
      updatedAt: NOW,
    });
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId, userId: editor.userId, role: "editor", updatedAt: NOW });
    await publishIn(workspaceId, editor.userId);
    const listed = await (await editor.apiCall("/api/v1/artifacts")).json<{ items: unknown[] }>();
    expect(listed.items).toEqual([]);
    const tool = await editor.tool("list_artifacts", {});
    expect(tool.structuredContent).toEqual(listed);
  });
});
