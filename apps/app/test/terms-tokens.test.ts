// A person's OAuth token acts for them only under the current terms (docs/legal.md, "API and MCP
// clients"): the CLI's API token and an MCP client's token keep reading and downloading, and
// removing or narrowing what the account shares, and every other operation answers
// `terms_not_accepted` until the account accepts in the dashboard, with the same code through the
// API and MCP. Which operation is which: terms-operations.test.ts.
import { env } from "cloudflare:workers";
import { TERMS_VERSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { HELD_MESSAGE } from "@portifact/domain";
import { placeLegalHold, suspendArtifact } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { authorizeWithPkce, exchangeCode, type TokenResponse } from "./flows.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken, callTool, connect, registerClient, rpc } from "./mcp-helpers.ts";

const CLI_SCOPES =
  "artifacts:read artifacts:write artifacts:share artifacts:delete annotations:read credentials:manage offline_access";
const MCP_SCOPES =
  "artifacts:read artifacts:write artifacts:share artifacts:delete annotations:read offline_access";

async function setTerms(email: string, version: string | null) {
  await env.DB.prepare("update users set terms_version = ? where email = ?")
    .bind(version, email)
    .run();
}

async function mcpAccessToken(h: Harness, email: string): Promise<string> {
  const clientId = await registerClient(h, MCP_SCOPES);
  const cookie = await h.signIn(email);
  const callback = await authorizeWithPkce(h, { clientId, cookie, scope: MCP_SCOPES });
  const response = await exchangeCode(h, { clientId, ...callback });
  expect(response.status).toBe(200);
  return (await response.json<TokenResponse>()).access_token;
}

const body = (method: string, value: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

interface Setup {
  h: Harness;
  email: string;
  userId: string;
  cli: string;
  mcp: Awaited<ReturnType<typeof connect>>;
  mcpAccess: string;
  /** Public, with a reader on its list. */
  artifactId: string;
  /** Restricted. */
  privateId: string;
}

async function publish(mcp: Setup["mcp"], name: string): Promise<string> {
  const published = await callTool(mcp, "publish_document", { type: "text", name, content: name });
  expect(published.isError).toBeFalsy();
  return (published.structuredContent as { artifactId: string }).artifactId;
}

/**
 * An account on the Pro plan with a CLI token, an MCP client, a public artifact with a reader and
 * a private one, then left on an older version of the terms.
 */
async function olderVersion(email: string): Promise<Setup> {
  const h = createHarness();
  const cli = await apiToken(h, email, CLI_SCOPES);
  const { userId } = await (await api(h, cli, "/api/v1/me")).json<{ userId: string }>();
  await regionsFromEnv(env)
    .get("default")
    .db.insert(schema.ownerPlans)
    .values({ ownerId: userId, plan: "pro", seats: 1, grantedBy: "test", updatedAt: Date.now() })
    .onConflictDoNothing();
  const mcpAccess = await mcpAccessToken(h, email);
  const mcp = await connect(h, mcpAccess);
  const artifactId = await publish(mcp, "Notes");
  const privateId = await publish(mcp, "Private");
  // Old enough to make an artifact public.
  await env.DB.prepare("update users set created_at = ? where id = ?")
    .bind(Date.now() - 86_400_000, userId)
    .run();
  const widened = await api(
    h,
    cli,
    `/api/v1/artifacts/${artifactId}/access`,
    body("PATCH", { mode: "public", addReaders: ["reader@example.test"] }),
  );
  expect(widened.status, await widened.clone().text()).toBe(200);
  await setTerms(email, "2000-01-01");
  return { h, email, userId, cli, mcp, mcpAccess, artifactId, privateId };
}

async function refusal(response: Response) {
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json<{ error: { code: string; message: string } }>()).error;
}

type ToolError = { error: { code: string; message: string } };

describe("a person's API token without the current terms", () => {
  it("still reads and downloads, and says who it belongs to", async () => {
    const s = await olderVersion("terms-api-read@example.test");
    expect((await api(s.h, s.cli, "/api/v1/artifacts")).status).toBe(200);
    expect((await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}`)).status).toBe(200);
    expect((await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}/versions`)).status).toBe(200);
    expect((await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}/share-links`)).status).toBe(
      200,
    );
    expect((await api(s.h, s.cli, "/api/v1/usage")).status).toBe(200);
    expect((await api(s.h, s.cli, "/api/v1/me")).status).toBe(200);
  });

  it("is refused anything that creates, publishes or widens, with where to accept", async () => {
    const s = await olderVersion("terms-api-write@example.test");
    const renew = await refusal(
      await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}/renew`, { method: "POST" }),
    );
    expect(renew.code).toBe("terms_not_accepted");
    expect(renew.message).toContain(`version ${TERMS_VERSION}`);
    expect(renew.message).toContain(`open ${ORIGIN} in a browser`);
    expect(renew.message).toContain("update the CLI or open the dashboard");
    expect(renew.message).not.toContain("Ask the user");

    const link = await refusal(
      await api(
        s.h,
        s.cli,
        `/api/v1/artifacts/${s.artifactId}/share-links`,
        body("POST", { label: "x" }),
      ),
    );
    expect(link.code).toBe("terms_not_accepted");
    const published = await refusal(
      await api(s.h, s.cli, "/api/v1/publishes", body("POST", { name: "n" })),
    );
    expect(published.code).toBe("terms_not_accepted");
  });

  it("refuses an access change that widens anything, in the service, and changes nothing", async () => {
    const s = await olderVersion("terms-api-widen@example.test");
    const path = `/api/v1/artifacts/${s.privateId}/access`;
    for (const change of [
      { mode: "public" },
      { addReaders: ["new@example.test"] },
      { mode: "restricted", indexable: true },
      { commentVisibility: "everyone" },
    ]) {
      const refused = await refusal(await api(s.h, s.cli, path, body("PATCH", change)));
      expect(refused.code, JSON.stringify(change)).toBe("terms_not_accepted");
      expect(refused.message).toContain("open the Portifact dashboard in a browser");
    }
    const access = await api(s.h, s.cli, path);
    expect(await access.json()).toMatchObject({ mode: "restricted", readers: [] });
  });

  it("narrows access, removes readers and archives, unpins and deletes", async () => {
    const s = await olderVersion("terms-api-leave@example.test");
    const path = `/api/v1/artifacts/${s.artifactId}/access`;
    const narrowed = await api(
      s.h,
      s.cli,
      path,
      body("PATCH", { mode: "restricted", removeReaders: ["reader@example.test"] }),
    );
    expect(narrowed.status, await narrowed.clone().text()).toBe(200);
    expect(await narrowed.json()).toMatchObject({ mode: "restricted", readers: [] });

    const archive = await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}/archive`, {
      method: "POST",
    });
    expect(archive.status, await archive.clone().text()).toBe(200);
    const unpin = await api(s.h, s.cli, `/api/v1/artifacts/${s.privateId}/unpin`, {
      method: "POST",
    });
    expect(unpin.status, await unpin.clone().text()).toBe(200);
    const removed = await api(s.h, s.cli, `/api/v1/artifacts/${s.privateId}`, {
      method: "DELETE",
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
  });

  it("is refused deleting a held artifact for the hold's reason, without learning it, through the API and MCP", async () => {
    const s = await olderVersion("terms-api-held@example.test");
    const db = regionsFromEnv(env).get("default").db;
    await suspendArtifact(db, { artifactId: s.privateId, reason: "child_safety", now: Date.now() });
    await placeLegalHold(db, {
      artifactId: s.privateId,
      ground: "Authority",
      releaseAt: null,
      now: Date.now(),
    });
    const viaApi = await api(s.h, s.cli, `/api/v1/artifacts/${s.privateId}`, { method: "DELETE" });
    expect(viaApi.status).toBe(403);
    const answered = await viaApi.json<{ error: { code: string; message: string } }>();
    expect(answered).toEqual({ error: { code: "forbidden", message: HELD_MESSAGE } });
    const viaMcp = await callTool(s.mcp, "delete_artifact", {
      artifactId: s.privateId,
      confirm: s.privateId,
    });
    expect(viaMcp.structuredContent).toEqual(answered);
  });

  it("revokes a share link it can no longer create", async () => {
    const email = "terms-api-link@example.test";
    const s = await olderVersion(email);
    await setTerms(email, TERMS_VERSION);
    const created = await api(
      s.h,
      s.cli,
      `/api/v1/artifacts/${s.artifactId}/share-links`,
      body("POST", { label: "Client" }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const { link } = await created.json<{ link: { id: string } }>();
    await setTerms(email, "2000-01-01");
    const revoked = await api(
      s.h,
      s.cli,
      `/api/v1/artifacts/${s.artifactId}/share-links/${link.id}`,
      { method: "DELETE" },
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);
  });

  it("turns off and deletes a webhook, never creates, enables or tests one", async () => {
    const email = "terms-api-webhook@example.test";
    const s = await olderVersion(email);
    await setTerms(email, TERMS_VERSION);
    const created = await api(
      s.h,
      s.cli,
      "/api/v1/webhooks",
      body("POST", { url: "https://hooks.example.com/in", events: ["artifact.published"] }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const { webhook } = await created.json<{ webhook: { id: string } }>();
    await setTerms(email, "2000-01-01");

    const hook = `/api/v1/webhooks/${webhook.id}`;
    const another = await refusal(
      await api(
        s.h,
        s.cli,
        "/api/v1/webhooks",
        body("POST", { url: "https://hooks.example.com/b", events: ["artifact.published"] }),
      ),
    );
    expect(another.code).toBe("terms_not_accepted");
    expect((await refusal(await api(s.h, s.cli, `${hook}/test`, { method: "POST" }))).code).toBe(
      "terms_not_accepted",
    );
    for (const change of [{ enabled: true }, { events: ["artifact.published"] }]) {
      const refused = await refusal(await api(s.h, s.cli, hook, body("PATCH", change)));
      expect(refused.code, JSON.stringify(change)).toBe("terms_not_accepted");
    }
    const off = await api(s.h, s.cli, hook, body("PATCH", { enabled: false }));
    expect(off.status, await off.clone().text()).toBe(200);
    expect(await off.json()).toMatchObject({ state: "disabled" });
    const removed = await api(s.h, s.cli, hook, { method: "DELETE" });
    expect(removed.status).toBe(200);
  });

  it("can still list and revoke the account's own tokens", async () => {
    const s = await olderVersion("terms-api-tokens@example.test");
    const listed = await api(s.h, s.cli, "/api/v1/tokens");
    expect(listed.status).toBe(200);
    const apps = (await listed.json<{ items: { clientId: string; current: boolean }[] }>()).items;
    const other = apps.find((app) => !app.current);
    expect(other).toBeDefined();
    const revoked = await api(s.h, s.cli, `/api/v1/tokens/${other?.clientId}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    // The MCP client's token is gone.
    expect((await rpc(s.h, s.mcpAccess, "tools/list")).status).toBe(401);
  });

  it("acts again as soon as the account accepts, with the same token", async () => {
    const s = await olderVersion("terms-api-accept@example.test");
    const path = `/api/v1/artifacts/${s.artifactId}/renew`;
    expect((await api(s.h, s.cli, path, { method: "POST" })).status).toBe(403);
    await setTerms(s.email, TERMS_VERSION);
    expect((await api(s.h, s.cli, path, { method: "POST" })).status).toBe(200);
  });

  it("is refused when the account never accepted any version", async () => {
    const s = await olderVersion("terms-api-never@example.test");
    await setTerms(s.email, null);
    const response = await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}/renew`, {
      method: "POST",
    });
    expect((await refusal(response)).code).toBe("terms_not_accepted");
  });
});

describe("an MCP client without the current terms", () => {
  it("still lists tools and runs the read tools", async () => {
    const s = await olderVersion("terms-mcp-read@example.test");
    const tools = await s.mcp.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("publish_document");
    expect((await callTool(s.mcp, "list_artifacts", {})).isError).toBeFalsy();
    expect(
      (await callTool(s.mcp, "read_artifact", { artifactId: s.artifactId })).isError,
    ).toBeFalsy();
    expect(
      (await callTool(s.mcp, "list_share_links", { artifactId: s.artifactId })).isError,
    ).toBeFalsy();
  });

  it("gets the API's error as the tool's result, telling the agent to ask the user", async () => {
    const s = await olderVersion("terms-mcp-write@example.test");
    const viaMcp = await callTool(s.mcp, "renew_artifact", { artifactId: s.artifactId });
    expect(viaMcp.isError).toBe(true);
    const { error } = viaMcp.structuredContent as ToolError;
    expect(error.code).toBe("terms_not_accepted");
    expect(error.message).toContain(`open ${ORIGIN} in a browser`);
    expect(error.message).toContain("Ask the user to do it");

    // Parity: the same operation through the API answers the same code.
    const viaApi = await refusal(
      await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}/renew`, { method: "POST" }),
    );
    expect(viaApi.code).toBe(error.code);
    expect(error.message.startsWith(viaApi.message)).toBe(true);

    const published = await callTool(s.mcp, "publish_document", {
      type: "text",
      name: "More",
      content: "no",
    });
    expect(published.structuredContent).toMatchObject({ error: { code: "terms_not_accepted" } });
    const added = await callTool(s.mcp, "add_reader", {
      artifactId: s.privateId,
      emails: ["new@example.test"],
    });
    expect(added.structuredContent).toMatchObject({ error: { code: "terms_not_accepted" } });
  });

  it("narrows and removes like the API, and refuses widening in the service alike", async () => {
    const s = await olderVersion("terms-mcp-leave@example.test");
    const widen = await callTool(s.mcp, "set_access", { artifactId: s.privateId, mode: "public" });
    const widenError = (widen.structuredContent as ToolError).error;
    expect(widenError.code).toBe("terms_not_accepted");
    expect(widenError.message).toContain("Ask the user to do it");
    const viaApi = await refusal(
      await api(
        s.h,
        s.cli,
        `/api/v1/artifacts/${s.privateId}/access`,
        body("PATCH", { mode: "public" }),
      ),
    );
    expect(widenError.message.startsWith(viaApi.message)).toBe(true);

    const removed = await callTool(s.mcp, "remove_reader", {
      artifactId: s.artifactId,
      emails: ["reader@example.test"],
    });
    expect(removed.isError, JSON.stringify(removed.structuredContent)).toBeFalsy();
    const narrowed = await callTool(s.mcp, "set_access", {
      artifactId: s.artifactId,
      mode: "restricted",
    });
    expect(narrowed.isError, JSON.stringify(narrowed.structuredContent)).toBeFalsy();
    expect(narrowed.structuredContent).toMatchObject({ mode: "restricted" });
    const archived = await callTool(s.mcp, "archive_artifact", { artifactId: s.artifactId });
    expect(archived.isError).toBeFalsy();
    const deleted = await callTool(s.mcp, "delete_artifact", {
      artifactId: s.privateId,
      confirm: s.privateId,
    });
    expect(deleted.isError, JSON.stringify(deleted.structuredContent)).toBeFalsy();
  });

  it("runs every tool again once the account accepts", async () => {
    const s = await olderVersion("terms-mcp-accept@example.test");
    await setTerms(s.email, TERMS_VERSION);
    // A new connection, as a client makes for its next session.
    const client = await connect(s.h, s.mcpAccess);
    const renewed = await callTool(client, "renew_artifact", { artifactId: s.artifactId });
    expect(renewed.isError).toBeFalsy();
  });
});
