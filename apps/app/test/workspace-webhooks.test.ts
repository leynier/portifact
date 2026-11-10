// A workspace's webhooks through /api/v1/webhooks?workspace=<slug> (decision 0009): its admins
// manage them through the dashboard session and the Portifact CLI's `credentials:manage` token
// alike, with the same answers; editors and members get `forbidden`, a non-member what a missing
// workspace gives, and a service token is refused on every management route. The plan gate and the
// per-owner limits are the workspace's, never the admin's personal plan.
import { env } from "cloudflare:workers";
import { planRequiredMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-10T09:00:00Z");
const MANAGE = "artifacts:read credentials:manage offline_access";
const HOOK = { url: "https://hooks.example.com/in", events: ["review.completed"] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const db = () => regionsFromEnv(env).get("default").db;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const dashboardInit = (cookie: string, method: string, body?: unknown): RequestInit => ({
  method,
  headers: {
    cookie,
    "sec-fetch-site": "same-origin",
    ...(method === "GET" ? {} : { origin: ORIGIN }),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

interface Caller {
  userId: string;
  cli: (path: string, init?: RequestInit) => Promise<Response>;
  dashboard: (path: string, method?: string, body?: unknown) => Promise<Response>;
}

async function caller(h: Harness, email: string): Promise<Caller> {
  const token = await apiToken(h, email, MANAGE);
  const cli = (path: string, init?: RequestInit) => api(h, token, path, init);
  const { userId } = await (await cli("/api/v1/me")).json<{ userId: string }>();
  const cookie = await h.signIn(email);
  return {
    userId,
    cli,
    dashboard: (path, method = "GET", body) => h.request(path, dashboardInit(cookie, method, body)),
  };
}

async function team(plan: "team" | null = "team") {
  const h = createHarness();
  const tag = crypto.randomUUID().slice(0, 8);
  const [admin, editor, member, outsider] = await Promise.all(
    ["admin", "editor", "member", "outsider"].map((role) =>
      caller(h, `wsw-${role}-${tag}@example.test`),
    ),
  );
  const a = admin as Caller;
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const slug = `w${id.slice(3, 22)}`;
  await db()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: a.userId, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: a.userId, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: (editor as Caller).userId, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: (member as Caller).userId, role: "member", updatedAt: NOW },
    ]);
  if (plan) {
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId: id, plan, seats: 5, grantedBy: "test", updatedAt: NOW });
  }
  return {
    h,
    id,
    slug,
    admin: a,
    editor: editor as Caller,
    member: member as Caller,
    outsider: outsider as Caller,
  };
}

/** Every webhook operation, in the workspace, through the CLI's token. */
function operations(slug: string, webhookId: string): [string, string, RequestInit][] {
  const q = `?workspace=${slug}`;
  return [
    ["list", `/api/v1/webhooks${q}`, json("GET")],
    ["create", `/api/v1/webhooks${q}`, json("POST", HOOK)],
    ["change", `/api/v1/webhooks/${webhookId}${q}`, json("PATCH", { enabled: false })],
    ["test", `/api/v1/webhooks/${webhookId}/test${q}`, json("POST")],
    ["deliveries", `/api/v1/webhooks/${webhookId}/deliveries${q}`, json("GET")],
    ["remove", `/api/v1/webhooks/${webhookId}${q}`, json("DELETE")],
  ];
}

