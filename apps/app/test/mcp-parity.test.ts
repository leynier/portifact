// Parity between /api/v1 and the MCP tools (AGENTS.md: web, CLI and MCP behave identically).
// One user holds an API token and an MCP token; every operation runs through both, at the same
// controlled time, and must give the same body, the same error and the same permission boundary.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import { createHarness, type Harness } from "./harness.ts";
import {
  api,
  apiToken,
  callTool,
  connect,
  mcpGrant,
  mcpToken,
  rawCall,
  revoke,
  type ToolResult,
} from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-02T09:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface Both {
  h: Harness;
  apiCall: (path: string, init?: RequestInit) => Promise<Response>;
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

async function both(email: string, scope?: string): Promise<Both> {
  const h = createHarness();
  const apiAccess = await apiToken(h, email, scope);
  const client = await connect(h, await mcpToken(h, email, scope));
  return {
    h,
    apiCall: (path, init) => api(h, apiAccess, path, init),
    tool: (name, args) => callTool(client, name, args),
  };
}

/** The API answer as status and body; the MCP answer as the same pair. */
async function fromApi(response: Response) {
  return { ok: response.ok, body: await response.json<unknown>() };
}
function fromTool(result: ToolResult) {
  return { ok: result.isError !== true, body: result.structuredContent };
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the CLI does for a one-file document: prepare, PUT the bytes, commit. */
async function publishThroughApi(
  b: Both,
  owner: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const sha = await sha256(content);
  const prepared = await b.apiCall("/api/v1/publishes", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      type: "markdown",
      name: "Doc",
      entrypoint: "index.md",
      files: [
        {
          path: "index.md",
          sha256: sha,
          size: new TextEncoder().encode(content).byteLength,
          contentType: "text/markdown; charset=utf-8",
        },
      ],
      ...extra,
    }),
  });
  if (prepared.status !== 201) return fromApi(prepared);
  const { uploadId } = await prepared.json<{ uploadId: string }>();
  await env.ARTIFACTS.put(`objects/${owner}/${sha}`, content, { sha256: sha });
  return fromApi(await b.apiCall(`/api/v1/publishes/${uploadId}/commit`, { method: "POST" }));
}

async function ownerId(b: Both): Promise<string> {
  return (await (await b.apiCall("/api/v1/me")).json<{ userId: string }>()).userId;
}

/** Drops the fields that name a different artifact or version but keeps their shape. */
function withoutIds(body: unknown) {
  const { artifactId, versionId, url, ...rest } = body as Record<string, string>;
  expect(artifactId).toMatch(/^[a-z2-7]{10}$/);
  expect(versionId).toMatch(/^ver_/);
  expect(url).toBe(`https://${artifactId}.portifact.dev/`);
  return rest;
}

