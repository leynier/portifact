// Share links on the app (decision 0008): the owner's routes and MCP tools give the same bodies,
// errors and scope; the visitor's open endpoint takes no credentials, answers unknown, expired and
// revoked tokens alike, limits password attempts and asks for the human check; and the entry page
// is served without a redirect, noindex and without a referrer.
import { env, SELF } from "cloudflare:test";
import { SHARE_LINKS, SHARE_OPEN_LIMITS } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHARE_CSP } from "../src/app-host.ts";
import { createHarness, type Harness, HUMAN_TOKEN, ORIGIN, OUTAGE_HUMAN_TOKEN } from "./harness.ts";
import {
  api,
  apiToken,
  callTool,
  connect,
  mcpToken,
  rawCall,
  type ToolResult,
} from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-02T09:00:00Z");
const SHARE = "artifacts:read artifacts:write artifacts:share offline_access";
const db = () => regionsFromEnv(env).get("default").db;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await env.DB.exec("DELETE FROM rate_limits");
});
afterEach(() => {
  vi.useRealTimers();
});

interface Both {
  h: Harness;
  userId: string;
  apiCall: (path: string, init?: RequestInit) => Promise<Response>;
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

async function both(email: string, scope = SHARE): Promise<Both> {
  const h = createHarness();
  const apiAccess = await apiToken(h, email, scope);
  const client = await connect(h, await mcpToken(h, email, scope));
  const apiCall = (path: string, init?: RequestInit) => api(h, apiAccess, path, init);
  const { userId } = await (await apiCall("/api/v1/me")).json<{ userId: string }>();
  return { h, userId, apiCall, tool: (name, args) => callTool(client, name, args) };
}

const fromApi = async (response: Response) => ({
  ok: response.ok,
  body: await response.json<unknown>(),
});
const fromTool = (result: ToolResult) => ({
  ok: result.isError !== true,
  body: result.structuredContent,
});

async function onPlan(ownerId: string, plan: "free" | "pro") {
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId, plan, seats: 1, grantedBy: "test", updatedAt: NOW })
    .onConflictDoUpdate({ target: schema.ownerPlans.ownerId, set: { plan } });
}

