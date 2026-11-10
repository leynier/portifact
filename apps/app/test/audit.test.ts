// The audit log through /api/v1 and MCP (premium plan T10): the same body from GET /api/v1/audit
// and get_audit_log, admins only, the owner's plan deciding, and a user with no role on the
// workspace getting exactly what a missing workspace gives. Workspaces and members are rows
// inserted as the operator tool would write them.
import { env } from "cloudflare:workers";
import { planRequiredMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken, type ToolResult } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-02T09:00:00Z");
const SCOPES = "artifacts:read artifacts:write offline_access";

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

async function client(email: string, scopes = SCOPES): Promise<Client> {
  const h = createHarness();
  const apiAccess = await apiToken(h, email, scopes);
  const mcp = await connect(h, await mcpToken(h, email, scopes));
  const apiCall = (path: string, init?: RequestInit) => api(h, apiAccess, path, init);
  const { userId } = await (await apiCall("/api/v1/me")).json<{ userId: string }>();
  return { userId, apiCall, tool: (name, args) => callTool(mcp, name, args) };
}

const db = () => regionsFromEnv(env).get("default").db;

async function both(who: Client, query: string, args: Record<string, unknown>) {
  const response = await who.apiCall(`/api/v1/audit${query}`);
  const result = await who.tool("get_audit_log", args);
  return {
    api: { status: response.status, body: await response.json<unknown>() },
    mcp: { ok: result.isError !== true, body: result.structuredContent },
  };
}

