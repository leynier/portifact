// A person's OAuth token acts for them only under the current terms (docs/legal.md, "API and MCP
// clients"): the CLI's API token and an MCP client's token keep reading and downloading, and
// every other operation answers `terms_not_accepted` until the account accepts in the dashboard,
// with the same code through the API and MCP. Service tokens are not people and are not asked.
import { env } from "cloudflare:workers";
import { TERMS_VERSION } from "@portifact/contracts";
import { usableWithoutCurrentTerms } from "@portifact/domain";
import { describe, expect, it } from "vitest";
import { TOOL_SCOPES } from "../src/mcp/tools.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken, rpc } from "./mcp-helpers.ts";

const CLI_SCOPES =
  "artifacts:read artifacts:write artifacts:delete annotations:read credentials:manage offline_access";
const MCP_SCOPES =
  "artifacts:read artifacts:write artifacts:delete annotations:read offline_access";

async function setTerms(email: string, version: string) {
  await env.DB.prepare("update users set terms_version = ? where email = ?")
    .bind(version, email)
    .run();
}

interface Setup {
  h: Harness;
  email: string;
  cli: string;
  mcp: Awaited<ReturnType<typeof connect>>;
  mcpAccess: string;
  artifactId: string;
}

/** An account with a CLI token, an MCP client and one artifact, then left on an older version. */
async function olderVersion(email: string): Promise<Setup> {
  const h = createHarness();
  const cli = await apiToken(h, email, CLI_SCOPES);
  const mcpAccess = await mcpToken(h, email, MCP_SCOPES);
  const mcp = await connect(h, mcpAccess);
  const published = await callTool(mcp, "publish_document", {
    type: "text",
    name: "Notes",
    content: "kept",
  });
  expect(published.isError).toBeFalsy();
  const artifactId = (published.structuredContent as { artifactId: string }).artifactId;
  await setTerms(email, "2000-01-01");
  return { h, email, cli, mcp, mcpAccess, artifactId };
}

async function refusal(response: Response) {
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json<{ error: { code: string; message: string } }>()).error;
}

describe("a person's API token without the current terms", () => {
  it("still reads and downloads, and says who it belongs to", async () => {
    const s = await olderVersion("terms-api-read@example.test");
    expect((await api(s.h, s.cli, "/api/v1/artifacts")).status).toBe(200);
    expect((await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}`)).status).toBe(200);
    expect((await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}/versions`)).status).toBe(200);
    expect((await api(s.h, s.cli, "/api/v1/usage")).status).toBe(200);
    expect((await api(s.h, s.cli, "/api/v1/me")).status).toBe(200);
  });

  it("is refused anything that changes data, with where to accept", async () => {
    const s = await olderVersion("terms-api-write@example.test");
    const archive = await refusal(
      await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}/archive`, { method: "POST" }),
    );
    expect(archive.code).toBe("terms_not_accepted");
    expect(archive.message).toContain(`version ${TERMS_VERSION}`);
    expect(archive.message).toContain(`open ${ORIGIN} in a browser`);
    expect(archive.message).not.toContain("Ask the user");

    const removed = await refusal(
      await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}`, { method: "DELETE" }),
    );
    expect(removed.code).toBe("terms_not_accepted");
    // Nothing happened.
    const still = await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}`);
    expect((await still.json<{ state: string }>()).state).toBe("active");
  });

  it("is refused opening a channel out of the account", async () => {
    const s = await olderVersion("terms-api-webhook@example.test");
    const created = await refusal(
      await api(s.h, s.cli, "/api/v1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://hooks.example.test/in", events: ["comment.created"] }),
      }),
    );
    expect(created.code).toBe("terms_not_accepted");
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
    const path = `/api/v1/artifacts/${s.artifactId}/archive`;
    expect((await api(s.h, s.cli, path, { method: "POST" })).status).toBe(403);
    await setTerms(s.email, TERMS_VERSION);
    expect((await api(s.h, s.cli, path, { method: "POST" })).status).toBe(200);
  });

  it("is refused when the account never accepted any version", async () => {
    const s = await olderVersion("terms-api-never@example.test");
    await env.DB.prepare("update users set terms_version = null where email = ?")
      .bind(s.email)
      .run();
    const response = await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}/archive`, {
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
    const listed = await callTool(s.mcp, "list_artifacts", {});
    expect(listed.isError).toBeFalsy();
    const read = await callTool(s.mcp, "read_artifact", { artifactId: s.artifactId });
    expect(read.isError).toBeFalsy();
  });

  it("gets the API's error as the tool's result, telling the agent to ask the user", async () => {
    const s = await olderVersion("terms-mcp-write@example.test");
    const viaMcp = await callTool(s.mcp, "archive_artifact", { artifactId: s.artifactId });
    expect(viaMcp.isError).toBe(true);
    const error = (viaMcp.structuredContent as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("terms_not_accepted");
    expect(error.message).toContain(`open ${ORIGIN} in a browser`);
    expect(error.message).toContain("Ask the user to do it");

    // Parity: the same operation through the API answers the same code.
    const viaApi = await refusal(
      await api(s.h, s.cli, `/api/v1/artifacts/${s.artifactId}/archive`, { method: "POST" }),
    );
    expect(viaApi.code).toBe(error.code);
    expect(error.message.startsWith(viaApi.message)).toBe(true);

    const published = await callTool(s.mcp, "publish_document", {
      type: "text",
      name: "More",
      content: "no",
    });
    expect(published.structuredContent).toMatchObject({ error: { code: "terms_not_accepted" } });
    const listed = await api(s.h, s.cli, "/api/v1/artifacts");
    expect((await listed.json<{ items: unknown[] }>()).items).toHaveLength(1);
  });

  it("runs every tool again once the account accepts", async () => {
    const s = await olderVersion("terms-mcp-accept@example.test");
    await setTerms(s.email, TERMS_VERSION);
    // A new connection, as a client makes for its next session.
    const client = await connect(s.h, s.mcpAccess);
    const archived = await callTool(client, "archive_artifact", { artifactId: s.artifactId });
    expect(archived.isError).toBeFalsy();
  });
});

describe("the tools that stay available without the current terms", () => {
  it("are exactly the read tools, the same set as the API's read routes", () => {
    const open = [...TOOL_SCOPES].filter(([, scope]) => usableWithoutCurrentTerms([scope]));
    expect(open.length).toBeGreaterThan(0);
    for (const [name, scope] of open) {
      expect(["artifacts:read", "annotations:read"], name).toContain(scope);
    }
    // Nothing that publishes, changes access, deletes or comments is among them.
    const names = open.map(([name]) => name);
    for (const name of [
      "publish_document",
      "prepare_upload",
      "commit_upload",
      "set_access",
      "add_reader",
      "delete_artifact",
      "archive_artifact",
    ]) {
      expect(names, name).not.toContain(name);
    }
  });
});