async function publish(b: Both, name: string): Promise<string> {
  const result = await b.tool("publish_document", { type: "text", name, content: name });
  return (result.structuredContent as { artifactId: string }).artifactId;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** What differs between two links: their ID, the time and the token in the URL. */
function shape(body: unknown) {
  const { link, url } = body as { link: Record<string, unknown>; url: string };
  const { id, createdAt, ...rest } = link;
  expect(id).toMatch(/^sl_[0-9a-f]{32}$/);
  expect(url).toMatch(/^https:\/\/app\.portifact\.com\/s#[A-Za-z0-9_-]{43}$/);
  return { link: rest, url: new URL(url).pathname };
}

describe("the owner's share links, through the API and MCP", () => {
  it("create, list and revoke give the same bodies, without the token after creation", async () => {
    const b = await both("share-parity@example.test");
    await onPlan(b.userId, "pro");
    const viaApi = await publish(b, "api");
    const viaMcp = await publish(b, "mcp");
    const input = {
      label: "For Ana",
      expiresAt: "2026-11-30T00:00:00.000Z",
      password: "longenough",
    };

    const apiCreated = await b.apiCall(`/api/v1/artifacts/${viaApi}/share-links`, post(input));
    expect(apiCreated.status).toBe(201);
    expect(apiCreated.headers.get("cache-control")).toBe("no-store");
    const apiBody = await apiCreated.json<{ link: { id: string }; url: string }>();
    const mcpResult = await b.tool("create_share_link", { artifactId: viaMcp, ...input });
    const mcpBody = mcpResult.structuredContent as { link: { id: string }; url: string };
    expect(shape(mcpBody)).toEqual(shape(apiBody));
    expect(shape(apiBody).link).toMatchObject({
      label: "For Ana",
      hasPassword: true,
      state: "active",
      expiresAt: "2026-11-30T00:00:00.000Z",
      lastUsedOn: null,
    });

    const apiList = await fromApi(await b.apiCall(`/api/v1/artifacts/${viaApi}/share-links`));
    const mcpList = fromTool(await b.tool("list_share_links", { artifactId: viaApi }));
    expect(mcpList).toEqual(apiList);
    const token = apiBody.url.split("#")[1] as string;
    expect(JSON.stringify(apiList.body)).not.toContain(token);
    expect(apiList.body).toMatchObject({
      enabled: true,
      activeLimit: 20,
      links: [{ id: apiBody.link.id }],
    });

    const apiRevoked = await fromApi(
      await b.apiCall(`/api/v1/artifacts/${viaApi}/share-links/${apiBody.link.id}`, {
        method: "DELETE",
      }),
    );
    const mcpRevoked = fromTool(
      await b.tool("revoke_share_link", { artifactId: viaMcp, linkId: mcpBody.link.id }),
    );
    expect(apiRevoked).toEqual({ ok: true, body: { id: apiBody.link.id, revoked: true } });
    expect(mcpRevoked).toEqual({ ok: true, body: { id: mcpBody.link.id, revoked: true } });
    // Revoking again, and a link that is not this artifact's, answer the same.
    expect(
      fromTool(await b.tool("revoke_share_link", { artifactId: viaMcp, linkId: mcpBody.link.id })),
    ).toEqual(
      await fromApi(
        await b.apiCall(`/api/v1/artifacts/${viaApi}/share-links/${apiBody.link.id}`, {
          method: "DELETE",
        }),
      ),
    );
  });

  it("refuses the same way: a bad label, a past expiry, a short password, another user's and a missing artifact", async () => {
    const b = await both("share-errors@example.test");
    await onPlan(b.userId, "pro");
    const viaApi = await publish(b, "api");
    for (const input of [
      { label: "" },
      { label: "x", expiresAt: "2026-11-01T00:00:00.000Z" },
      { label: "x", expiresAt: "2028-01-01T00:00:00.000Z" },
    ]) {
      const apiResult = await fromApi(
        await b.apiCall(`/api/v1/artifacts/${viaApi}/share-links`, post(input)),
      );
      expect(apiResult.ok, JSON.stringify(input)).toBe(false);
      const mcpResult = fromTool(
        await b.tool("create_share_link", { artifactId: viaApi, ...input }),
      );
      expect(mcpResult.ok).toBe(false);
      if (input.expiresAt) expect(mcpResult).toEqual(apiResult);
    }
    const short = await fromApi(
      await b.apiCall(
        `/api/v1/artifacts/${viaApi}/share-links`,
        post({ label: "x", password: "short" }),
      ),
    );
    expect(short.body).toMatchObject({ error: { code: "invalid_input" } });

    const other = await both("share-errors-other@example.test");
    await onPlan(other.userId, "pro");
    for (const id of [viaApi, "abcdefghij"]) {
      const apiResult = await fromApi(
        await other.apiCall(`/api/v1/artifacts/${id}/share-links`, post({ label: "x" })),
      );
      expect(apiResult).toEqual({
        ok: false,
        body: { error: { code: "not_found", message: "Artifact not found." } },
      });
      expect(
        fromTool(await other.tool("create_share_link", { artifactId: id, label: "x" })),
      ).toEqual(apiResult);
      expect(fromTool(await other.tool("list_share_links", { artifactId: id }))).toEqual(apiResult);
      expect(await fromApi(await other.apiCall(`/api/v1/artifacts/${id}/share-links`))).toEqual(
        apiResult,
      );
    }
  });

  it("says in MCP when there are no links and when the plan pauses them, and shows link openings", async () => {
    const b = await both("share-mcp-text@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "text");
    const empty = await b.tool("list_share_links", { artifactId: id });
    expect(empty.content[0]?.text).toContain(`${id} has no share links.`);
    const created = await b.tool("create_share_link", {
      artifactId: id,
      label: "Board",
      password: "longenough",
    });
    const { url, link } = created.structuredContent as { url: string; link: { id: string } };
    expect(created.content[0]?.text).toContain(url);
    await onPlan(b.userId, "free");
    const paused = await b.tool("list_share_links", { artifactId: id });
    expect(paused.content[0]?.text).toContain("with password");
    expect(paused.content[0]?.text).toContain("they do not open");
    expect(paused.content[0]?.text).not.toContain(url.split("#")[1] as string);
    expect(
      fromTool(await b.tool("create_share_link", { artifactId: id, label: "x" })).body,
    ).toEqual({
      error: {
        code: "plan_required",
        message: "Sharing with links is part of the Pro plan.",
      },
    });
    expect(
      fromTool(await b.tool("revoke_share_link", { artifactId: "abcdefghij", linkId: link.id })).ok,
    ).toBe(false);

    await env.ACCESS_DB.prepare(
      "insert into access_events (artifact_id, window_start, user_id, owner_id, email, opened_at, link_id) values (?, ?, ?, ?, '', ?, ?)",
    )
      .bind(id, NOW, link.id, b.userId, NOW, link.id)
      .run();
    const log = await b.tool("get_access_logs", { artifactId: id });
    expect(log.content[0]?.text).toContain("share link Board");
    expect(log.structuredContent).toMatchObject({
      entries: [{ email: "", shareLink: { id: link.id, label: "Board" } }],
    });
  });

  it("needs artifacts:share at both", async () => {
    const b = await both("share-scope@example.test");
    const id = await publish(b, "scope");
    const reader = await mcpToken(b.h, "share-scope@example.test", "artifacts:read");
    for (const [tool, args] of [
      ["create_share_link", { label: "x" }],
      ["list_share_links", {}],
      ["revoke_share_link", { linkId: `sl_${"0".repeat(32)}` }],
    ] as const) {
      const denied = await rawCall(b.h, reader, tool, { artifactId: id, ...args });
      expect(denied.status, tool).toBe(403);
      expect(denied.headers.get("www-authenticate"), tool).toContain('scope="artifacts:share"');
    }
    const readOnly = await apiToken(b.h, "share-scope@example.test", "artifacts:read");
    for (const [method, path] of [
      ["POST", `/api/v1/artifacts/${id}/share-links`],
      ["GET", `/api/v1/artifacts/${id}/share-links`],
      ["DELETE", `/api/v1/artifacts/${id}/share-links/sl_${"0".repeat(32)}`],
    ] as const) {
      const denied = await api(
        b.h,
        readOnly,
        path,
        method === "POST" ? post({ label: "x" }) : { method },
      );
      expect(denied.status, path).toBe(403);
      expect(denied.headers.get("www-authenticate"), path).toContain('scope="artifacts:share"');
    }
  });
});

/** A link created through the API by a Pro owner, and the token from its URL. */
async function linkFor(b: Both, artifactId: string, input: Record<string, unknown> = {}) {
  const response = await b.apiCall(
    `/api/v1/artifacts/${artifactId}/share-links`,
    post({ label: "Link", ...input }),
  );
  const body = await response.json<{ link: { id: string }; url: string }>();
  return { id: body.link.id, token: body.url.split("#")[1] as string };
}

/** The entry page's request to the open endpoint, from the app origin. */
function open(h: Harness, body: unknown, ip = "203.0.113.7", headers: Record<string, string> = {}) {
  return h.request("/api/v1/share/open", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "cf-connecting-ip": ip,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("opening a link", () => {
  it("answers the entry page with the artifact origin's handoff, never the token", async () => {
    const b = await both("share-open@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "open");
    const { token } = await linkFor(b, id);
    const response = await open(b.h, { token });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const { location } = await response.json<{ location: string }>();
    const target = new URL(location);
    expect(target.origin).toBe(`https://${id}.portifact.dev`);
    expect(target.pathname).toBe("/__portifact/link");
    expect(target.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location).not.toContain(token);
  });

  it("refuses requests that are not the app's own page", async () => {
    const h = createHarness();
    for (const headers of [
      { origin: "https://k7d2qm4xab.portifact.dev" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      const response = await open(h, { token: "A".repeat(43) }, "203.0.113.8", headers);
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("answers unknown, malformed, expired and revoked tokens, and paused links, exactly alike", async () => {
    const b = await both("share-alike@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "alike");
    const expired = await linkFor(b, id, { expiresAt: new Date(NOW + 1000).toISOString() });
    const revoked = await linkFor(b, id);
    await b.apiCall(`/api/v1/artifacts/${id}/share-links/${revoked.id}`, { method: "DELETE" });
    const paused = await linkFor(b, id);
    vi.setSystemTime(NOW + 2000);
    const answers = async (token: string, password?: string) => {
      const response = await open(b.h, password === undefined ? { token } : { token, password });
      return { status: response.status, body: await response.text() };
    };
    const unknown = await answers("B".repeat(43));
    expect(unknown).toEqual({
      status: 404,
      body: JSON.stringify({
        error: {
          code: "not_found",
          message: "This share link has expired, was revoked or does not exist.",
        },
      }),
    });
    expect(await answers("not-a-token")).toEqual(unknown);
    expect(await answers(expired.token)).toEqual(unknown);
    expect(await answers(revoked.token)).toEqual(unknown);
    const withPassword = await answers("C".repeat(43), "longenough");
    expect(withPassword.status).toBe(403);
    expect(await answers(revoked.token, "longenough")).toEqual(withPassword);
    await onPlan(b.userId, "free");
    expect(await answers(paused.token)).toEqual(unknown);
    await onPlan(b.userId, "pro");
    expect((await answers(paused.token)).status).toBe(200);
  });

  it("asks for the password, then for the human check, then locks only that token from that IP", async () => {
    const b = await both("share-password@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "password");
    const { token } = await linkFor(b, id, { password: "correct horse" });
    const codeOf = async (response: Response) =>
      (await response.json<{ error?: { code: string } }>()).error?.code;
    let solved = 0;
    const human = () => `${HUMAN_TOKEN}-share-${++solved}`;

    expect(await codeOf(await open(b.h, { token }))).toBe("unauthenticated");
    for (let i = 0; i < SHARE_OPEN_LIMITS.tokenHumanCheckAfter; i += 1) {
      expect(await codeOf(await open(b.h, { token, password: `wrong ${i}` }))).toBe("forbidden");
    }
    // From now on a password needs a solved human check, right or wrong.
    expect(await codeOf(await open(b.h, { token, password: "correct horse" }))).toBe(
      "human_verification_required",
    );
    expect(
      await codeOf(
        await open(b.h, { token, password: "correct horse", turnstileToken: "turnstile-failed" }),
      ),
    ).toBe("human_verification_required");
    const opened = await open(b.h, { token, password: "correct horse", turnstileToken: human() });
    expect(opened.status).toBe(200);
    expect(b.h.siteverifyCalls.at(-1)).toMatchObject({ remoteIp: "203.0.113.7" });

    // Wrong passwords from this IP, each with a solved check, until the pair is locked.
    for (
      let i = SHARE_OPEN_LIMITS.tokenHumanCheckAfter;
      i < SHARE_OPEN_LIMITS.tokenIpLockAfter;
      i += 1
    ) {
      expect(
        await codeOf(await open(b.h, { token, password: `wrong ${i}`, turnstileToken: human() })),
      ).toBe("forbidden");
    }
    const locked = await open(b.h, { token, password: "correct horse", turnstileToken: human() });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await codeOf(locked)).toBe("rate_limited");

    // Nobody else is locked out: another IP with the right password and a solved check gets in.
    const elsewhere = await open(
      b.h,
      { token, password: "correct horse", turnstileToken: human() },
      "198.51.100.77",
    );
    expect(elsewhere.status).toBe(200);
  });

  it("counts parallel attempts one by one, so they cannot skip the human check", async () => {
    const b = await both("share-race-human@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "race");
    const { token } = await linkFor(b, id, { password: "correct horse" });
    const answers = await Promise.all(
      Array.from({ length: 30 }, (_, i) => open(b.h, { token, password: `wrong ${i}` })),
    );
    const codes = await Promise.all(
      answers.map(async (r) => (await r.json<{ error: { code: string } }>()).error.code),
    );
    expect(codes.filter((code) => code === "forbidden")).toHaveLength(
      SHARE_OPEN_LIMITS.tokenHumanCheckAfter,
    );
    // Every other attempt was stopped before its password was checked: asked for the check, or,
    // past the pair's limit while the others were in flight, locked for this IP only.
    expect(
      codes.filter((code) => code === "human_verification_required" || code === "rate_limited"),
    ).toHaveLength(30 - SHARE_OPEN_LIMITS.tokenHumanCheckAfter);
    expect(codes).toContain("human_verification_required");
  });

  it("counts parallel attempts one by one, so they cannot skip the lock", async () => {
    const b = await both("share-race-lock@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "race-lock");
    const { token } = await linkFor(b, id, { password: "correct horse" });
    const answers = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        open(b.h, { token, password: `wrong ${i}`, turnstileToken: `${HUMAN_TOKEN}-race-${i}` }),
      ),
    );
    const statuses = answers.map((r) => r.status);
    expect(statuses.filter((status) => status === 403)).toHaveLength(
      SHARE_OPEN_LIMITS.tokenIpLockAfter,
    );
    expect(statuses.filter((status) => status === 429)).toHaveLength(
      25 - SHARE_OPEN_LIMITS.tokenIpLockAfter,
    );
  });

  it("does not count right passwords, so an honest visitor never reaches the check", async () => {
    const b = await both("share-honest@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "honest");
    const { token } = await linkFor(b, id, { password: "correct horse" });
    for (let i = 0; i < 2 * SHARE_OPEN_LIMITS.ipHumanCheckAfter; i += 1) {
      expect((await open(b.h, { token, password: "correct horse" })).status).toBe(200);
    }
    for (let i = 0; i < SHARE_OPEN_LIMITS.tokenHumanCheckAfter; i += 1) {
      expect((await open(b.h, { token, password: `wrong ${i}` })).status).toBe(403);
    }
  });

  it("stops every attempt at the token's ceiling, which takes that many solved checks to reach", async () => {
    const b = await both("share-ceiling@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "ceiling");
    const { token } = await linkFor(b, id, { password: "correct horse" });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const prefix = [...new Uint8Array(digest)]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    // As if the ceiling's worth of solved wrong attempts had come from many addresses.
    await env.DB.prepare("insert into rate_limits (key, window_start, count) values (?, ?, ?)")
      .bind(`share:fail:${prefix}`, NOW, SHARE_OPEN_LIMITS.tokenCeiling)
      .run();
    const response = await open(
      b.h,
      { token, password: "correct horse", turnstileToken: `${HUMAN_TOKEN}-ceiling` },
      "198.51.100.200",
    );
    expect(response.status).toBe(429);
  });

  it("asks a crowded IP for the human check instead of refusing it", async () => {
    const b = await both("share-nat@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "nat");
    const links = await Promise.all(
      Array.from({ length: 3 }, () => linkFor(b, id, { password: "correct horse" })),
    );
    // Wrong passwords on several links from one address pass the IP's threshold...
    for (const [i, link] of links.entries()) {
      for (let j = 0; j < 2; j += 1) {
        await open(b.h, { token: link.token, password: `wrong ${i} ${j}` }, "192.0.2.150");
      }
    }
    const [first] = links;
    const asked = await open(
      b.h,
      { token: first?.token, password: "correct horse" },
      "192.0.2.150",
    );
    expect((await asked.json<{ error: { code: string } }>()).error.code).toBe(
      "human_verification_required",
    );
    // ...and someone there with the right password and a solved check still gets in.
    const opened = await open(
      b.h,
      { token: first?.token, password: "correct horse", turnstileToken: `${HUMAN_TOKEN}-nat` },
      "192.0.2.150",
    );
    expect(opened.status).toBe(200);
  });

  it("fails closed when the human check is down", async () => {
    const h = createHarness();
    const token = "G".repeat(43);
    for (let i = 0; i < SHARE_OPEN_LIMITS.tokenHumanCheckAfter; i += 1) {
      await open(h, { token, password: "guess" }, `192.0.2.${50 + i}`);
    }
    const outage = await open(h, { token, password: "guess", turnstileToken: OUTAGE_HUMAN_TOKEN });
    expect(outage.status).toBe(503);
    expect((await outage.json<{ error: { code: string } }>()).error.code).toBe(
      "capacity_unavailable",
    );
  });

  it("counts failures for unknown tokens like real ones, so the human check reveals nothing", async () => {
    const h = createHarness();
    const token = "D".repeat(43);
    for (let i = 0; i < SHARE_OPEN_LIMITS.tokenHumanCheckAfter; i += 1) {
      expect((await open(h, { token, password: "guess" }, `192.0.2.${i}`)).status).toBe(403);
    }
    const next = await open(h, { token, password: "guess" }, "192.0.2.99");
    expect((await next.json<{ error: { code: string } }>()).error.code).toBe(
      "human_verification_required",
    );
  });

  it("limits requests per IP", async () => {
    const h = createHarness();
    for (let i = 0; i < SHARE_OPEN_LIMITS.perIp.max; i += 1) {
      await open(h, { token: "E".repeat(43) }, "192.0.2.200");
    }
    const limited = await open(h, { token: "E".repeat(43) }, "192.0.2.200");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect((await open(h, { token: "E".repeat(43) }, "192.0.2.201")).status).toBe(404);
  });

  it("ignores the visitor's account: a session cookie changes nothing", async () => {
    const b = await both("share-session@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "session");
    const { token } = await linkFor(b, id);
    const cookie = await b.h.signIn("share-session-visitor@example.test");
    const response = await open(b.h, { token }, "203.0.113.9", { cookie });
    expect(response.status).toBe(200);
    const handoffs = await db()
      .select()
      .from(schema.shareHandoffs)
      .where(eq(schema.shareHandoffs.artifactId, id));
    expect(Object.keys(handoffs[0] ?? {})).not.toContain("userId");
  });

  it("never writes the token or the password to a log, and gives a link visitor nothing on the app", async () => {
    const b = await both("share-logs@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "logs");
    const { token } = await linkFor(b, id, { password: "correct horse" });
    const logged: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );
    try {
      await open(b.h, { token });
      await open(b.h, { token, password: "wrong horse" });
      const opened = await open(b.h, { token, password: "correct horse" });
      expect(opened.status).toBe(200);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const text = JSON.stringify(logged);
    expect(text).not.toContain(token);
    expect(text).not.toContain("correct horse");

    // Opening a link gives the browser no credential on the app: no cookie is set, and the
    // annotations API and review codes still need an account.
    const response = await open(b.h, { token, password: "correct horse" });
    expect(response.headers.get("set-cookie")).toBeNull();
    const annotations = await b.h.request(`/api/v1/artifacts/${id}/annotations`, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(annotations.status).toBe(401);
    const review = await b.h.request(`/api/v1/artifacts/${id}/review`, {
      method: "POST",
      headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
    });
    expect([401, 403]).toContain(review.status);
  });

  it("records the day a link was used, also for a request that names no IP", async () => {
    const b = await both("share-used@example.test");
    await onPlan(b.userId, "pro");
    const id = await publish(b, "used");
    const { token, id: linkId } = await linkFor(b, id, {
      expiresAt: new Date(NOW + 86_400_000).toISOString(),
    });
    const response = await b.h.request("/api/v1/share/open", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    const list = await (await b.apiCall(`/api/v1/artifacts/${id}/share-links`)).json<{
      links: { id: string; lastUsedOn: string | null }[];
    }>();
    expect(list.links.find((link) => link.id === linkId)?.lastUsedOn).toBe("2026-11-02");
    const text = (await b.tool("list_share_links", { artifactId: id })).content[0]?.text ?? "";
    expect(text).toContain(`${linkId} active expires 2026-11-03T09:00:00.000Z: Link`);
    expect(text).not.toContain("with password");
  });

  it("keeps the body small", async () => {
    const h = createHarness();
    const response = await open(h, {
      token: "F".repeat(43),
      password: "x".repeat(SHARE_LINKS.openBodyMaxBytes),
    });
    expect(response.status).toBe(404);
  });
});

describe("the entry page", () => {
  it("is served at /s without a redirect, noindex, without a referrer and with the human check", async () => {
    const response = await SELF.fetch(`${ORIGIN}/s`, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe(SHARE_CSP);
    expect(SHARE_CSP).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("Open a shared artifact");
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).toContain("portifact-turnstile-site-key");
  });
});