describe("a workspace's webhooks", () => {
  it("lets an admin manage them through the dashboard and the CLI with the same answers", async () => {
    const t = await team();
    const q = `?workspace=${t.slug}`;
    const viaCli = await t.admin.cli(`/api/v1/webhooks${q}`, json("POST", HOOK));
    expect(viaCli.status).toBe(201);
    const created = await viaCli.json<{ webhook: { id: string; events: string[] } }>();
    expect(created.webhook.events).toEqual(["review.completed"]);
    const [row] = await db()
      .select({ ownerId: schema.webhooks.ownerId })
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, created.webhook.id));
    expect(row?.ownerId).toBe(t.id);
    const viaDashboard = await t.admin.dashboard(`/api/v1/webhooks${q}`, "POST", HOOK);
    expect(viaDashboard.status).toBe(201);
    // Parity: both list the same body; the personal space lists none of them.
    const cliList = await (await t.admin.cli(`/api/v1/webhooks${q}`)).json();
    const dashboardList = await (await t.admin.dashboard(`/api/v1/webhooks${q}`)).json();
    expect(dashboardList).toEqual(cliList);
    expect(cliList).toMatchObject({ webhooks: [{}, {}], available: true });
    expect(await (await t.admin.cli("/api/v1/webhooks")).json()).toMatchObject({ webhooks: [] });
    const id = created.webhook.id;
    const ops = operations(t.slug, id);
    // A test first: a disabled webhook refuses one.
    for (const [name, path, init] of [ops[3], ops[4], ops[2], ops[5]] as [
      string,
      string,
      RequestInit,
    ][]) {
      const viaDash = await t.admin.dashboard(
        path,
        init.method,
        init.body ? JSON.parse(String(init.body)) : undefined,
      );
      expect(viaDash.status, `dashboard ${name}`).toBeLessThan(300);
    }
    // The CLI sees the removal, and the same ID in the personal space is a missing webhook.
    const gone = await t.admin.cli(`/api/v1/webhooks/${id}${q}`, json("DELETE"));
    expect(gone.status).toBe(404);
  });

  it("refuses editors and members with forbidden and non-members like a missing workspace", async () => {
    const t = await team();
    const created = await (
      await t.admin.cli(`/api/v1/webhooks?workspace=${t.slug}`, json("POST", HOOK))
    ).json<{ webhook: { id: string } }>();
    const missing = await (
      await t.outsider.cli("/api/v1/webhooks?workspace=nosuchworkspace0", json("GET"))
    ).json();
    for (const [name, path, init] of operations(t.slug, created.webhook.id)) {
      for (const who of [t.editor, t.member]) {
        const response = await who.cli(path, init);
        expect(response.status, `${name}`).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
        const dashboard = await who.dashboard(
          path,
          init.method,
          init.body ? JSON.parse(String(init.body)) : undefined,
        );
        expect(dashboard.status, `dashboard ${name}`).toBe(403);
      }
      const outside = await t.outsider.cli(path, init);
      expect(outside.status, `outsider ${name}`).toBe(404);
      expect(await outside.json()).toEqual(missing);
    }
    // Nothing was changed by the refusals.
    const list = await (await t.admin.cli(`/api/v1/webhooks?workspace=${t.slug}`)).json<{
      webhooks: { state: string }[];
    }>();
    expect(list.webhooks.map((w) => w.state)).toEqual(["active"]);
  });

  it("refuses a workspace's service token on every management route", async () => {
    const t = await team();
    const created = await (
      await t.admin.cli(`/api/v1/webhooks?workspace=${t.slug}`, json("POST", HOOK))
    ).json<{ webhook: { id: string } }>();
    const secret = `pfst_${"W".repeat(43)}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    await db()
      .insert(schema.serviceTokens)
      .values({
        id: `st_${crypto.randomUUID().replaceAll("-", "")}`,
        workspaceId: t.id,
        label: "CI",
        role: "editor",
        scopes: "artifacts:read artifacts:write artifacts:share",
        tokenHash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
        createdBy: t.admin.userId,
        createdAt: NOW,
        expiresAt: NOW + 86_400_000,
      });
    const token = (path: string, init: RequestInit) =>
      t.h.request(path, {
        ...init,
        headers: { ...(init.headers as object), authorization: `Bearer ${secret}` },
      });
    for (const [name, path, init] of operations(t.slug, created.webhook.id)) {
      const response = await token(path, init);
      // Reads take the token and refuse its role; management never takes it at all.
      const read = name === "list" || name === "deliveries";
      expect(response.status, name).toBe(read ? 403 : 401);
    }
  });

  it("gates on the workspace's plan, not the admin's", async () => {
    const t = await team(null);
    await db().insert(schema.ownerPlans).values({
      ownerId: t.admin.userId,
      plan: "pro",
      seats: 1,
      grantedBy: "test",
      updatedAt: NOW,
    });
    const refused = await t.admin.cli(`/api/v1/webhooks?workspace=${t.slug}`, json("POST", HOOK));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: { code: "plan_required", message: planRequiredMessage("webhooks") },
    });
    expect(await (await t.admin.cli(`/api/v1/webhooks?workspace=${t.slug}`)).json()).toMatchObject({
      available: false,
    });
    expect((await t.admin.cli("/api/v1/webhooks", json("POST", HOOK))).status).toBe(201);
  });

  it("lists the same webhooks and deliveries through MCP's read tools, which manage nothing", async () => {
    const t = await team();
    const q = `?workspace=${t.slug}`;
    const created = await (await t.admin.cli(`/api/v1/webhooks${q}`, json("POST", HOOK))).json<{
      webhook: { id: string };
    }>();
    const email =
      (
        await db()
          .select({ email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, t.admin.userId))
      )[0]?.email ?? "";
    const mcp = await connect(t.h, await mcpToken(t.h, email, "artifacts:read"));
    const list = await callTool(mcp, "list_webhooks", { workspace: t.slug });
    expect(list.structuredContent).toEqual(
      await (await t.admin.cli(`/api/v1/webhooks${q}`)).json(),
    );
    const deliveries = await callTool(mcp, "list_webhook_deliveries", {
      webhookId: created.webhook.id,
      workspace: t.slug,
    });
    expect(deliveries.structuredContent).toEqual(
      await (await t.admin.cli(`/api/v1/webhooks/${created.webhook.id}/deliveries${q}`)).json(),
    );
    // In the personal space the same webhook is missing, and a malformed slug is a missing workspace.
    expect(
      (await callTool(mcp, "list_webhook_deliveries", { webhookId: created.webhook.id }))
        .structuredContent,
    ).toMatchObject({ error: { code: "not_found" } });
    expect(
      (await callTool(mcp, "list_webhooks", { workspace: "Not a slug!" })).structuredContent,
    ).toEqual({ error: { code: "not_found", message: "Workspace not found." } });
    expect(
      (await callTool(mcp, "list_webhooks", { workspace: "nosuchworkspace0" })).structuredContent,
    ).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers a malformed slug like a missing workspace", async () => {
    const t = await team();
    const response = await t.admin.cli("/api/v1/webhooks?workspace=Not%20a%20slug!");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Workspace not found." },
    });
  });
});
