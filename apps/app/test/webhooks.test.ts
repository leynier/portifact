// /api/v1/webhooks and the MCP webhook tools at their edges (decision 0009): malformed IDs and
// bodies, the session's CSRF rules, Slack webhooks without a secret, a plan without the feature,
// the delivery log and the last attempt, the same through both interfaces.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-10T09:00:00Z");
const SCOPES = "artifacts:read artifacts:share offline_access";

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

async function owner(email: string, plan: "pro" | null = "pro") {
  const h = createHarness();
  const token = await apiToken(h, email, SCOPES);
  const mcp = await connect(h, await mcpToken(h, email, SCOPES));
  const call = (path: string, init?: RequestInit) => api(h, token, path, init);
  const { userId } = await (await call("/api/v1/me")).json<{ userId: string }>();
  if (plan) {
    await regionsFromEnv(env)
      .get("default")
      .db.insert(schema.ownerPlans)
      .values({ ownerId: userId, plan, seats: 1, grantedBy: "test", updatedAt: NOW });
  }
  return {
    call,
    tool: (name: string, args: Record<string, unknown>) => callTool(mcp, name, args),
    userId,
  };
}

const notFound = { error: { code: "not_found", message: "Webhook not found." } };

describe("webhook routes and tools at their edges", () => {
  it("answers a malformed webhook ID like a missing webhook on every route", async () => {
    const o = await owner("webhooks-edges-id@example.test");
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
    const o = await owner("webhooks-edges-body@example.test");
    const created = await o.call(
      "/api/v1/webhooks",
      json("POST", { url: "https://hooks.example.com/in", events: ["artifact.published"] }),
    );
    const { webhook } = await created.json<{ webhook: { id: string; format: string } }>();
    expect(webhook.format).toBe("generic");
    for (const [path, init, field] of [
      [
        "/api/v1/webhooks",
        json("POST", { url: "https://hooks.example.com/in", events: [] }),
        "events",
      ],
      [
        "/api/v1/webhooks",
        json("POST", { url: "https://hooks.example.com/in", events: ["nope"] }),
        "events",
      ],
      ["/api/v1/webhooks", { method: "POST", body: "{" }, ""],
      [
        `/api/v1/webhooks/${webhook.id}`,
        json("PATCH", { events: ["artifact.published", "artifact.published"] }),
        "events",
      ],
      [`/api/v1/webhooks/${webhook.id}`, json("PATCH", { enabled: "yes" }), "enabled"],
    ] as const) {
      const response = await o.call(path, init);
      expect(response.status, path).toBe(400);
      const body = await response.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("invalid_input");
      expect(body.error.message).toContain(field);
    }
    const bad = await o.tool("update_webhook", { webhookId: webhook.id, events: [] });
    expect(bad.isError).toBe(true);
  });

  it("creates a Slack webhook without a secret, the same through MCP", async () => {
    const o = await owner("webhooks-edges-slack@example.test");
    const slack = {
      url: "https://hooks.slack.com/services/T0/B0/x",
      format: "slack",
      events: ["comment.created"],
    };
    const viaApi = await (await o.call("/api/v1/webhooks", json("POST", slack))).json<{
      secret: unknown;
    }>();
    expect(viaApi.secret).toBeNull();
    const viaMcp = await o.tool("create_webhook", slack);
    expect(viaMcp.isError).not.toBe(true);
    expect((viaMcp.structuredContent as { secret: unknown }).secret).toBeNull();
    expect(JSON.stringify(viaMcp.content)).not.toContain("signing secret");
  });

  it("lists a plan without webhooks as paused, the same through both", async () => {
    const o = await owner("webhooks-edges-free@example.test", null);
    const viaApi = await (await o.call("/api/v1/webhooks")).json();
    const viaMcp = await o.tool("list_webhooks", {});
    expect(viaMcp.structuredContent).toEqual(viaApi);
    expect(viaApi).toEqual({ webhooks: [], available: false, limit: 10 });
    expect(JSON.stringify(viaMcp.content)).toContain("does not include webhooks");
  });

  it("shows the delivery log and the last attempt, the same through both", async () => {
    const o = await owner("webhooks-edges-log@example.test");
    const created = await o.call(
      "/api/v1/webhooks",
      json("POST", { url: "https://hooks.example.com/in", events: ["artifact.published"] }),
    );
    const { webhook } = await created.json<{ webhook: { id: string } }>();
    await regionsFromEnv(env)
      .get("default")
      .db.insert(schema.webhookDeliveries)
      .values([
        {
          webhookId: webhook.id,
          ownerId: o.userId,
          deliveryId: `whd_${"a".repeat(32)}`,
          attempt: 1,
          at: NOW - 60_000,
          outcome: "failed",
          status: null,
          error: "timeout",
        },
        {
          webhookId: webhook.id,
          ownerId: o.userId,
          deliveryId: `whd_${"a".repeat(32)}`,
          attempt: 2,
          at: NOW,
          outcome: "delivered",
          status: 200,
          error: null,
        },
      ]);
    const log = await (await o.call(`/api/v1/webhooks/${webhook.id}/deliveries`)).json();
    const viaMcp = await o.tool("list_webhook_deliveries", { webhookId: webhook.id });
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
    const listed = await o.tool("list_webhooks", {});
    expect(listed.structuredContent).toEqual(list);
  });
});
