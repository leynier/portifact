// Restore markers of the identity tables (migration 0071) through real Better Auth flows: a
// refresh writes one marker (the rotated-out token), a family invalidation marks only the rows
// that were still live, and a sign-out survives a D1 Time Travel restore once `applyTombstones`
// runs, while the CLI's offline tokens behave as they did before it.
import { env } from "cloudflare:workers";
import { regionsFromEnv } from "@portifact/db";
import { applyTombstones, exportTombstones } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import {
  approveDevice,
  authorizeWithPkce,
  callApi,
  callMcp,
  exchangeCode,
  pollDeviceToken,
  registerMcpClient,
  requestDeviceCode,
  type TokenResponse,
} from "./flows.ts";
import { createHarness, form, type Harness, ORIGIN } from "./harness.ts";

const TABLES = [
  "sessions",
  "oauth_access_tokens",
  "oauth_refresh_tokens",
  "oauth_consents",
  "tombstones",
] as const;

type Snapshot = Record<string, Record<string, unknown>[]>;

/** The identity rows and markers as a restore point holds them. */
async function snapshot(): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const table of TABLES) {
    out[table] = (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results as Record<
      string,
      unknown
    >[];
  }
  return out;
}

/** What a D1 Time Travel restore to `point` does to those tables. */
async function restore(point: Snapshot) {
  await env.DB.prepare("PRAGMA defer_foreign_keys = on").run();
  for (const table of [
    "oauth_access_tokens",
    "oauth_refresh_tokens",
    "oauth_consents",
    "sessions",
    "tombstones",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const table of [
    "sessions",
    "oauth_consents",
    "oauth_refresh_tokens",
    "oauth_access_tokens",
    "tombstones",
  ]) {
    for (const row of point[table] ?? []) {
      const columns = Object.keys(row);
      await env.DB.prepare(
        `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
        .bind(...columns.map((c) => row[c] ?? null))
        .run();
    }
  }
}

const count = async (query: string, ...bind: unknown[]) =>
  (
    await env.DB.prepare(query)
      .bind(...bind)
      .first<{ n: number }>()
  )?.n ?? 0;
const tokenMarkers = () => count("SELECT count(*) AS n FROM tombstones WHERE kind = 'oauth_token'");
const dashboard = (cookie: string) => ({
  headers: { cookie, "sec-fetch-site": "same-origin" },
});
const refresh = (h: Harness, clientId: string, token: string) =>
  h.request(
    "/api/auth/oauth2/token",
    form({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }),
  );

async function mcpClient(h: Harness, cookie: string) {
  const clientId = await registerMcpClient(h);
  const { code, verifier } = await authorizeWithPkce(h, { clientId, cookie });
  const tokens = await (await exchangeCode(h, { clientId, code, verifier })).json<TokenResponse>();
  return { clientId, access: tokens.access_token, refresh: tokens.refresh_token ?? "" };
}

describe("restore markers through Better Auth", () => {
  it("writes exactly one marker per refresh, for the rotated-out token", async () => {
    const h = createHarness();
    const cookie = await h.signIn("markers-refresh@example.test");
    const mcp = await mcpClient(h, cookie);
    let token = mcp.refresh;
    for (let i = 1; i <= 3; i++) {
      const before = await tokenMarkers();
      const response = await refresh(h, mcp.clientId, token);
      expect(response.status).toBe(200);
      const previous = token;
      token = (await response.json<TokenResponse>()).refresh_token ?? "";
      expect((await tokenMarkers()) - before).toBe(1);
      // The marker names the rotated-out row, which Better Auth keeps revoked.
      const marked = await count(
        "SELECT count(*) AS n FROM tombstones t JOIN oauth_refresh_tokens r ON r.id = t.id WHERE t.kind = 'oauth_token' AND r.revoked IS NOT NULL AND r.client_id = ?",
        mcp.clientId,
      );
      expect(marked).toBe(i);
      expect(previous).not.toBe(token);
    }
  });

  it("marks only the rows still live when a reused token invalidates the family", async () => {
    const h = createHarness();
    const cookie = await h.signIn("markers-family@example.test");
    const mcp = await mcpClient(h, cookie);
    const first = mcp.refresh;
    let token = first;
    for (let i = 0; i < 3; i++) {
      const response = await refresh(h, mcp.clientId, token);
      expect(response.status).toBe(200);
      token = (await response.json<TokenResponse>()).refresh_token ?? "";
    }
    const live = async () =>
      (await count(
        "SELECT count(*) AS n FROM oauth_refresh_tokens WHERE client_id = ? AND revoked IS NULL",
        mcp.clientId,
      )) +
      (await count(
        "SELECT count(*) AS n FROM oauth_access_tokens WHERE client_id = ? AND revoked IS NULL",
        mcp.clientId,
      ));
    const liveBefore = await live();
    const rotated = await count(
      "SELECT count(*) AS n FROM oauth_refresh_tokens WHERE client_id = ? AND revoked IS NOT NULL",
      mcp.clientId,
    );
    expect(rotated).toBe(3);
    // Their markers are gone, as for rows revoked before migration 0071 or whose markers the
    // window's prune removed: a revoked row must still write none when it is deleted.
    await env.DB.prepare(
      "DELETE FROM tombstones WHERE kind = 'oauth_token' AND id IN (SELECT id FROM oauth_refresh_tokens WHERE client_id = ? AND revoked IS NOT NULL)",
    )
      .bind(mcp.clientId)
      .run();
    const before = await tokenMarkers();
    // Presenting a rotated-out token is a reuse: Better Auth deletes the whole family.
    expect((await refresh(h, mcp.clientId, first)).status).toBe(400);
    expect(
      await count(
        "SELECT count(*) AS n FROM oauth_refresh_tokens WHERE client_id = ?",
        mcp.clientId,
      ),
    ).toBe(0);
    // Only the rows that were still live get a marker; the three revoked ones get none.
    expect((await tokenMarkers()) - before).toBe(liveBefore);
  });

  it("keeps a sign-out through a restore, and leaves the CLI's offline tokens as they were", async () => {
    const h = createHarness();
    const cookie = await h.signIn("markers-restore@example.test");
    // The CLI's tokens come from the device flow, bound to no browser session.
    const device = await requestDeviceCode(h, CLI_CLIENT_ID, "artifacts:read offline_access");
    await approveDevice(h, cookie, device.user_code);
    const cli = await (
      await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code)
    ).json<TokenResponse>();
    const mcp = await mcpClient(h, cookie);
    const rotated = await refresh(h, mcp.clientId, mcp.refresh);
    expect(rotated.status).toBe(200);
    const current = await rotated.json<TokenResponse>();
    expect((await callMcp(h, current.access_token)).status).toBe(200);

    // The restore point: everything live, the rotated-out refresh token already marked.
    const point = await snapshot();

    const signedOut = await h.request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    });
    expect(signedOut.status).toBe(200);
    expect((await h.request("/api/v1/account/sessions", dashboard(cookie))).status).toBe(401);
    expect((await callMcp(h, current.access_token)).status).toBe(401);
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers.some((m) => m.kind === "session")).toBe(true);

    // The restore brings the session and the tokens back usable.
    await restore(point);
    expect((await h.request("/api/v1/account/sessions", dashboard(cookie))).status).toBe(200);
    expect((await callMcp(h, current.access_token)).status).toBe(200);

    const applied = await applyTombstones(regionsFromEnv(env), markers, Date.now());
    expect(applied.sessions).toBeGreaterThan(0);
    expect(applied.oauthTokens).toBeGreaterThan(0);
    const again = await applyTombstones(regionsFromEnv(env), markers, Date.now());
    expect([again.sessions, again.oauthTokens, again.oauthGrants]).toEqual([0, 0, 0]);

    // Ended again: the browser session, the MCP access token and the rotated-out refresh token.
    expect((await h.request("/api/v1/account/sessions", dashboard(cookie))).status).toBe(401);
    expect((await callMcp(h, current.access_token)).status).toBe(401);
    expect((await refresh(h, mcp.clientId, mcp.refresh)).status).toBe(400);
    // The CLI's offline tokens work as before the restore: signing out never touched them.
    expect((await callApi(h, cli.access_token)).status).toBe(200);
    expect((await refresh(h, CLI_CLIENT_ID, cli.refresh_token ?? "")).status).toBe(200);
  });
});
