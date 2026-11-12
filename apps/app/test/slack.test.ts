// Slack connections through the app Worker (decision 0025, delivery 1): started and completed only
// through the dashboard's session, shown with their manifest and Request URL, kept out of the
// owner side's listing (API, MCP) and refused for issues like a missing connection; the events
// endpoint verifies Slack's signature before it reads a byte, answers `url_verification`, marks
// an uninstalled app once, refuses everything else with one empty `401`, and does not exist
// without SLACK_ENABLED. Slack is FakeSlack; nothing reaches Slack.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { FakeSlack } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-12T09:00:00Z");
const SCOPES =
  "artifacts:read artifacts:write annotations:read annotations:write annotations:moderate offline_access";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const db = () => regionsFromEnv(env).get("default").db;

async function onTeam(ownerId: string) {
  await db()
    .global.insert(schema.ownerPlans)
    .values({ ownerId, plan: "team", seats: 1, grantedBy: "test", updatedAt: NOW })
    .onConflictDoUpdate({ target: schema.ownerPlans.ownerId, set: { plan: "team" } });
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

async function userIdOf(h: Harness, token: string) {
  return (await (await api(h, token, "/api/v1/me")).json<{ userId: string }>()).userId;
}

async function artifactWithThread(ownerId: string) {
  const id = Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32],
  ).join("");
  const version = `ver_${crypto.randomUUID()}`;
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId,
      type: "site",
      name: "Plan",
      state: "active",
      annotations: "open",
      accessMode: "restricted",
      expiresAt: NOW + 86_400_000,
      createdAt: NOW,
      updatedAt: NOW,
    });
  await db().insert(schema.versions).values({
    id: version,
    artifactId: id,
    number: 1,
    authorId: ownerId,
    state: "committed",
    entrypoint: "index.html",
    publishedBytes: 10,
    committedAt: NOW,
  });
  await db()
    .update(schema.artifacts)
    .set({ currentVersionId: version })
    .where(eq(schema.artifacts.id, id));
  const threadId = crypto.randomUUID();
  const target = JSON.stringify({ schema: 1, path: "index.html", anchor: { kind: "document" } });
  await db().insert(schema.annotationThreads).values({
    id: threadId,
    artifactId: id,
    versionId: version,
    ownerId,
    authorId: ownerId,
    target,
    targetBytes: target.length,
    path: "index.html",
    updatedAt: NOW,
  });
  return { id, threadId };
}

interface SlackView {
  id: string;
  service: string;
  attention: string | null;
  identity: string;
  slack: {
    requestUrl: string;
    manifest: string;
    createUrl: string;
    manifestVersion: number | null;
    outdated: boolean;
  } | null;
}

/** A user on Team with a completed Slack connection in their personal space. */
async function connected(h: Harness, fake: FakeSlack, email: string) {
  const token = await apiToken(h, email, SCOPES);
  const userId = await userIdOf(h, token);
  await onTeam(userId);
  const session = await sessionOf(h, email);
  const started = await session(
    "/api/v1/integrations/connections",
    json("POST", { service: "slack", label: "Acme" }),
  );
  expect(started.status).toBe(201);
  const pending = await started.json<SlackView>();
  const botToken = FakeSlack.botToken();
  const signingSecret = FakeSlack.signingSecret();
  fake.bot(botToken, "Acme", "T0ACME01");
  const completed = await session(
    `/api/v1/integrations/connections/${pending.id}`,
    json("PATCH", { botToken, signingSecret }),
  );
  expect(completed.status).toBe(200);
  return {
    token,
    userId,
    session,
    pending,
    view: await completed.json<SlackView>(),
    botToken,
    signingSecret,
  };
}

const eventsPath = (id: string, region = "default") => `/integrations/slack/events/${region}/${id}`;

