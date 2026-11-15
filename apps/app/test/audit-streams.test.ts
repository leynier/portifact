// Audit streams through the app Worker (decision 0019): every route answers only the dashboard's
// session (every bearer token refused, the CLI's `credentials:manage` included, and cross-origin
// requests), a workspace's streams only its admins, and without the webhook switch nothing is
// offered. Nothing here sends a request anywhere: delivery is the jobs Worker's.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-02T09:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const db = () => regionsFromEnv(env).get("default").db;

async function onEnterprise(ownerId: string) {
  await db()
    .global.insert(schema.ownerPlans)
    .values({ ownerId, plan: "enterprise", seats: 3, grantedBy: "test", updatedAt: NOW })
    .onConflictDoUpdate({ target: schema.ownerPlans.ownerId, set: { plan: "enterprise" } });
}

async function sessionOf(h: Harness, email: string) {
  const cookie = await h.signIn(email);
  return (path: string, init: RequestInit = {}) =>
    h.request(path, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        cookie,
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
      },
    });
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const CREATE = { label: "SIEM", url: "https://siem.example.com/collect?token=abc", start: "now" };

async function userIdOf(h: Harness, email: string) {
  const token = await apiToken(h, email, "artifacts:read");
  return (await (await api(h, token, "/api/v1/me")).json<{ userId: string }>()).userId;
}

