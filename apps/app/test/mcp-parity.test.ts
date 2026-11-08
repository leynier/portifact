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

describe("API and MCP parity for versions", () => {
  /** An artifact with two versions published through MCP, one minute apart. */
  async function twoVersions(b: Both, name: string) {
    const v1 = fromTool(
      await b.tool("publish_document", { type: "markdown", name, content: `# ${name} 1` }),
    ).body as { artifactId: string; versionId: string };
    vi.setSystemTime(Date.now() + 60 * 1000);
    const v2 = fromTool(
      await b.tool("publish_document", {
        type: "markdown",
        name,
        content: `# ${name} 2`,
        artifactId: v1.artifactId,
        baseVersionId: v1.versionId,
      }),
    ).body as { versionId: string };
    return { id: v1.artifactId, v1: v1.versionId, v2: v2.versionId };
  }

  it("list, manifest and download links are the same", async () => {
    const b = await both("parity-versions@example.test");
    const { id, v1 } = await twoVersions(b, "History");

    expect(fromTool(await b.tool("list_versions", { artifactId: id, limit: 1 }))).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/versions?limit=1`)),
    );
    expect(
      fromTool(await b.tool("list_versions", { artifactId: id, limit: 1, cursor: "2" })),
    ).toEqual(await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/versions?limit=1&cursor=2`)));
    expect(fromTool(await b.tool("get_version", { artifactId: id, versionId: v1 }))).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/versions/${v1}`)),
    );
    // At the same time the signed links are identical too.
    const viaMcp = fromTool(await b.tool("get_download", { artifactId: id }));
    expect(viaMcp).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/versions/current/download`)),
    );
    expect(viaMcp.body).toMatchObject({ kind: "published", files: [{ path: "index.md" }] });
    expect(
      fromTool(await b.tool("get_download", { artifactId: id, versionId: v1, kind: "source" })),
    ).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/versions/${v1}/download?kind=source`)),
    );
    expect(fromTool(await b.tool("get_download", { artifactId: id, path: "index.md" }))).toEqual(
      await fromApi(
        await b.apiCall(`/api/v1/artifacts/${id}/versions/current/download?path=index.md`),
      ),
    );
  });

  it("refuses the same way: missing, another user's, unknown version and bad cursor", async () => {
    const b = await both("parity-versions-errors@example.test");
    const stranger = await both("parity-versions-stranger@example.test");
    const theirs = await twoVersions(stranger, "Theirs");
    const mine = await twoVersions(b, "Mine");

    for (const id of ["abcdefghij", theirs.id]) {
      expect(fromTool(await b.tool("list_versions", { artifactId: id }))).toEqual(
        await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/versions`)),
      );
      expect(fromTool(await b.tool("get_download", { artifactId: id }))).toEqual(
        await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/versions/current/download`)),
      );
    }
    expect(
      fromTool(await b.tool("get_version", { artifactId: mine.id, versionId: theirs.v1 })),
    ).toEqual(await fromApi(await b.apiCall(`/api/v1/artifacts/${mine.id}/versions/${theirs.v1}`)));
    expect(fromTool(await b.tool("list_versions", { artifactId: mine.id, cursor: "x" }))).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${mine.id}/versions?cursor=x`)),
    );
    expect(
      fromTool(await b.tool("get_download", { artifactId: mine.id, path: "missing.md" })),
    ).toEqual(
      await fromApi(
        await b.apiCall(`/api/v1/artifacts/${mine.id}/versions/current/download?path=missing.md`),
      ),
    );
  });

  it("rollback gives the same result, conflict and idempotent replay", async () => {
    const b = await both("parity-rollback@example.test");
    const viaApi = await twoVersions(b, "Api");
    const viaMcp = await twoVersions(b, "Mcp");
    vi.setSystemTime(Date.now() + 60 * 1000);

    const apiResult = await fromApi(
      await b.apiCall(`/api/v1/artifacts/${viaApi.id}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ versionId: viaApi.v1, baseVersionId: viaApi.v2 }),
      }),
    );
    const args = { artifactId: viaMcp.id, versionId: viaMcp.v1, baseVersionId: viaMcp.v2 };
    const mcpResult = fromTool(
      await b.tool("rollback_artifact", { ...args, idempotencyKey: "parity-rollback-1" }),
    );
    expect(apiResult.ok && mcpResult.ok).toBe(true);
    const strip = (body: unknown) => {
      const { fromVersionId, ...rest } = body as Record<string, unknown>;
      expect(fromVersionId).toMatch(/^ver_/);
      return withoutIds(rest);
    };
    expect(strip(mcpResult.body)).toEqual(strip(apiResult.body));
    expect(mcpResult.body).toMatchObject({ versionNumber: 3, fromVersionNumber: 1 });

    // A retry with the key replays; without it, the moved base is a conflict at both.
    expect(
      fromTool(await b.tool("rollback_artifact", { ...args, idempotencyKey: "parity-rollback-1" })),
    ).toEqual(mcpResult);
    expect(
      fromTool(
        await b.tool("rollback_artifact", {
          ...args,
          versionId: viaMcp.v2,
          idempotencyKey: "parity-rollback-1",
        }),
      ),
    ).toMatchObject({ ok: false, body: { error: { code: "invalid_input" } } });
    const staleApi = await fromApi(
      await b.apiCall(`/api/v1/artifacts/${viaApi.id}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ versionId: viaApi.v1, baseVersionId: viaApi.v2 }),
      }),
    );
    const staleMcp = fromTool(await b.tool("rollback_artifact", args));
    expect(staleMcp).toMatchObject({ ok: false, body: { error: { code: "version_conflict" } } });
    expect(staleMcp).toEqual(staleApi);
  });

  it("needs artifacts:write to roll back at both", async () => {
    const b = await both("parity-rollback-scope@example.test", "artifacts:read offline_access");
    const body = { versionId: "ver_a", baseVersionId: "ver_b" };
    const apiDenied = await b.apiCall("/api/v1/artifacts/abcdefghij/rollback", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    const token = await mcpToken(b.h, "parity-rollback-scope@example.test", "artifacts:read");
    const mcpDenied = await rawCall(b.h, token, "rollback_artifact", {
      artifactId: "abcdefghij",
      ...body,
    });
    const challenge = (response: Response) => {
      const header = response.headers.get("www-authenticate") ?? "";
      return [
        response.status,
        /error="([^"]+)"/.exec(header)?.[1],
        /scope="([^"]+)"/.exec(header)?.[1],
      ];
    };
    expect(challenge(mcpDenied)).toEqual(challenge(apiDenied));
    expect(apiDenied.headers.get("www-authenticate")).toContain('scope="artifacts:write"');
    // Reading history needs only artifacts:read, at both.
    expect((await rawCall(b.h, token, "list_versions", { artifactId: "abcdefghij" })).status).toBe(
      200,
    );
  });
});

