// Custom domains through /api/v1 and MCP (decision 0006): the same bodies, errors and permission
// boundaries in both, the scopes the decision names, the Idempotency-Key of adding, and the
// feature switched off. Cloudflare and DNS are the in-memory fake.
import { env } from "cloudflare:workers";
import { type CustomDomainView, txtRecordName } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { FakeDomains } from "@portifact/services/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
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
/** Idempotency keys, generated so no literal looks like a credential. */
const KEY = crypto.randomUUID();
const OTHER_KEY = crypto.randomUUID();
const SCOPES = "artifacts:read artifacts:write artifacts:share offline_access";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface Both {
  h: Harness;
  fake: FakeDomains;
  userId: string;
  apiCall: (path: string, init?: RequestInit) => Promise<Response>;
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

async function both(
  email: string,
  options: { scope?: string; switchedOn?: boolean } = {},
): Promise<Both> {
  const fake = new FakeDomains();
  const h = createHarness(options.switchedOn === false ? {} : { domains: fake });
  const scope = options.scope ?? SCOPES;
  const apiAccess = await apiToken(h, email, scope);
  const client = await connect(h, await mcpToken(h, email, scope));
  const apiCall = (path: string, init?: RequestInit) => api(h, apiAccess, path, init);
  const { userId } = await (await apiCall("/api/v1/me")).json<{ userId: string }>();
  return { h, fake, userId, apiCall, tool: (name, args) => callTool(client, name, args) };
}

async function fromApi(response: Response) {
  return { ok: response.ok, body: await response.json<unknown>() };
}
function fromTool(result: ToolResult) {
  return { ok: result.isError !== true, body: result.structuredContent };
}

const db = () => regionsFromEnv(env).get("default").db;

async function onPlan(ownerId: string, plan: "free" | "pro" | "team") {
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId, plan, seats: 1, grantedBy: "test", updatedAt: NOW })
    .onConflictDoUpdate({ target: schema.ownerPlans.ownerId, set: { plan } });
}

async function publish(b: Both, name: string): Promise<string> {
  const result = fromTool(await b.tool("publish_document", { type: "text", name, content: name }));
  return (result.body as { artifactId: string }).artifactId;
}

function addViaApi(b: Both, artifactId: string, hostname: string, key = crypto.randomUUID()) {
  return b.apiCall(`/api/v1/artifacts/${artifactId}/domain`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ hostname }),
  });
}

/** A view without what differs between two domains of one test. */
function shape(body: unknown) {
  const view = body as CustomDomainView;
  return {
    state: view.state,
    problem: view.problem,
    records: view.records.map((record) => record.type),
    claimExpiresAt: view.claimExpiresAt,
    verifiedAt: view.verifiedAt,
  };
}