describe("Slack connections through the dashboard session", () => {
  it("starts with the manifest and Request URL, completes with auth.test and never shows the secrets", async () => {
    const fake = new FakeSlack();
    const h = createHarness({ integrationFetch: fake.fetch });
    const { pending, view, botToken, signingSecret, session } = await connected(
      h,
      fake,
      "slack-flow@example.test",
    );
    expect(pending).toMatchObject({ service: "slack", attention: "pending" });
    const requestUrl = `${ORIGIN}/integrations/slack/events/default/${pending.id}`;
    expect(pending.slack).toMatchObject({ requestUrl, manifestVersion: null, outdated: false });
    const manifest = JSON.parse(String(pending.slack?.manifest));
    expect(manifest.settings.event_subscriptions.request_url).toBe(requestUrl);
    expect(manifest.features.unfurl_domains).toEqual([env.CONTENT_DOMAIN, new URL(ORIGIN).host]);
    expect(new URL(String(pending.slack?.createUrl)).searchParams.get("manifest_json")).toBe(
      JSON.stringify(manifest),
    );
    expect(view).toMatchObject({ attention: null, identity: "Acme" });
    expect(view.slack).toMatchObject({ manifestVersion: 1 });
    const listed = await (await session("/api/v1/integrations/connections")).json<{
      slackAvailable: boolean;
      connections: SlackView[];
    }>();
    expect(listed.slackAvailable).toBe(true);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(botToken);
    expect(text).not.toContain(signingSecret);
    expect(text).not.toContain("T0ACME01");
    expect(fake.requests.map((r) => r.url)).toEqual(["https://slack.com/api/auth.test"]);
  });

  it("refuses every bearer token, and MCP has no tool to manage it", async () => {
    const fake = new FakeSlack();
    const h = createHarness({ integrationFetch: fake.fetch });
    const email = "slack-bearer@example.test";
    const token = await apiToken(h, email, SCOPES);
    await onTeam(await userIdOf(h, token));
    const viaBearer = await api(h, token, "/api/v1/integrations/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "slack", label: "Acme" }),
    });
    expect(viaBearer.status).toBe(403);
    const mcp = await connect(h, await mcpToken(h, email, SCOPES));
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name).filter((name) => /slack|connection/i.test(name))).toEqual(
      [],
    );
  });

  it("removes the connection and revokes the bot token at Slack after the answer", async () => {
    const fake = new FakeSlack();
    const h = createHarness({ integrationFetch: fake.fetch });
    const { view, session, botToken } = await connected(h, fake, "slack-remove@example.test");
    const removed = await session(`/api/v1/integrations/connections/${view.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(fake.requests.map((r) => r.url)).toEqual([
      "https://slack.com/api/auth.test",
      "https://slack.com/api/auth.revoke",
    ]);
    expect(fake.revoked.has(botToken)).toBe(true);
  });

  it("is left out of the owner side's listing (API and MCP) and refused for issues like a missing connection", async () => {
    const fake = new FakeSlack();
    const h = createHarness({ integrationFetch: fake.fetch });
    const email = "slack-issues@example.test";
    const { token, userId, view } = await connected(h, fake, email);
    const mcp = await connect(h, await mcpToken(h, email, SCOPES));
    const viaApi = await (await api(h, token, "/api/v1/integrations")).json<{
      connections: unknown[];
    }>();
    expect(viaApi.connections).toEqual([]);
    expect((await callTool(mcp, "list_integrations", {})).structuredContent).toEqual(viaApi);
    const { id, threadId } = await artifactWithThread(userId);
    const body = { connectionId: view.id, target: "anything", title: "Fix it" };
    const missing = { ...body, connectionId: `ic_${"0".repeat(32)}` };
    const ask = (b: unknown) =>
      api(h, token, `/api/v1/artifacts/${id}/annotations/threads/${threadId}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(b),
      });
    const viaRoute = await ask(body);
    expect(viaRoute.status).toBe(404);
    const refusal = await viaRoute.json();
    expect(refusal).toEqual(await (await ask(missing)).json());
    const viaTool = await callTool(mcp, "create_issue_from_thread", {
      artifactId: id,
      threadId,
      ...body,
    });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.structuredContent).toEqual(refusal);
  });

  it("answers 503 to start or complete, and offers nothing, while Slack is off", async () => {
    const fake = new FakeSlack();
    const on = createHarness({ integrationFetch: fake.fetch });
    const { pending, session } = await (async () => {
      const email = "slack-off@example.test";
      const token = await apiToken(on, email, SCOPES);
      await onTeam(await userIdOf(on, token));
      const s = await sessionOf(on, email);
      const started = await s(
        "/api/v1/integrations/connections",
        json("POST", { service: "slack", label: "Acme" }),
      );
      return { pending: await started.json<SlackView>(), session: s };
    })();
    void session;
    const off = createHarness({ integrationFetch: fake.fetch, env: { SLACK_ENABLED: undefined } });
    const offSession = await sessionOf(off, "slack-off@example.test");
    const start = await offSession(
      "/api/v1/integrations/connections",
      json("POST", { service: "slack", label: "Acme" }),
    );
    expect(start.status).toBe(503);
    expect(await start.json()).toMatchObject({
      error: { code: "capacity_unavailable", message: "Slack is not available yet." },
    });
    const complete = await offSession(
      `/api/v1/integrations/connections/${pending.id}`,
      json("PATCH", { botToken: FakeSlack.botToken(), signingSecret: FakeSlack.signingSecret() }),
    );
    expect(complete.status).toBe(503);
    const listed = await (await offSession("/api/v1/integrations/connections")).json<{
      slackAvailable: boolean;
    }>();
    expect(listed.slackAvailable).toBe(false);
    // The endpoint does not exist: the app's ordinary 404.
    const event = await off.request(
      eventsPath(pending.id),
      await FakeSlack.signedEvent(FakeSlack.signingSecret(), { type: "url_verification" }),
    );
    expect(event.status).toBe(404);
    expect(await event.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
    expect(fake.requests).toEqual([]);
  });
});