describe("audit streams through the dashboard session", () => {
  it("creates, lists, changes, tests, reads the log of and removes a stream; the secret once", async () => {
    const h = createHarness();
    const email = "streams-admin@example.test";
    const session = await sessionOf(h, email);
    await onEnterprise(await userIdOf(h, email));

    const created = await session("/api/v1/audit/streams", json("POST", CREATE));
    expect(created.status).toBe(201);
    const body = await created.json<{ stream: { id: string; host: string }; secret: string }>();
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.stream.host).toBe("siem.example.com");
    expect(JSON.stringify(body.stream)).not.toContain("token=abc");
    const id = body.stream.id;

    const listed = await (await session("/api/v1/audit/streams")).json<unknown>();
    expect(listed).toMatchObject({
      streams: [{ id, label: "SIEM", state: "active" }],
      available: true,
      serviceAvailable: true,
      euOwner: false,
      limit: 2,
      settleMinutes: 2,
    });
    expect(JSON.stringify(listed)).not.toMatch(/whsec_|token=abc/);

    const paused = await session(`/api/v1/audit/streams/${id}`, json("PATCH", { state: "paused" }));
    expect(await paused.json()).toMatchObject({ stream: { state: "paused" }, secret: null });
    const rotated = await session(
      `/api/v1/audit/streams/${id}`,
      json("PATCH", { rotateSecret: true }),
    );
    const next = await rotated.json<{ secret: string }>();
    expect(next.secret).toMatch(/^whsec_/);
    expect(next.secret).not.toBe(body.secret);

    const tested = await session(`/api/v1/audit/streams/${id}/test`, json("POST"));
    expect(tested.status).toBe(202);
    expect(await tested.json()).toEqual({ streamId: id, queued: true });
    const log = await session(`/api/v1/audit/streams/${id}/deliveries`);
    expect(await log.json()).toEqual({ streamId: id, attempts: [], retentionDays: 7 });

    expect((await session("/api/v1/audit/streams/as_bad")).status).toBe(404);
    expect(
      (await session(`/api/v1/audit/streams/as_${"0".repeat(32)}`, json("DELETE"))).status,
    ).toBe(404);
    const removed = await session(`/api/v1/audit/streams/${id}`, json("DELETE"));
    expect(await removed.json()).toEqual({ streamId: id, removed: true });
    expect(await (await session("/api/v1/audit/streams")).json()).toMatchObject({ streams: [] });
  });

  it("refuses every bearer token, the CLI's credentials:manage one included, and cross-origin requests", async () => {
    const h = createHarness();
    const email = "streams-bearer@example.test";
    await onEnterprise(await userIdOf(h, email));
    const cli = await apiToken(h, email, "artifacts:read credentials:manage");
    const product = await apiToken(h, email, "artifacts:read artifacts:write artifacts:share");
    for (const token of [cli, product]) {
      for (const [path, init] of [
        ["/api/v1/audit/streams", json("GET")],
        ["/api/v1/audit/streams", json("POST", CREATE)],
        [`/api/v1/audit/streams/as_${"0".repeat(32)}`, json("DELETE")],
        [`/api/v1/audit/streams/as_${"0".repeat(32)}/deliveries`, json("GET")],
      ] as const) {
        const response = await api(h, token, path, init);
        expect(response.status, path).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
      }
    }
    const cookie = await h.signIn(email);
    const crossSite = await h.request("/api/v1/audit/streams", {
      ...json("POST", CREATE),
      headers: {
        "content-type": "application/json",
        cookie,
        "sec-fetch-site": "cross-site",
        origin: "https://evil.test",
      },
    });
    expect(crossSite.status).toBe(403);
    expect((await h.request("/api/v1/audit/streams")).status).toBe(401);
  });

  it("answers a workspace's streams only to its admins, and an unknown slug like a missing one", async () => {
    const h = createHarness();
    const admin = "streams-ws-admin@example.test";
    const editor = "streams-ws-editor@example.test";
    const adminId = await userIdOf(h, admin);
    const editorId = await userIdOf(h, editor);
    const slug = `streams-${crypto.randomUUID().slice(0, 6)}`;
    const wsId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    await db()
      .global.insert(schema.workspaces)
      .values({ id: wsId, slug, name: "Ops", createdBy: adminId, updatedAt: NOW });
    await db()
      .global.insert(schema.workspaceMembers)
      .values([
        { workspaceId: wsId, userId: adminId, role: "admin", updatedAt: NOW },
        { workspaceId: wsId, userId: editorId, role: "editor", updatedAt: NOW },
      ]);
    await onEnterprise(wsId);
    const asAdmin = await sessionOf(h, admin);
    const asEditor = await sessionOf(h, editor);
    const created = await asAdmin(`/api/v1/audit/streams?workspace=${slug}`, json("POST", CREATE));
    expect(created.status).toBe(201);
    const refused = await asEditor(`/api/v1/audit/streams?workspace=${slug}`);
    expect(refused.status).toBe(403);
    const missing = await asAdmin("/api/v1/audit/streams?workspace=nope-nope");
    expect(missing.status).toBe(404);
  });

  it("offers nothing while switched off, and nothing without the key", async () => {
    for (const off of [{ WEBHOOKS_ENABLED: undefined }, { WEBHOOK_KEY: undefined }]) {
      const h = createHarness({ env: off });
      const email = `streams-off-${crypto.randomUUID().slice(0, 6)}@example.test`;
      const session = await sessionOf(h, email);
      await onEnterprise(await userIdOf(h, email));
      const created = await session("/api/v1/audit/streams", json("POST", CREATE));
      expect(created.status).toBe(503);
      expect(await created.json()).toEqual({
        error: { code: "capacity_unavailable", message: "Audit streams are not available yet." },
      });
      expect(await (await session("/api/v1/audit/streams")).json()).toMatchObject({
        serviceAvailable: false,
      });
    }
  });

  it("validates the body and refuses a URL webhooks would refuse", async () => {
    const h = createHarness();
    const email = "streams-input@example.test";
    const session = await sessionOf(h, email);
    await onEnterprise(await userIdOf(h, email));
    for (const bad of [
      { ...CREATE, url: "http://siem.example.com/in" },
      { ...CREATE, url: "https://10.0.0.1/in" },
      { ...CREATE, label: "" },
      { ...CREATE, extra: true },
    ]) {
      const response = await session("/api/v1/audit/streams", json("POST", bad));
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    const empty = await session(`/api/v1/audit/streams/as_${"1".repeat(32)}`, json("PATCH", {}));
    expect(empty.status).toBe(400);
    // Revoking the old secret goes only with a new one.
    const revokeOnly = await session(
      `/api/v1/audit/streams/as_${"1".repeat(32)}`,
      json("PATCH", { revokeOldSecret: true }),
    );
    expect(revokeOnly.status).toBe(400);
  });

  it("answers a malformed or unknown stream, a bad slug and a signed-out cookie like nothing there", async () => {
    const h = createHarness();
    const email = "streams-missing@example.test";
    const session = await sessionOf(h, email);
    await onEnterprise(await userIdOf(h, email));
    const unknown = `as_${"0".repeat(32)}`;
    const routes: [string, string, unknown?][] = [
      ["PATCH", "", { label: "x" }],
      ["DELETE", ""],
      ["POST", "/test"],
      ["GET", "/deliveries"],
    ];
    for (const [method, suffix, body] of routes) {
      for (const id of ["not-a-stream", unknown]) {
        const response = await session(`/api/v1/audit/streams/${id}${suffix}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect(response.status, `${method} ${id}${suffix}`).toBe(404);
      }
    }
    const badSlug = await session("/api/v1/audit/streams?workspace=Not%20A%20Slug");
    expect(badSlug.status).toBe(404);
    const stale = await h.request("/api/v1/audit/streams", {
      headers: {
        cookie: "__Secure-better-auth.session_token=stale.value",
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
      },
    });
    expect(stale.status).toBe(401);
  });
});