describe("API and MCP parity for usage and source origins", () => {
  it("usage gives the same quotas, counters and blocks", async () => {
    const b = await both("parity-usage@example.test");
    const empty = fromTool(await b.tool("get_usage", {}));
    expect(empty).toEqual(await fromApi(await b.apiCall("/api/v1/usage")));
    expect(empty.body).toMatchObject({
      activeArtifacts: { used: 0, limit: 50 },
      publishesLast24h: { used: 0, limit: 100 },
      // A new account cannot make artifacts public yet.
      blocks: [{ reason: "account_too_new_for_public", stops: "public_access" }],
    });

    await b.tool("publish_document", { type: "markdown", name: "Doc", content: "# One" });
    await publishThroughApi(b, await ownerId(b), "# Two");
    const viaMcp = fromTool(await b.tool("get_usage", {}));
    expect(viaMcp).toEqual(await fromApi(await b.apiCall("/api/v1/usage")));
    expect(viaMcp.body).toMatchObject({
      activeArtifacts: { used: 2 },
      publishesLast24h: { used: 2 },
      // Rendered pages are written by the server and do not count as uploaded files.
      newFilesLast24h: { used: 2 },
    });
  });

  it("usage is the caller's own and needs artifacts:read at both", async () => {
    const b = await both("parity-usage-owner@example.test");
    const other = await both("parity-usage-other@example.test");
    await other.tool("publish_document", { type: "text", name: "Other", content: "x" });
    expect((await fromApi(await b.apiCall("/api/v1/usage"))).body).toMatchObject({
      activeArtifacts: { used: 0 },
    });

    const h = createHarness();
    const email = "parity-usage-scope@example.test";
    const apiDenied = await api(h, await apiToken(h, email, "annotations:read"), "/api/v1/usage");
    const mcpDenied = await rawCall(
      h,
      await mcpToken(h, email, "annotations:read"),
      "get_usage",
      {},
    );
    expect(apiDenied.status).toBe(403);
    expect(mcpDenied.status).toBe(apiDenied.status);
    expect(apiDenied.headers.get("www-authenticate")).toContain('scope="artifacts:read"');
    expect(mcpDenied.headers.get("www-authenticate")).toContain('scope="artifacts:read"');
  });

  it("a source origin sent to the API shows the same in list_versions and get_version", async () => {
    const b = await both("parity-origin@example.test");
    const origin = {
      commit: "0123456789abcdef0123456789abcdef01234567",
      branch: "main",
      remote: "git@github.com:leynier/portifact.git",
      dirty: false,
    };
    const source = "export const a = 1;";
    const owner = await ownerId(b);
    await env.ARTIFACTS.put(`objects/${owner}/${await sha256(source)}`, source, {
      sha256: await sha256(source),
    });
    const committed = await publishThroughApi(b, owner, "# With sources", {
      files: [
        {
          path: "index.md",
          sha256: await sha256("# With sources"),
          size: 14,
          contentType: "text/markdown; charset=utf-8",
        },
        {
          path: "src/a.ts",
          kind: "source",
          sha256: await sha256(source),
          size: source.length,
          contentType: "text/plain",
        },
      ],
      sourceOrigin: origin,
    });
    expect(committed.ok).toBe(true);
    const id = (committed.body as { artifactId: string }).artifactId;
    const list = fromTool(await b.tool("list_versions", { artifactId: id }));
    expect(list).toEqual(await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/versions`)));
    expect((list.body as { items: { sourceOrigin: unknown }[] }).items[0]?.sourceOrigin).toEqual(
      origin,
    );
    expect(fromTool(await b.tool("get_version", { artifactId: id, versionId: "current" }))).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/versions/current`)),
    );

    // A remote with a token is refused, whoever sends it.
    const refused = await publishThroughApi(b, owner, "# Token", {
      files: [
        {
          path: "index.md",
          sha256: await sha256("# Token"),
          size: 7,
          contentType: "text/markdown; charset=utf-8",
        },
        {
          path: "src/a.ts",
          kind: "source",
          sha256: await sha256(source),
          size: source.length,
          contentType: "text/plain",
        },
      ],
      sourceOrigin: { ...origin, remote: "https://ghp_secret@github.com/o/r.git" },
    });
    expect(refused).toMatchObject({ ok: false, body: { error: { code: "invalid_input" } } });
  });
});