describe("custom domains through the API and MCP", () => {
  it("add, verify, list, get and remove give the same answers", async () => {
    const b = await both("domains-parity@example.test");
    await onPlan(b.userId, "team");
    const [viaApi, viaMcp] = [await publish(b, "api"), await publish(b, "mcp")];
    const hostApi = "docs-api.example.com";
    const hostMcp = "docs-mcp.example.com";

    const addedApi = await fromApi(await addViaApi(b, viaApi, hostApi));
    const addedMcp = fromTool(
      await b.tool("add_custom_domain", { artifactId: viaMcp, hostname: hostMcp }),
    );
    expect(addedApi.ok).toBe(true);
    expect(shape(addedMcp.body)).toEqual(shape(addedApi.body));
    const api = addedApi.body as CustomDomainView;
    expect(api.records).toEqual([
      {
        type: "TXT",
        name: `_portifact.${hostApi}`,
        value: expect.stringMatching(/^portifact-verify=[0-9a-f]{32}$/),
      },
      { type: "CNAME", name: hostApi, value: "domains.portifact.dev" },
    ]);

    // Not proven yet: both report the missing record.
    const pendingApi = await fromApi(
      await b.apiCall(`/api/v1/domains/${hostApi}/verify`, { method: "POST" }),
    );
    const pendingMcp = fromTool(await b.tool("verify_custom_domain", { hostname: hostMcp }));
    expect(shape(pendingMcp.body)).toEqual(shape(pendingApi.body));
    expect((pendingApi.body as CustomDomainView).problem).toBe("txt_missing");

    for (const [host, view] of [
      [hostApi, addedApi.body],
      [hostMcp, addedMcp.body],
    ] as const) {
      const txt = (view as CustomDomainView).records[0];
      b.fake.publishTxt(txtRecordName(host), txt?.value ?? "");
    }
    const provApi = await fromApi(
      await b.apiCall(`/api/v1/domains/${hostApi}/verify`, { method: "POST" }),
    );
    const provMcp = fromTool(await b.tool("verify_custom_domain", { hostname: hostMcp }));
    expect(shape(provMcp.body)).toEqual(shape(provApi.body));
    expect((provApi.body as CustomDomainView).state).toBe("provisioning");

    b.fake.activate(hostApi);
    b.fake.activate(hostMcp);
    await b.apiCall(`/api/v1/domains/${hostApi}/verify`, { method: "POST" });
    await b.tool("verify_custom_domain", { hostname: hostMcp });
    const gotApi = await fromApi(await b.apiCall(`/api/v1/domains/${hostApi}`));
    const gotMcp = fromTool(await b.tool("get_custom_domain", { hostname: hostMcp }));
    expect(shape(gotMcp.body)).toEqual(shape(gotApi.body));
    expect((gotApi.body as CustomDomainView).state).toBe("active");

    const listApi = await fromApi(await b.apiCall("/api/v1/domains"));
    const listMcp = fromTool(await b.tool("list_custom_domains", {}));
    expect(listMcp).toEqual(listApi);
    expect(listApi.body).toMatchObject({ available: true, enabled: true, limit: 5, used: 2 });
    const oneApi = await fromApi(await b.apiCall(`/api/v1/domains?artifactId=${viaApi}`));
    const oneMcp = fromTool(await b.tool("list_custom_domains", { artifactId: viaApi }));
    expect(oneMcp).toEqual(oneApi);
    expect((oneApi.body as { domains: unknown[] }).domains).toHaveLength(1);

    const removedApi = await fromApi(
      await b.apiCall(`/api/v1/domains/${hostApi}`, { method: "DELETE" }),
    );
    expect(removedApi).toEqual({ ok: true, body: { hostname: hostApi, removed: true } });
    expect(
      fromTool(await b.tool("remove_custom_domain", { hostname: hostMcp, confirm: "nope" })),
    ).toEqual({
      ok: false,
      body: {
        error: {
          code: "invalid_input",
          message: "Pass confirm equal to the hostname to remove it.",
        },
      },
    });
    expect(
      fromTool(await b.tool("remove_custom_domain", { hostname: hostMcp, confirm: hostMcp })),
    ).toEqual({
      ok: true,
      body: { hostname: hostMcp, removed: true },
    });
    const after = await fromApi(await b.apiCall(`/api/v1/domains/${hostMcp}`));
    expect((after.body as CustomDomainView).state).toBe("removing");
    expect(fromTool(await b.tool("get_custom_domain", { hostname: hostMcp }))).toEqual(after);
  });

  it("refuses the same way in both", async () => {
    const b = await both("domains-errors@example.test");
    const other = await both("domains-errors-other@example.test");
    await onPlan(b.userId, "pro");
    await onPlan(other.userId, "pro");
    const [mine, second] = [await publish(b, "a"), await publish(b, "b")];
    const theirs = await publish(other, "c");
    const cases: [string, string][] = [
      [mine, "example.com"],
      [mine, "app.portifact.com"],
      [mine, "*.example.com"],
      [mine, "127.0.0.1"],
      ["abcdefghij", "docs.example.com"],
      [theirs, "docs.example.com"],
    ];
    for (const [artifactId, hostname] of cases) {
      const viaApi = await fromApi(await addViaApi(b, artifactId, hostname));
      const viaMcp = fromTool(await b.tool("add_custom_domain", { artifactId, hostname }));
      expect(viaApi.ok, `${artifactId} ${hostname}`).toBe(false);
      expect(viaMcp, `${artifactId} ${hostname}`).toEqual(viaApi);
    }
    // Listing another account's artifact answers like a missing one, at both.
    const listed = await fromApi(await b.apiCall(`/api/v1/domains?artifactId=${theirs}`));
    expect(listed).toEqual({
      ok: false,
      body: { error: { code: "not_found", message: "Artifact not found." } },
    });
    expect(fromTool(await b.tool("list_custom_domains", { artifactId: theirs }))).toEqual(listed);
    // Another account's artifact answers exactly like a missing one.
    const missing = await fromApi(await addViaApi(b, "abcdefghij", "docs.example.com"));
    expect(await fromApi(await addViaApi(b, theirs, "docs.example.com"))).toEqual(missing);
    // Past the plan's count.
    expect((await addViaApi(b, mine, "one.example.com")).status).toBe(201);
    const claim = (
      await (await b.apiCall("/api/v1/domains/one.example.com")).json<CustomDomainView>()
    ).records[0];
    b.fake.publishTxt("_portifact.one.example.com", claim?.value ?? "");
    await b.apiCall("/api/v1/domains/one.example.com/verify", { method: "POST" });
    const overApi = await fromApi(await addViaApi(b, second, "two.example.com"));
    const overMcp = fromTool(
      await b.tool("add_custom_domain", { artifactId: second, hostname: "two.example.com" }),
    );
    expect(overMcp).toEqual(overApi);
    expect(overApi.body).toMatchObject({ error: { code: "quota_exceeded" } });
    // Another account's hostname answers like a missing one, for every hostname operation.
    for (const [path, init, tool, args] of [
      [
        "/api/v1/domains/one.example.com",
        undefined,
        "get_custom_domain",
        { hostname: "one.example.com" },
      ],
      [
        "/api/v1/domains/one.example.com/verify",
        { method: "POST" },
        "verify_custom_domain",
        { hostname: "one.example.com" },
      ],
      [
        "/api/v1/domains/one.example.com",
        { method: "DELETE" },
        "remove_custom_domain",
        { hostname: "one.example.com", confirm: "one.example.com" },
      ],
    ] as const) {
      const viaApi = await fromApi(await other.apiCall(path, init));
      expect(viaApi).toEqual({
        ok: false,
        body: { error: { code: "not_found", message: "Custom domain not found." } },
      });
      expect(fromTool(await other.tool(tool, args))).toEqual(viaApi);
    }
  });

  it("adding takes an Idempotency-Key, shared with the tool's idempotencyKey", async () => {
    const b = await both("domains-keys@example.test");
    await onPlan(b.userId, "pro");
    const artifactId = await publish(b, "keyed");
    const withoutKey = await b.apiCall(`/api/v1/artifacts/${artifactId}/domain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "keyed.example.com" }),
    });
    expect(withoutKey.status).toBe(400);
    const first = await fromApi(await addViaApi(b, artifactId, "keyed.example.com", KEY));
    expect(await fromApi(await addViaApi(b, artifactId, "keyed.example.com", KEY))).toEqual(first);
    expect(
      fromTool(
        await b.tool("add_custom_domain", {
          artifactId,
          hostname: "keyed.example.com",
          idempotencyKey: KEY,
        }),
      ),
    ).toEqual(first);
    expect(await fromApi(await addViaApi(b, artifactId, "other.example.com", KEY))).toMatchObject({
      ok: false,
      body: { error: { code: "invalid_input" } },
    });
    expect(
      fromTool(
        await b.tool("add_custom_domain", {
          artifactId,
          hostname: "other.example.com",
          idempotencyKey: KEY,
        }),
      ),
    ).toEqual({
      ok: false,
      body: {
        error: {
          code: "invalid_input",
          message: "This idempotency key was used for a different request.",
        },
      },
    });
    // A body the route cannot read is refused before anything runs.
    const malformed = await b.apiCall(`/api/v1/artifacts/${artifactId}/domain`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": OTHER_KEY },
      body: JSON.stringify({ hostname: "docs.example.com", extra: true }),
    });
    expect(malformed.status).toBe(400);
  });

  it("needs artifacts:share to change domains and artifacts:read to read them, at both", async () => {
    const b = await both("domains-scopes@example.test");
    const reader = await mcpToken(b.h, "domains-scopes@example.test", "artifacts:read");
    const readerApi = await apiToken(b.h, "domains-scopes@example.test", "artifacts:read");
    for (const [tool, args] of [
      ["add_custom_domain", { artifactId: "abcdefghij", hostname: "docs.example.com" }],
      ["verify_custom_domain", { hostname: "docs.example.com" }],
      ["remove_custom_domain", { hostname: "docs.example.com", confirm: "docs.example.com" }],
    ] as const) {
      const denied = await rawCall(b.h, reader, tool, args);
      expect(denied.status, tool).toBe(403);
      expect(denied.headers.get("www-authenticate"), tool).toContain('scope="artifacts:share"');
    }
    for (const [path, init] of [
      [
        "/api/v1/artifacts/abcdefghij/domain",
        { method: "POST", headers: { "idempotency-key": KEY } },
      ],
      ["/api/v1/domains/docs.example.com/verify", { method: "POST" }],
      ["/api/v1/domains/docs.example.com", { method: "DELETE" }],
    ] as const) {
      const denied = await api(b.h, readerApi, path, init);
      expect(denied.status, path).toBe(403);
      expect(denied.headers.get("www-authenticate"), path).toContain('scope="artifacts:share"');
    }
    expect((await api(b.h, readerApi, "/api/v1/domains")).status).toBe(200);
    expect((await rawCall(b.h, reader, "list_custom_domains", {})).status).toBe(200);
  });

  it("answers capacity_unavailable while the feature is switched off, and lists it unavailable", async () => {
    const b = await both("domains-off@example.test", { switchedOn: false });
    await onPlan(b.userId, "pro");
    const artifactId = await publish(b, "off");
    const viaApi = await fromApi(await addViaApi(b, artifactId, "off.example.com"));
    expect(viaApi).toEqual({
      ok: false,
      body: {
        error: { code: "capacity_unavailable", message: "Custom domains are not available yet." },
      },
    });
    expect(
      fromTool(await b.tool("add_custom_domain", { artifactId, hostname: "off.example.com" })),
    ).toEqual(viaApi);
    const list = await fromApi(await b.apiCall(`/api/v1/domains?artifactId=${artifactId}`));
    expect(list.body).toMatchObject({
      available: false,
      enabled: true,
      limit: 1,
      used: 0,
      domains: [],
    });
    expect((await b.apiCall("/api/v1/domains?artifactId=nope")).status).toBe(400);
  });
});
