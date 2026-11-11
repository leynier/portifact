// GET /api/v1/grace-forecast (decision 0022, second delivery): what a running grace lets go, for
// the dashboard's "Download your data" page and `portifact export --dry-run`. A read authorized
// like the usage body; MCP has no tool for it, since moving a space's data out is not something an
// agent does inline.
import { env } from "cloudflare:workers";
import { GRACE_FORECAST_LIMITS, GraceForecastView } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, ORIGIN } from "./harness.ts";
import { api, apiToken, connect, mcpToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-11T09:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the grace forecast route", () => {
  it("answers the caller's own space, with a bearer token and with the dashboard's session", async () => {
    const h = createHarness();
    const token = await apiToken(h, "forecast@example.test");
    const me = await (await api(h, token, "/api/v1/me")).json<{ userId: string }>();
    const none = await api(h, token, "/api/v1/grace-forecast");
    expect(none.status).toBe(200);
    expect(GraceForecastView.parse(await none.json())).toEqual({
      ownerId: me.userId,
      grace: null,
      kinds: [],
    });

    // A Pro plan that ended yesterday: its grace runs for 59 more days.
    await env.DB.prepare(
      "insert into owner_plans (owner_id, plan, seats, valid_until, granted_by, updated_at) values (?, 'pro', 1, ?, 'test', ?)",
    )
      .bind(me.userId, NOW - DAY, NOW)
      .run();
    const held = GraceForecastView.parse(
      await (await api(h, token, "/api/v1/grace-forecast")).json(),
    );
    expect(held.grace).toMatchObject({
      plan: "pro",
      until: new Date(NOW + 59 * DAY).toISOString(),
    });

    const cookie = await h.signIn("forecast@example.test");
    const viaSession = await h.request("/api/v1/grace-forecast", {
      headers: { cookie, "sec-fetch-site": "same-origin", origin: ORIGIN },
    });
    expect(viaSession.status).toBe(200);
    expect(await viaSession.json()).toEqual(held);
  });

  it("answers a workspace the caller is not in like a missing one", async () => {
    const h = createHarness();
    const token = await apiToken(h, "forecast-ws@example.test");
    const answer = await api(h, token, "/api/v1/grace-forecast?workspace=elsewhere");
    expect(answer.status).toBe(404);
  });

  it("answers 429 past its limit per person", async () => {
    const h = createHarness();
    const token = await apiToken(h, "forecast-limit@example.test");
    for (let i = 0; i < GRACE_FORECAST_LIMITS.perActorPerMinute; i += 1) {
      expect((await api(h, token, "/api/v1/grace-forecast")).status).toBe(200);
    }
    const refused = await api(h, token, "/api/v1/grace-forecast");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("has no MCP tool", async () => {
    const h = createHarness();
    const client = await connect(h, await mcpToken(h, "forecast-mcp@example.test"));
    const { tools } = await client.listTools();
    expect(tools.some((tool) => /grace|export_space|download_space/.test(tool.name))).toBe(false);
  });
});
