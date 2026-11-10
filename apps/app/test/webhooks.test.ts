// /api/v1/webhooks at its edges (decision 0009 and decision 0003's addendum): only the dashboard
// session and the Portifact CLI's `credentials:manage` token manage webhooks, each recorded as
// where a webhook came from; any `artifacts:read` client lists them; a switched-off deployment
// refuses to offer them; malformed IDs and bodies; Slack without a secret; the delivery log.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webhookService } from "../src/api/webhooks.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-10T09:00:00Z");
const MANAGE = "artifacts:read credentials:manage offline_access";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** What the dashboard's fetch sends: the session cookie and same-origin fetch metadata. */
const dashboard = (cookie: string, method: string, body?: unknown): RequestInit => ({
  method,
  headers: {
    cookie,
    "sec-fetch-site": "same-origin",
    ...(method === "GET" ? {} : { origin: ORIGIN }),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const HOOK = { url: "https://hooks.example.com/in", events: ["artifact.published"] };

async function pro(h: Harness, email: string) {
  const token = await apiToken(h, email, MANAGE);
  const call = (path: string, init?: RequestInit) => api(h, token, path, init);
  const { userId } = await (await call("/api/v1/me")).json<{ userId: string }>();
  await regionsFromEnv(env)
    .get("default")
    .db.insert(schema.ownerPlans)
    .values({ ownerId: userId, plan: "pro", seats: 1, grantedBy: "test", updatedAt: NOW })
    .onConflictDoNothing();
  return { call, userId };
}

const notFound = { error: { code: "not_found", message: "Webhook not found." } };

describe("who manages webhooks", () => {
  it("lets the dashboard session and the CLI's credentials:manage token manage them, and records which", async () => {
    const h = createHarness();
    const o = await pro(h, "webhooks-who@example.test");
    const viaCli = await (await o.call("/api/v1/webhooks", json("POST", HOOK))).json<{
      webhook: { id: string; createdVia: string; createdBy: string | null };
    }>();
    expect(viaCli.webhook).toMatchObject({ createdVia: "portifact-cli" });
    expect(viaCli.webhook.createdBy).toEqual(expect.any(String));
    const cookie = await h.signIn("webhooks-who@example.test");
    const viaDashboard = await h.request("/api/v1/webhooks", dashboard(cookie, "POST", HOOK));
    expect(viaDashboard.status).toBe(201);
    expect(await viaDashboard.json()).toMatchObject({ webhook: { createdVia: "dashboard" } });
    const removed = await h.request(
      `/api/v1/webhooks/${viaCli.webhook.id}`,
      dashboard(cookie, "DELETE"),
    );
    expect(removed.status).toBe(200);
    // A session request from anywhere but the app's own pages is refused.
    const crossSite = await h.request("/api/v1/webhooks", {
      ...dashboard(cookie, "POST", HOOK),
      headers: {
        ...(dashboard(cookie, "POST", HOOK).headers as object),
        origin: "https://evil.example",
      },
    });
    expect(crossSite.status).toBe(403);
  });

  it("refuses an MCP client: it has no tool that creates, changes, tests or removes one", async () => {
    const h = createHarness();
    await pro(h, "webhooks-mcp@example.test");
    const mcp = await connect(h, await mcpToken(h, "webhooks-mcp@example.test", "artifacts:read"));
    const { tools } = await mcp.listTools();
    expect(
      tools
        .map((tool) => tool.name)
        .filter((name) => name.includes("webhook"))
        .sort(),
    ).toEqual(["list_webhook_deliveries", "list_webhooks"]);
    for (const tool of tools.filter((t) => t.name.includes("webhook"))) {
      expect(tool.description, tool.name).toContain("never through MCP");
    }
    expect((await callTool(mcp, "list_webhooks", {})).structuredContent).toMatchObject({
      webhooks: [],
    });
  });
});

describe("a switched-off deployment", () => {
  it("offers nothing without WEBHOOKS_ENABLED or without a key", async () => {
    expect(webhookService({ ...env, WEBHOOKS_ENABLED: "true" } as never)).toEqual({
      enabled: true,
    });
    for (const off of [
      { WEBHOOKS_ENABLED: undefined },
      { WEBHOOKS_ENABLED: "1" },
      { WEBHOOKS_ENABLED: "true", WEBHOOK_KEY: undefined },
    ]) {
      expect(webhookService({ ...env, ...off } as never)).toEqual({ enabled: false });
    }
    const h = createHarness({ env: { WEBHOOKS_ENABLED: undefined } });
    const o = await pro(h, "webhooks-off@example.test");
    const refused = await o.call("/api/v1/webhooks", json("POST", HOOK));
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: { code: "capacity_unavailable", message: "Webhooks are not available yet." },
    });
    expect(await (await o.call("/api/v1/webhooks")).json()).toMatchObject({
      serviceAvailable: false,
      webhooks: [],
    });
  });
});

describe("webhook routes at their edges", () => {
  it("answers a malformed webhook ID like a missing webhook on every route", async () => {
    const o = await pro(createHarness(), "webhooks-edges-id@example.test");
    for (const [path, init] of [
      ["/api/v1/webhooks/nope", json("PATCH", { enabled: false })],
      ["/api/v1/webhooks/nope", json("DELETE")],
      ["/api/v1/webhooks/nope/test", json("POST")],
      ["/api/v1/webhooks/nope/deliveries", json("GET")],
    ] as const) {
      const response = await o.call(path, init);
      expect(response.status, `${init.method} ${path}`).toBe(404);
      expect(await response.json(), path).toEqual(notFound);
    }
  });

  it("refuses bodies that are not valid, with the field named", async () => {
    const o = await pro(createHarness(), "webhooks-edges-body@example.test");
    const created = await o.call("/api/v1/webhooks", json("POST", HOOK));
    const { webhook } = await created.json<{ webhook: { id: string; format: string } }>();
    expect(webhook.format).toBe("generic");
    for (const [path, init, field] of [
      ["/api/v1/webhooks", json("POST", { ...HOOK, events: [] }), "events"],
      ["/api/v1/webhooks", json("POST", { ...HOOK, events: ["nope"] }), "events"],
      ["/api/v1/webhooks", { method: "POST", body: "{" }, ""],
      [`/api/v1/webhooks/${webhook.id}`, json("PATCH", { enabled: "yes" }), "enabled"],
      [`/api/v1/webhooks/${webhook.id}`, json("PATCH", {}), ""],
    ] as const) {
      const response = await o.call(path, init);
      expect(response.status, path).toBe(400);
      const body = await response.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("invalid_input");
      expect(body.error.message).toContain(field);
    }
  });

  it("creates a Slack webhook without a secret", async () => {
    const o = await pro(createHarness(), "webhooks-edges-slack@example.test");
    const slack = {
      url: "https://hooks.slack.com/services/T0/B0/x",
      format: "slack",
      events: ["comment.created"],
    };
    const created = await o.call("/api/v1/webhooks", json("POST", slack));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect((await created.json<{ secret: unknown }>()).secret).toBeNull();
  });

  it("shows the delivery log and the last attempt, the same through MCP", async () => {
    const h = createHarness();
    const o = await pro(h, "webhooks-edges-log@example.test");
    const created = await o.call("/api/v1/webhooks", json("POST", HOOK));
    const { webhook } = await created.json<{ webhook: { id: string } }>();
    const entry = (
      attempt: number,
      at: number,
      outcome: "delivered" | "failed",
      status: number | null,
      error: string | null,
    ) => ({
      webhookId: webhook.id,
      ownerId: o.userId,
      deliveryId: `whd_${"a".repeat(32)}`,
      attempt,
      at,
      outcome,
      status,
      error,
    });
    await regionsFromEnv(env)
      .get("default")
      .db.insert(schema.webhookDeliveries)
      .values([
        entry(1, NOW - 60_000, "failed", null, "timeout"),
        entry(2, NOW, "delivered", 200, null),
      ]);
    const log = await (await o.call(`/api/v1/webhooks/${webhook.id}/deliveries`)).json();
    const mcp = await connect(
      h,
      await mcpToken(h, "webhooks-edges-log@example.test", "artifacts:read"),
    );
    const viaMcp = await callTool(mcp, "list_webhook_deliveries", { webhookId: webhook.id });
    expect(viaMcp.structuredContent).toEqual(log);
    expect(log).toMatchObject({
      attempts: [
        {
          attempt: 2,
          outcome: "delivered",
          status: 200,
          error: null,
          at: new Date(NOW).toISOString(),
        },
        { attempt: 1, outcome: "failed", status: null, error: "timeout" },
      ],
    });
    const text = JSON.stringify(viaMcp.content);
    expect(text).toContain("attempt 2: delivered 200");
    expect(text).toContain("attempt 1: failed (timeout)");
    const list = await (await o.call("/api/v1/webhooks")).json<{
      webhooks: { lastAttempt: unknown }[];
    }>();
    expect(list.webhooks[0]?.lastAttempt).toMatchObject({ attempt: 2, outcome: "delivered" });
    expect((await callTool(mcp, "list_webhooks", {})).structuredContent).toEqual(list);
  });
});

describe("more edges", () => {
  it("lists a disabled webhook of a lapsed plan on a switched-off deployment, through MCP", async () => {
    const h = createHarness();
    const o = await pro(h, "webhooks-more-mcp@example.test");
    const created = await o.call("/api/v1/webhooks", json("POST", HOOK));
    const { webhook } = await created.json<{ webhook: { id: string } }>();
    const disabled = await o.call(
      `/api/v1/webhooks/${webhook.id}`,
      json("PATCH", { enabled: false }),
    );
    expect(await disabled.json()).toMatchObject({
      state: "disabled",
      disabledAt: new Date(NOW).toISOString(),
    });
    await env.DB.prepare("delete from owner_plans where owner_id = ?").bind(o.userId).run();
    const off = createHarness({ env: { WEBHOOKS_ENABLED: undefined } });
    const mcp = await connect(
      off,
      await mcpToken(off, "webhooks-more-mcp@example.test", "artifacts:read"),
    );
    const listed = await callTool(mcp, "list_webhooks", {});
    expect(listed.structuredContent).toMatchObject({ available: false, serviceAvailable: false });
    const text = JSON.stringify(listed.content);
    expect(text).toContain(`${webhook.id} disabled (manual): generic to hooks.example.com`);
    expect(text).toContain("does not include webhooks");
    expect(text).toContain("does not offer webhooks yet");
  });

  it("answers removing a missing webhook like any missing one, and an unknown session like none", async () => {
    const h = createHarness();
    const o = await pro(h, "webhooks-more-missing@example.test");
    const gone = await o.call(`/api/v1/webhooks/wh_${"0".repeat(32)}`, json("DELETE"));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual(notFound);
    const stale = await h.request(
      "/api/v1/webhooks",
      dashboard("__Host-pf.session_token=unknown.session", "POST", HOOK),
    );
    expect(stale.status).toBe(401);
  });
});