describe("API and MCP parity", () => {
  it("publish gives the same version, expiry and stored file", async () => {
    const b = await both("parity-publish@example.test");
    const owner = await ownerId(b);
    const viaApi = await publishThroughApi(b, owner, "# Same");
    const viaMcp = fromTool(
      await b.tool("publish_document", { type: "markdown", name: "Doc", content: "# Same" }),
    );
    expect(viaApi.ok && viaMcp.ok).toBe(true);
    expect(withoutIds(viaMcp.body)).toEqual(withoutIds(viaApi.body));

    // The server renders both the same way: each version has the source, the page and the block
    // map, backed by the same stored objects, and both record the same renderer version.
    const files = await env.DB.prepare(
      "select f.path, f.kind, f.sha256, f.size, f.content_type, v.renderer_version from version_files f join versions v on v.id = f.version_id where f.owner_id = ? order by f.version_id, f.kind",
    )
      .bind(owner)
      .all<{ kind: string; renderer_version: string }>();
    expect(files.results.map((file) => file.kind)).toEqual([
      ...["block_map", "published", "rendered"],
      ...["block_map", "published", "rendered"],
    ]);
    expect(files.results.slice(0, 3)).toEqual(files.results.slice(3));
    expect(files.results[0]?.renderer_version).toBe("1");
  });

  it("get and list return the same artifact summaries", async () => {
    const b = await both("parity-read@example.test");
    const created = fromTool(
      await b.tool("publish_document", { type: "text", name: "Read me", content: "r" }),
    ).body as { artifactId: string };
    const id = created.artifactId;

    expect(fromTool(await b.tool("get_artifact", { artifactId: id }))).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${id}`)),
    );
    expect(fromTool(await b.tool("list_artifacts", { limit: 10 }))).toEqual(
      await fromApi(await b.apiCall("/api/v1/artifacts?limit=10")),
    );
  });

  it("refuses the same way: missing, another user's, stale base, archived and bad cursor", async () => {
    const b = await both("parity-errors@example.test");
    const owner = await ownerId(b);
    const stranger = await both("parity-stranger@example.test");
    const theirs = fromTool(
      await stranger.tool("publish_document", { type: "markdown", name: "Theirs", content: "t" }),
    ).body as { artifactId: string };

    for (const id of ["abcdefghij", theirs.artifactId]) {
      expect(fromTool(await b.tool("get_artifact", { artifactId: id }))).toEqual(
        await fromApi(await b.apiCall(`/api/v1/artifacts/${id}`)),
      );
      expect(fromTool(await b.tool("archive_artifact", { artifactId: id }))).toEqual(
        await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/archive`, { method: "POST" })),
      );
    }

    const mine = fromTool(
      await b.tool("publish_document", { type: "markdown", name: "Doc", content: "v1" }),
    ).body as { artifactId: string; versionId: string };
    const stale = { artifactId: mine.artifactId, baseVersionId: "ver_stale" };
    expect(
      fromTool(
        await b.tool("publish_document", {
          type: "markdown",
          name: "Doc",
          content: "v2",
          ...stale,
        }),
      ),
    ).toEqual(await publishThroughApi(b, owner, "v2", stale));

    await b.apiCall(`/api/v1/artifacts/${mine.artifactId}/archive`, { method: "POST" });
    const onArchived = { artifactId: mine.artifactId, baseVersionId: mine.versionId };
    const mcpArchived = fromTool(
      await b.tool("publish_document", {
        type: "markdown",
        name: "Doc",
        content: "v3",
        ...onArchived,
      }),
    );
    expect(mcpArchived).toEqual(await publishThroughApi(b, owner, "v3", onArchived));
    expect(mcpArchived.body).toMatchObject({ error: { code: "artifact_archived" } });
    expect(fromTool(await b.tool("renew_artifact", { artifactId: mine.artifactId }))).toEqual(
      await fromApi(
        await b.apiCall(`/api/v1/artifacts/${mine.artifactId}/renew`, { method: "POST" }),
      ),
    );

    expect(fromTool(await b.tool("list_artifacts", { cursor: "forged" }))).toEqual(
      await fromApi(await b.apiCall("/api/v1/artifacts?cursor=forged")),
    );
  });

  it("lifecycle transitions give the same states and dates", async () => {
    const b = await both("parity-cycle@example.test");
    const publish = async (name: string) =>
      (
        fromTool(await b.tool("publish_document", { type: "text", name, content: name })).body as {
          artifactId: string;
        }
      ).artifactId;
    const viaApi = await publish("api");
    const viaMcp = await publish("mcp");

    const steps: [string, string, "POST" | "DELETE"][] = [
      ["renew_artifact", "renew", "POST"],
      ["archive_artifact", "archive", "POST"],
      ["restore_artifact", "restore", "POST"],
      ["delete_artifact", "", "DELETE"],
    ];
    let at = NOW;
    for (const [tool, action, method] of steps) {
      at += 60 * 1000;
      vi.setSystemTime(at);
      const path = `/api/v1/artifacts/${viaApi}${action ? `/${action}` : ""}`;
      const apiResult = await fromApi(await b.apiCall(path, { method }));
      const args: Record<string, unknown> = { artifactId: viaMcp };
      if (tool === "delete_artifact") args.confirm = viaMcp;
      expect(fromTool(await b.tool(tool, args)), tool).toEqual(apiResult);
      expect(apiResult.ok, tool).toBe(true);
    }
  });

  it("draws the same permission boundary for each scope", async () => {
    const b = await both("parity-scope@example.test", "artifacts:read offline_access");
    const apiDenied = await b.apiCall("/api/v1/artifacts/abcdefghij", { method: "DELETE" });
    const mcpToken403 = await mcpToken(b.h, "parity-scope@example.test", "artifacts:read");
    const mcpDenied = await rawCall(b.h, mcpToken403, "delete_artifact", {
      artifactId: "abcdefghij",
      confirm: "abcdefghij",
    });
    expect(mcpDenied.status).toBe(apiDenied.status);
    expect(apiDenied.status).toBe(403);
    const challenge = (response: Response) => {
      const header = response.headers.get("www-authenticate") ?? "";
      return {
        error: /error="([^"]+)"/.exec(header)?.[1],
        scope: /scope="([^"]+)"/.exec(header)?.[1],
      };
    };
    expect(challenge(mcpDenied)).toEqual(challenge(apiDenied));
    expect(challenge(apiDenied)).toEqual({
      error: "insufficient_scope",
      scope: "artifacts:delete",
    });

    const writeApi = await b.apiCall("/api/v1/artifacts/abcdefghij/archive", { method: "POST" });
    const writeMcp = await rawCall(b.h, mcpToken403, "archive_artifact", {
      artifactId: "abcdefghij",
    });
    expect([writeMcp.status, challenge(writeMcp)]).toEqual([writeApi.status, challenge(writeApi)]);
    expect(challenge(writeApi).scope).toBe("artifacts:write");
  });

  it("rejects a revoked token at both", async () => {
    const h = createHarness();
    const email = "parity-revoked@example.test";
    const apiAccess = await apiToken(h, email);
    const grant = await mcpGrant(h, email);
    expect((await rawCall(h, grant.token, "list_artifacts", {})).status).toBe(200);
    expect((await revoke(h, CLI_CLIENT_ID, apiAccess)).status).toBe(200);
    expect((await revoke(h, grant.clientId, grant.token)).status).toBe(200);
    expect((await api(h, apiAccess, "/api/v1/artifacts")).status).toBe(401);
    const mcp = await rawCall(h, grant.token, "list_artifacts", {});
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});