describe("the Slack events endpoint", () => {
  it("answers a signed url_verification with the challenge, as JSON", async () => {
    const fake = new FakeSlack();
    const h = createHarness({ integrationFetch: fake.fetch });
    const { view, signingSecret } = await connected(h, fake, "slack-verify@example.test");
    const answer = await h.request(
      eventsPath(view.id),
      await FakeSlack.signedEvent(
        signingSecret,
        {
          token: "x",
          challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
          type: "url_verification",
        },
        { now: NOW },
      ),
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toEqual({
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    });
    // A challenge outside the safe shape is never reflected; still 200.
    const hostile = await h.request(
      eventsPath(view.id),
      await FakeSlack.signedEvent(
        signingSecret,
        { type: "url_verification", challenge: "<script>alert(1)</script>" },
        { now: NOW },
      ),
    );
    expect(hostile.status).toBe(200);
    expect(await hostile.text()).toBe("");
  });

  it("refuses with one empty 401 whatever is wrong, once the path matched", async () => {
    const fake = new FakeSlack();
    const h = createHarness({ integrationFetch: fake.fetch });
    const { view, signingSecret, session } = await connected(h, fake, "slack-refuse@example.test");
    const pending = await (
      await session(
        "/api/v1/integrations/connections",
        json("POST", { service: "slack", label: "Pending" }),
      )
    ).json<SlackView>();
    expect(pending.attention).toBe("pending");
    const payload = { type: "url_verification", challenge: "abc" };
    const good = await FakeSlack.signedEvent(signingSecret, payload, { now: NOW });
    const headers = good.headers as Record<string, string>;
    const stale = await FakeSlack.signedEvent(signingSecret, payload, {
      timestamp: String(Math.floor(NOW / 1000) - 301),
    });
    const cases: [string, string, RequestInit][] = [
      [
        "wrong secret",
        eventsPath(view.id),
        await FakeSlack.signedEvent(FakeSlack.signingSecret(), payload, { now: NOW }),
      ],
      ["stale timestamp", eventsPath(view.id), stale],
      [
        "timestamp with a sign",
        eventsPath(view.id),
        {
          ...good,
          headers: {
            ...headers,
            "x-slack-request-timestamp": `+${headers["x-slack-request-timestamp"]}`,
          },
        },
      ],
      [
        "no signature",
        eventsPath(view.id),
        { ...good, headers: { ...headers, "x-slack-signature": "" } },
      ],
      [
        "another body",
        eventsPath(view.id),
        { ...good, body: JSON.stringify({ ...payload, challenge: "abd" }) },
      ],
      [
        "form body",
        eventsPath(view.id),
        { ...good, headers: { ...headers, "content-type": "application/x-www-form-urlencoded" } },
      ],
      [
        "too large",
        eventsPath(view.id),
        { ...good, headers: { ...headers, "content-length": String(64 * 1024 + 1) } },
      ],
      ["GET", eventsPath(view.id), { method: "GET" }],
      ["unknown connection", eventsPath(`ic_${"9".repeat(32)}`), good],
      ["pending connection", eventsPath(pending.id), good],
      ["wrong region", eventsPath(view.id, "eu"), good],
      ["unknown region", eventsPath(view.id, "mars"), good],
      ["bad id", "/integrations/slack/events/default/ic_1", good],
    ];
    for (const [name, path, init] of cases) {
      const answer = await h.request(path, init);
      expect(answer.status, name).toBe(401);
      expect(await answer.text(), name).toBe("");
      expect(answer.headers.get("cache-control"), name).toBe("no-store");
    }
    // A body over the cap without a length is refused once read.
    const big = await h.request(eventsPath(view.id), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(Math.floor(NOW / 1000)),
        "x-slack-signature": `v0=${"0".repeat(64)}`,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024 + 1));
          controller.close();
        },
      }),
      // @ts-expect-error workerd needs it for a stream body
      duplex: "half",
    });
    expect(big.status).toBe(401);
    expect(fake.requests.map((r) => r.url)).toEqual(["https://slack.com/api/auth.test"]);
  });

  it("marks the connection on app_uninstalled from its own Slack workspace, once, and always answers 200", async () => {
    const fake = new FakeSlack();
    const h = createHarness({ integrationFetch: fake.fetch });
    const { view, signingSecret, userId } = await connected(
      h,
      fake,
      "slack-uninstall@example.test",
    );
    const send = async (payload: unknown) =>
      h.request(
        eventsPath(view.id),
        await FakeSlack.signedEvent(signingSecret, payload, { now: NOW }),
      );
    const row = async () =>
      (
        await db()
          .select()
          .from(schema.integrationConnections)
          .where(eq(schema.integrationConnections.id, view.id))
      )[0];
    // Another Slack workspace's event (an app shared with it), a link, an unknown envelope.
    for (const payload of [
      FakeSlack.event("T0OTHER01", "app_uninstalled"),
      FakeSlack.event("T0ACME01", "link_shared", { links: [{ url: "https://x.portifact.dev/" }] }),
      { type: "app_rate_limited", team_id: "T0ACME01" },
      { ...FakeSlack.event("T0ACME01", "app_uninstalled"), is_enterprise_install: true },
    ]) {
      const answer = await send(payload);
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("");
    }
    expect((await row())?.attention).toBeNull();
    expect((await send(FakeSlack.event("T0ACME01", "app_uninstalled"))).status).toBe(200);
    expect((await send(FakeSlack.event("T0ACME01", "tokens_revoked"))).status).toBe(200);
    expect((await row())?.attention).toBe("app_uninstalled");
    const failing = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, userId));
    expect(
      failing.filter((e) => e.kind === "integration.failing").map((e) => [e.actorType, e.detail]),
    ).toEqual([["system", { service: "slack", reason: "app_uninstalled" }]]);
    // A marked connection still answers Slack's verification.
    const verify = await send({ type: "url_verification", challenge: "again" });
    expect(await verify.json()).toEqual({ challenge: "again" });
  });

  it("acknowledges a signed body that is not UTF-8, and refuses a region the deployment lacks or a body that breaks", async () => {
    const fake = new FakeSlack();
    const h = createHarness({ integrationFetch: fake.fetch });
    const { view, signingSecret } = await connected(h, fake, "slack-edges@example.test");
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const timestamp = String(Math.floor(NOW / 1000));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const prefix = new TextEncoder().encode(`v0:${timestamp}:`);
    const signed = new Uint8Array(prefix.length + bytes.length);
    signed.set(prefix);
    signed.set(bytes, prefix.length);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
    const signature = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const headers = {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    };
    const answer = await h.request(eventsPath(view.id), { method: "POST", headers, body: bytes });
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe("");
    // A deployment without the EU region refuses an EU path before any read.
    const defaultOnly = createHarness({
      integrationFetch: fake.fetch,
      env: { DB_EU: undefined } as unknown as Partial<Cloudflare.Env>,
    });
    const eu = await defaultOnly.request(eventsPath(view.id, "eu"), {
      method: "POST",
      headers,
      body: bytes,
    });
    expect(eu.status).toBe(401);
    // A body whose stream fails is refused like any other.
    const broken = await h.request(eventsPath(view.id), {
      method: "POST",
      headers,
      body: new ReadableStream({
        pull(controller) {
          controller.error(new Error("connection reset"));
        },
      }),
      // @ts-expect-error workerd needs it for a stream body
      duplex: "half",
    });
    expect(broken.status).toBe(401);
  });

  it("refuses a correctly signed body over the cap without a length, by the cap, and every method but POST", async () => {
    const fake = new FakeSlack();
    const h = createHarness({ integrationFetch: fake.fetch });
    const { view, signingSecret } = await connected(h, fake, "slack-cap@example.test");
    // Valid JSON of 64 KiB + 1, correctly signed: only the cap can refuse it.
    const text = JSON.stringify({ type: "url_verification", challenge: "abc", pad: "" });
    const padded = text.replace('"pad":""', `"pad":"${"x".repeat(64 * 1024 + 1 - text.length)}"`);
    expect(new TextEncoder().encode(padded).length).toBe(64 * 1024 + 1);
    const signed = await FakeSlack.signedEvent(signingSecret, JSON.parse(padded), { now: NOW });
    expect(signed.body).toBe(padded);
    const bytes = new TextEncoder().encode(padded);
    const streamed = await h.request(eventsPath(view.id), {
      method: "POST",
      headers: signed.headers as Record<string, string>,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      // @ts-expect-error workerd needs it for a stream body
      duplex: "half",
    });
    expect(streamed.status).toBe(401);
    // One byte less, signed, passes: the cap is what refused the other.
    const fits = JSON.stringify({ type: "url_verification", challenge: "abc", pad: "" });
    const under = fits.replace('"pad":""', `"pad":"${"x".repeat(64 * 1024 - fits.length)}"`);
    const ok = await FakeSlack.signedEvent(signingSecret, JSON.parse(under), { now: NOW });
    const accepted = await h.request(eventsPath(view.id), {
      method: "POST",
      headers: ok.headers as Record<string, string>,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(under));
          controller.close();
        },
      }),
      // @ts-expect-error workerd needs it for a stream body
      duplex: "half",
    });
    expect(accepted.status).toBe(200);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const verification = await FakeSlack.signedEvent(
        signingSecret,
        { type: "url_verification", challenge: "abc" },
        { now: NOW },
      );
      const answer = await h.request(eventsPath(view.id), { ...verification, method });
      expect(answer.status, method).toBe(401);
      expect(await answer.text(), method).toBe("");
    }
  });

  it("never logs a token, a secret, a signature, a team, a challenge or a body", async () => {
    const fake = new FakeSlack();
    const h = createHarness({ integrationFetch: fake.fetch });
    const { view, signingSecret, botToken } = await connected(h, fake, "slack-logs@example.test");
    const lines: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      }),
    );
    try {
      const init = await FakeSlack.signedEvent(
        signingSecret,
        { type: "url_verification", challenge: "secretchallenge" },
        { now: NOW },
      );
      await h.request(eventsPath(view.id), init);
      await h.request(
        eventsPath(view.id),
        await FakeSlack.signedEvent(signingSecret, FakeSlack.event("T0ACME01", "app_uninstalled"), {
          now: NOW,
        }),
      );
      await h.request(eventsPath(view.id), { ...init, body: "{}" });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const text = lines.join("\n");
    expect(text).toContain("slack_event");
    for (const secret of [
      signingSecret,
      botToken,
      "secretchallenge",
      "T0ACME01",
      "/integrations/slack",
      String(
        (
          (await FakeSlack.signedEvent(signingSecret, {}, { now: NOW })).headers as Record<
            string,
            string
          >
        )["x-slack-signature"],
      ).slice(3, 20),
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