async function workspace(plan: "team" | "pro" | null) {
  const [admin, editor, member, outsider] = await Promise.all(
    ["admin", "editor", "member", "outsider"].map((role) =>
      client(`audit-${role}-${crypto.randomUUID().slice(0, 8)}@example.test`),
    ),
  );
  const a = admin as Client;
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const slug = id.slice(3, 23);
  await db()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: a.userId, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: a.userId, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: (editor as Client).userId, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: (member as Client).userId, role: "member", updatedAt: NOW },
    ]);
  if (plan) {
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId: id, plan, seats: 5, grantedBy: "test", updatedAt: NOW });
  }
  // One recorded change, written as the services would.
  await db()
    .insert(schema.auditEvents)
    .values({
      id: `ae_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      ownerId: id,
      at: NOW - 1000,
      kind: "member.role_changed",
      actorType: "user",
      actorId: a.userId,
      targetId: (member as Client).userId,
      detail: { from: "editor", to: "member" },
    });
  return {
    id,
    slug,
    admin: a,
    editor: editor as Client,
    member: member as Client,
    outsider: outsider as Client,
  };
}

describe("reading the audit log", () => {
  it("gives an admin the same page through the API and MCP", async () => {
    const t = await workspace("team");
    const answers = await both(t.admin, `?workspace=${t.slug}`, { workspace: t.slug });
    expect(answers.api.status).toBe(200);
    expect(answers.mcp).toEqual({ ok: true, body: answers.api.body });
    expect(answers.api.body).toMatchObject({
      owner: { kind: "workspace", slug: t.slug, name: "Team" },
      retentionDays: 90,
      nextCursor: null,
      events: [
        {
          kind: "member.role_changed",
          actor: { type: "member", id: t.admin.userId },
          target: { type: "member", id: t.member.userId },
          detail: { from: "editor", to: "member" },
        },
      ],
    });
    // Members are named, never by address.
    expect(JSON.stringify(answers.api.body)).not.toContain("@example.test");
  });

  it("refuses editors and members with forbidden, the same body from both", async () => {
    const t = await workspace("team");
    const forbidden = {
      error: { code: "forbidden", message: "Your role on this workspace does not allow this." },
    };
    for (const who of [t.editor, t.member]) {
      const answers = await both(who, `?workspace=${t.slug}`, { workspace: t.slug });
      expect(answers.api).toEqual({ status: 403, body: forbidden });
      expect(answers.mcp).toEqual({ ok: false, body: forbidden });
    }
  });

  it("answers a non-member exactly like a workspace that does not exist", async () => {
    const t = await workspace("team");
    const outsider = await both(t.outsider, `?workspace=${t.slug}`, { workspace: t.slug });
    const missing = await both(t.outsider, "?workspace=no-such-space", {
      workspace: "no-such-space",
    });
    expect(outsider).toEqual(missing);
    expect(outsider.api.status).toBe(404);
  });

  it("answers plan_required for an owner whose plan lacks it, the same from both", async () => {
    const t = await workspace("pro");
    const body = { error: { code: "plan_required", message: planRequiredMessage("audit") } };
    const answers = await both(t.admin, `?workspace=${t.slug}`, { workspace: t.slug });
    expect(answers.api).toEqual({ status: 403, body });
    expect(answers.mcp).toEqual({ ok: false, body });
  });

  it("validates filters the same way, and needs artifacts:read", async () => {
    const t = await workspace("team");
    const bad = await t.admin.apiCall(`/api/v1/audit?workspace=${t.slug}&kind=member.vanished`);
    expect(bad.status).toBe(400);
    const filtered = await (
      await t.admin.apiCall(`/api/v1/audit?workspace=${t.slug}&kind=plan.granted`)
    ).json<{ events: unknown[] }>();
    expect(filtered.events).toEqual([]);
    const tool = await t.admin.tool("get_audit_log", {
      workspace: t.slug,
      kinds: ["plan.granted"],
    });
    expect((tool.structuredContent as { events: unknown[] }).events).toEqual([]);

    const h = createHarness();
    const writeOnly = await apiToken(
      h,
      `audit-writer-${crypto.randomUUID().slice(0, 8)}@example.test`,
      "artifacts:write",
    );
    expect((await api(h, writeOnly, "/api/v1/audit")).status).toBe(403);
  });

  it("passes every filter through, and the tool's text names each kind of actor and target", async () => {
    const t = await workspace("team");
    const row = (id: string, at: number, extra: Record<string, unknown>) => ({
      id,
      ownerId: t.id,
      at,
      kind: "artifact.archived",
      actorType: "user" as const,
      actorId: t.admin.userId,
      targetId: "abcdefghij",
      artifactId: "abcdefghij",
      detail: {},
      ...extra,
    });
    await db()
      .insert(schema.auditEvents)
      .values([
        row("ae_one", NOW - 500, {}),
        row("ae_two", NOW - 400, {
          actorType: "operator",
          actorId: null,
          kind: "plan.removed",
          targetId: t.id,
          artifactId: null,
        }),
        row("ae_three", NOW - 300, {
          actorId: "u_gone",
          kind: "webhook.removed",
          targetId: "wh_1",
          artifactId: null,
        }),
        row("ae_four", NOW - 200, {
          actorType: "system",
          actorId: null,
          kind: "share_link.revoked",
          targetId: null,
          artifactId: null,
        }),
      ]);
    const query = `?workspace=${t.slug}&actor=${t.admin.userId}&target=abcdefghij&from=${new Date(NOW - 600).toISOString()}&to=${new Date(NOW).toISOString()}`;
    const filtered = await (await t.admin.apiCall(`/api/v1/audit${query}`)).json<{
      events: { id: string }[];
    }>();
    expect(filtered.events.map((e) => e.id)).toEqual(["ae_one"]);

    const tool = await t.admin.tool("get_audit_log", { workspace: t.slug, limit: 4 });
    const text = (tool.content as { text: string }[])[0]?.text ?? "";
    expect(text).toMatch(/artifact\.archived by .* abcdefghij/);
    expect(text).toContain("plan.removed by operator plan");
    expect(text).toContain("webhook.removed by a removed member webhook wh_1");
    expect(text).toContain("share_link.revoked by system");
    expect(text).toContain("More events: call again with cursor set to nextCursor.");

    const none = await t.admin.tool("get_audit_log", {
      workspace: t.slug,
      kinds: ["brand.changed"],
    });
    expect((none.content as { text: string }[])[0]?.text).toContain(
      "No audit events in the last 90 days match.",
    );
  });
});
