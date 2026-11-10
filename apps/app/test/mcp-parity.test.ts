// Parity between /api/v1 and the MCP tools (AGENTS.md: web, CLI and MCP behave identically).
// One user holds an API token and an MCP token; every operation runs through both, at the same
// controlled time, and must give the same body, the same error and the same permission boundary.
import { env } from "cloudflare:workers";
import { PLANS } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { RENDERER_VERSION } from "@portifact/render";
import { clearBudgetOverride, setBudgetOverride, suspendArtifact } from "@portifact/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import { pastHumanCheck } from "./api-client.ts";
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

/** The manifest of a one-file Markdown document, as prepare_upload and the API take it. */
async function docManifest(content: string, path = "index.md") {
  return {
    type: "markdown",
    name: "Doc",
    entrypoint: path,
    files: [
      {
        path,
        sha256: await sha256(content),
        size: new TextEncoder().encode(content).byteLength,
        contentType: "text/markdown; charset=utf-8",
      },
    ],
  };
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
    expect(files.results[0]?.renderer_version).toBe(RENDERER_VERSION);
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

  it("search and filters list the same artifacts", async () => {
    const b = await both("parity-filters@example.test");
    const publish = async (type: string, name: string) =>
      (
        fromTool(await b.tool("publish_document", { type, name, content: name })).body as {
          artifactId: string;
        }
      ).artifactId;
    const notes = await publish("markdown", "Release NOTES");
    const log = await publish("text", "Build log");
    await publish("markdown", "Roadmap");
    await b.apiCall(`/api/v1/artifacts/${log}/archive`, { method: "POST" });

    const cases: [Record<string, unknown>, string, string[]][] = [
      [{ search: "notes" }, "search=notes", [notes]],
      [{ search: notes.slice(0, 6) }, `search=${notes.slice(0, 6)}`, [notes]],
      [{ state: "archived" }, "state=archived", [log]],
      [{ type: "markdown", search: "release" }, "type=markdown&search=release", [notes]],
      [{ access: "public" }, "access=public", []],
      [{ annotations: "off", type: "text" }, "annotations=off&type=text", [log]],
    ];
    for (const [args, query, expected] of cases) {
      const viaMcp = fromTool(await b.tool("list_artifacts", args));
      expect(viaMcp, query).toEqual(await fromApi(await b.apiCall(`/api/v1/artifacts?${query}`)));
      expect((viaMcp.body as { items: { id: string }[] }).items.map((item) => item.id)).toEqual(
        expected,
      );
    }

    // The same page boundary with filters: the cursor continues the filtered list.
    const first = fromTool(await b.tool("list_artifacts", { type: "markdown", limit: 1 }));
    expect(first).toEqual(
      await fromApi(await b.apiCall("/api/v1/artifacts?type=markdown&limit=1")),
    );
    const cursor = (first.body as { nextCursor: string }).nextCursor;
    expect(
      fromTool(await b.tool("list_artifacts", { type: "markdown", limit: 1, cursor })),
    ).toEqual(
      await fromApi(
        await b.apiCall(
          `/api/v1/artifacts?type=markdown&limit=1&cursor=${encodeURIComponent(cursor)}`,
        ),
      ),
    );

    // Both refuse a state the list never shows.
    expect((await b.tool("list_artifacts", { state: "deleted" })).isError).toBe(true);
    const refused = await b.apiCall("/api/v1/artifacts?state=deleted");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("show the same suspension reason, and refuse the same changes, while suspended", async () => {
    const b = await both("parity-suspended@example.test");
    const id = (
      fromTool(await b.tool("publish_document", { type: "text", name: "Held", content: "h" }))
        .body as { artifactId: string }
    ).artifactId;
    await suspendArtifact(regionsFromEnv(env).get("default").db, {
      artifactId: id,
      reason: "phishing",
      note: "operator only",
      now: NOW,
    });
    const viaApi = await fromApi(await b.apiCall(`/api/v1/artifacts/${id}`));
    expect(viaApi.body).toMatchObject({ state: "suspended", suspension: { reason: "phishing" } });
    expect(JSON.stringify(viaApi.body)).not.toContain("operator only");
    expect(fromTool(await b.tool("get_artifact", { artifactId: id }))).toEqual(viaApi);
    expect(fromTool(await b.tool("renew_artifact", { artifactId: id }))).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${id}/renew`, { method: "POST" })),
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

  it("pin and unpin give the same states, views and errors", async () => {
    const b = await both("parity-pin@example.test");
    await regionsFromEnv(env)
      .get("default")
      .db.insert(schema.ownerPlans)
      .values({
        ownerId: await ownerId(b),
        plan: "pro",
        seats: 1,
        grantedBy: "test",
        updatedAt: NOW,
      });
    const publish = async (name: string) =>
      (
        fromTool(await b.tool("publish_document", { type: "text", name, content: name })).body as {
          artifactId: string;
        }
      ).artifactId;
    const viaApi = await publish("api");
    const viaMcp = await publish("mcp");
    const post = (id: string, action: string) =>
      b.apiCall(`/api/v1/artifacts/${id}/${action}`, { method: "POST" });

    // Pin, pin again, renew a pinned one, then unpin twice: every answer is the same.
    const steps: [string, string][] = [
      ["pin_artifact", "pin"],
      ["pin_artifact", "pin"],
      ["renew_artifact", "renew"],
      ["unpin_artifact", "unpin"],
      ["unpin_artifact", "unpin"],
    ];
    let at = NOW;
    for (const [tool, action] of steps) {
      at += 60 * 1000;
      vi.setSystemTime(at);
      const apiResult = await fromApi(await post(viaApi, action));
      expect(fromTool(await b.tool(tool, { artifactId: viaMcp })), tool).toEqual(apiResult);
      expect(apiResult.ok, tool).toBe(true);
    }

    // Pinned, the views show it with no expiry, the same way.
    await post(viaApi, "pin");
    await b.tool("pin_artifact", { artifactId: viaMcp });
    const viewed = await fromApi(await b.apiCall(`/api/v1/artifacts/${viaApi}`));
    expect(viewed.body).toMatchObject({ pinned: true, expiresAt: null });
    expect(fromTool(await b.tool("get_artifact", { artifactId: viaMcp })).body).toMatchObject({
      pinned: true,
      expiresAt: null,
    });
    const listed = fromTool(await b.tool("list_artifacts", {})).body as {
      items: { id: string; pinned: boolean }[];
    };
    expect(listed.items.find((item) => item.id === viaMcp)?.pinned).toBe(true);

    // Archiving unpins; pinning an archived one is refused the same way.
    await post(viaApi, "archive");
    await b.tool("archive_artifact", { artifactId: viaMcp });
    expect(fromTool(await b.tool("pin_artifact", { artifactId: viaMcp }))).toEqual(
      await fromApi(await post(viaApi, "pin")),
    );
    expect((await fromApi(await post(viaApi, "pin"))).body).toMatchObject({
      error: { code: "artifact_archived" },
    });
    // A stranger gets the missing-artifact answer from both.
    const stranger = await both("parity-pin-stranger@example.test");
    expect(fromTool(await stranger.tool("unpin_artifact", { artifactId: viaMcp }))).toEqual(
      await fromApi(
        await stranger.apiCall(`/api/v1/artifacts/${viaApi}/unpin`, { method: "POST" }),
      ),
    );
  });

  it("the Portifact bar turns off and on with the same policy, errors and scope", async () => {
    const SHARE = "artifacts:read artifacts:write artifacts:share offline_access";
    const b = await both("parity-bar@example.test", SHARE);
    const publish = async (name: string) =>
      (
        fromTool(await b.tool("publish_document", { type: "text", name, content: name })).body as {
          artifactId: string;
        }
      ).artifactId;
    const viaApi = await publish("api");
    const viaMcp = await publish("mcp");
    const patch = (id: string, bar: boolean) =>
      b.apiCall(`/api/v1/artifacts/${id}/access`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bar }),
      });
    for (const enabled of [false, true]) {
      const apiResult = await fromApi(await patch(viaApi, enabled));
      const mcpResult = fromTool(
        await b.tool("set_portifact_bar", { artifactId: viaMcp, enabled }),
      );
      expect(mcpResult).toEqual(apiResult);
      expect(apiResult).toMatchObject({ ok: true, body: { bar: enabled, mode: "restricted" } });
    }
    const other = await both("parity-bar-other@example.test", SHARE);
    const missing = fromTool(
      await other.tool("set_portifact_bar", { artifactId: viaMcp, enabled: false }),
    );
    expect(missing).toEqual(
      await fromApi(
        await other.apiCall(`/api/v1/artifacts/${viaApi}/access`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bar: false }),
        }),
      ),
    );
    expect(missing.body).toMatchObject({ error: { code: "not_found" } });

    const reader = await mcpToken(b.h, "parity-bar@example.test", "artifacts:read");
    const denied = await rawCall(b.h, reader, "set_portifact_bar", {
      artifactId: viaMcp,
      enabled: false,
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain('scope="artifacts:share"');
  });

  it("who sees comments changes with the same policy, errors and scope", async () => {
    const SHARE = "artifacts:read artifacts:write artifacts:share offline_access";
    const b = await both("parity-comments@example.test", SHARE);
    const publish = async (name: string) =>
      (
        fromTool(await b.tool("publish_document", { type: "text", name, content: name })).body as {
          artifactId: string;
        }
      ).artifactId;
    const viaApi = await publish("api");
    const viaMcp = await publish("mcp");
    const patch = (id: string, change: Record<string, unknown>) =>
      b.apiCall(`/api/v1/artifacts/${id}/access`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
    for (const id of [viaApi, viaMcp]) {
      expect((await fromApi(await patch(id, { addReaders: ["Ana@Example.test"] }))).ok).toBe(true);
    }
    const changes = [
      { commentVisibility: "everyone" },
      { readerCommentVisibility: [{ email: "ana@example.test", commentVisibility: "own" }] },
      {
        commentVisibility: "owner",
        readerCommentVisibility: [{ email: "ANA@example.test", commentVisibility: "all" }],
      },
      { readerCommentVisibility: [{ email: "ana@example.test", commentVisibility: "inherit" }] },
      // Refused alike: a reader who is not on the list, and no change at all.
      { readerCommentVisibility: [{ email: "bea@example.test", commentVisibility: "all" }] },
      {},
    ];
    for (const change of changes) {
      const apiResult = await fromApi(await patch(viaApi, change));
      const mcpResult = fromTool(
        await b.tool("set_comment_visibility", { artifactId: viaMcp, ...change }),
      );
      expect(mcpResult, JSON.stringify(change)).toEqual(apiResult);
    }
    const last = await fromApi(await b.apiCall(`/api/v1/artifacts/${viaApi}/access`));
    expect(last.body).toMatchObject({ commentVisibility: "owner", readerCommentVisibility: [] });

    const other = await both("parity-comments-other@example.test", SHARE);
    const missing = fromTool(
      await other.tool("set_comment_visibility", {
        artifactId: viaMcp,
        commentVisibility: "everyone",
      }),
    );
    expect(missing).toEqual(
      await fromApi(
        await other.apiCall(`/api/v1/artifacts/${viaApi}/access`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commentVisibility: "everyone" }),
        }),
      ),
    );
    expect(missing.body).toMatchObject({ error: { code: "not_found" } });

    const reader = await mcpToken(b.h, "parity-comments@example.test", "artifacts:read");
    const denied = await rawCall(b.h, reader, "set_comment_visibility", {
      artifactId: viaMcp,
      commentVisibility: "everyone",
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain('scope="artifacts:share"');
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

  it("compares versions the same way: summary, file diff and every refusal", async () => {
    const b = await both("parity-diff@example.test");
    const stranger = await both("parity-diff-stranger@example.test");
    const { id, v1, v2 } = await twoVersions(b, "Compared");
    const theirs = await twoVersions(stranger, "Theirs");
    const summary = (args: Record<string, unknown>, path: string) =>
      Promise.all([
        b.tool("diff_versions", { artifactId: id, ...args }).then(fromTool),
        b.apiCall(path).then(fromApi),
      ]);
    const file = (args: Record<string, unknown>, path: string) =>
      Promise.all([
        b.tool("diff_version_file", { artifactId: id, ...args }).then(fromTool),
        b.apiCall(path).then(fromApi),
      ]);
    const base = `/api/v1/artifacts/${id}/versions/${v1}/diff/${v2}`;

    // Free: the same plan_required from both.
    const [refusedTool, refusedApi] = await summary({ fromVersionId: v1, toVersionId: v2 }, base);
    expect(refusedTool).toEqual(refusedApi);
    expect(refusedApi.body).toMatchObject({ error: { code: "plan_required" } });

    await regionsFromEnv(env)
      .get("default")
      .db.insert(schema.ownerPlans)
      .values({
        ownerId: await ownerId(b),
        plan: "pro",
        seats: 1,
        grantedBy: "test",
        updatedAt: NOW,
      });

    const [tool, viaApi] = await summary({ fromVersionId: v1, toVersionId: v2 }, base);
    expect(tool).toEqual(viaApi);
    expect(viaApi.body).toMatchObject({
      counts: { added: 0, removed: 0, changed: 1, unchanged: 0 },
      files: [{ kind: "published", path: "index.md", change: "changed" }],
    });
    const [fileTool, fileApi] = await file(
      { fromVersionId: v1, toVersionId: v2, path: "index.md" },
      `${base}/file?path=index.md`,
    );
    expect(fileTool).toEqual(fileApi);
    expect(fileApi.body).toMatchObject({ diff: { status: "text", added: 1, removed: 1 } });

    for (const [args, path] of [
      [
        { fromVersionId: v1, toVersionId: theirs.v1 },
        `/api/v1/artifacts/${id}/versions/${v1}/diff/${theirs.v1}`,
      ],
      [{ fromVersionId: v1, toVersionId: v2, cursor: "x" }, `${base}?cursor=x`],
    ] as const) {
      const [t, a] = await summary(args, path);
      expect(t).toEqual(a);
      expect(a.ok).toBe(false);
    }
    const [missingTool, missingApi] = await file(
      { fromVersionId: v1, toVersionId: v2, path: "nope.md" },
      `${base}/file?path=nope.md`,
    );
    expect(missingTool).toEqual(missingApi);
    expect(missingApi.body).toMatchObject({ error: { code: "not_found" } });
    // A file the same in both versions has no hunks: the tool says why, with sizes.
    const [sameTool, sameApi] = await file(
      { fromVersionId: v2, toVersionId: v2, path: "index.md" },
      `/api/v1/artifacts/${id}/versions/${v2}/diff/${v2}/file?path=index.md`,
    );
    expect(sameTool).toEqual(sameApi);
    expect(sameApi.body).toMatchObject({ change: "unchanged", diff: { status: "identical" } });
    const same = await b.tool("diff_version_file", {
      artifactId: id,
      fromVersionId: v2,
      toVersionId: v2,
      path: "index.md",
    });
    expect((same.content[0] as { text: string }).text).toContain("unchanged, identical. Sizes:");
    // Bad input is refused by the route before any service runs.
    for (const path of [
      `/api/v1/artifacts/${id}/versions/bad%20id/diff/${v2}`,
      `/api/v1/artifacts/${id}/versions/bad%20id/diff/${v2}/file?path=index.md`,
      `/api/v1/artifacts/${id}/versions/${v1}/diff/bad%20id`,
      `/api/v1/artifacts/${id}/versions/${v1}/diff/bad%20id/file?path=index.md`,
      `${base}?limit=0`,
      `${base}/file`,
      `${base}/file?path=index.md&kind=rendered`,
    ]) {
      const answer = await fromApi(await b.apiCall(path));
      expect(answer, path).toMatchObject({ ok: false, body: { error: { code: "invalid_input" } } });
    }

    // A long diff comes in pages of hunks, and the tool says how to get the next one.
    const lines = Array.from({ length: 4_000 }, (_, i) => `line ${i}`);
    const long = fromTool(
      await b.tool("publish_document", {
        type: "text",
        name: "Long",
        content: `${lines.join("\n")}\n`,
      }),
    ).body as { artifactId: string; versionId: string };
    const edited = fromTool(
      await b.tool("publish_document", {
        type: "text",
        name: "Long",
        content: `${lines.map((line, i) => (i % 10 === 0 ? `${line}!` : line)).join("\n")}\n`,
        artifactId: long.artifactId,
        baseVersionId: long.versionId,
      }),
    ).body as { versionId: string };
    const manifest = fromTool(
      await b.tool("get_version", { artifactId: long.artifactId, versionId: edited.versionId }),
    ).body as { entrypoint: string };
    const paged = await b.tool("diff_version_file", {
      artifactId: long.artifactId,
      fromVersionId: long.versionId,
      toVersionId: edited.versionId,
      path: manifest.entrypoint,
    });
    expect((paged.content[0] as { text: string }).text).toContain(
      "More: call diff_version_file with cursor",
    );
    const listed = await b.tool("diff_versions", {
      artifactId: long.artifactId,
      fromVersionId: long.versionId,
      limit: 1,
    });
    expect((listed.content[0] as { text: string }).text).toContain("1 changed");

    // A site with several changed files pages them, and a new binary file has no "before".
    const site = async (
      files: Record<string, [string, string]>,
      base?: { artifactId: string; versionId: string },
    ) => {
      const entries = await Promise.all(
        Object.entries(files).map(async ([path, [content, contentType]]) => ({
          path,
          content,
          sha: await sha256(content),
          entry: { path, sha256: await sha256(content), size: content.length, contentType },
        })),
      );
      const prepared = await b.apiCall("/api/v1/publishes", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          type: "site",
          name: "Site",
          entrypoint: "index.html",
          files: entries.map((file) => file.entry),
          ...(base ? { artifactId: base.artifactId, baseVersionId: base.versionId } : {}),
        }),
      });
      const { uploadId } = await prepared.json<{ uploadId: string }>();
      const me = await ownerId(b);
      for (const file of entries) {
        await env.ARTIFACTS.put(`objects/${me}/${file.sha}`, file.content, { sha256: file.sha });
      }
      const committed = await b.apiCall(`/api/v1/publishes/${uploadId}/commit`, { method: "POST" });
      return committed.json<{ artifactId: string; versionId: string }>();
    };
    const s1 = await site({
      "index.html": ["<p>1</p>", "text/html"],
      "a.css": ["a{}", "text/css"],
    });
    const s2 = await site(
      {
        "index.html": ["<p>2</p>", "text/html"],
        "a.css": ["b{}", "text/css"],
        "data.bin": ["\u0001\u0002", "application/octet-stream"],
      },
      s1,
    );
    const pagedFiles = await b.tool("diff_versions", {
      artifactId: s1.artifactId,
      fromVersionId: s1.versionId,
      toVersionId: s2.versionId,
      limit: 1,
    });
    expect((pagedFiles.content[0] as { text: string }).text).toContain(
      "More: call diff_versions with cursor",
    );
    const binary = await b.tool("diff_version_file", {
      artifactId: s1.artifactId,
      fromVersionId: s1.versionId,
      toVersionId: s2.versionId,
      path: "data.bin",
    });
    expect((binary.content[0] as { text: string }).text).toContain(
      "added, binary. Sizes: none before, 2 after.",
    );

    // Another user's artifact answers exactly like a missing one, in both.
    const otherBase = `/api/v1/artifacts/${theirs.id}/versions/${theirs.v1}/diff/${theirs.v2}`;
    const [otherTool, otherApi] = await Promise.all([
      b
        .tool("diff_versions", {
          artifactId: theirs.id,
          fromVersionId: theirs.v1,
          toVersionId: theirs.v2,
        })
        .then(fromTool),
      b.apiCall(otherBase).then(fromApi),
    ]);
    expect(otherTool).toEqual(otherApi);
    expect(otherApi.body).toEqual({ error: { code: "not_found", message: "Artifact not found." } });
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

  it("usage gives the same plan, limits and features, and only the caller's", async () => {
    const b = await both("parity-plan@example.test");
    const other = await both("parity-plan-other@example.test");
    const free = fromTool(await b.tool("get_usage", {}));
    expect(free).toEqual(await fromApi(await b.apiCall("/api/v1/usage")));
    expect(free.body).toMatchObject({
      plan: { name: "free", validUntil: null, seats: 1, limits: PLANS.free.limits, features: [] },
    });

    await env.DB.prepare(
      "insert into owner_plans (owner_id, plan, seats, valid_until, granted_by, updated_at) values (?, 'team', 2, ?, 'test', ?)",
    )
      .bind(await ownerId(b), Date.UTC(2027, 0, 1), NOW)
      .run();
    const team = fromTool(await b.tool("get_usage", {}));
    expect(team).toEqual(await fromApi(await b.apiCall("/api/v1/usage")));
    expect(team.body).toMatchObject({
      plan: {
        name: "team",
        validUntil: "2027-01-01T00:00:00.000Z",
        seats: 2,
        limits: { accountBytes: 60_000_000_000, requestsPerMonth: 6_000_000 },
        features: [...PLANS.team.features],
      },
      activeArtifacts: { limit: 2_000 },
      storage: { limit: 60_000_000_000 },
      trafficThisMonth: { requests: { limit: 6_000_000 }, bytes: { limit: 1_000_000_000_000 } },
      versionLimits: { publishedBytes: 2_000_000_000 },
    });
    const theirs = fromTool(await other.tool("get_usage", {}));
    expect(theirs).toEqual(await fromApi(await other.apiCall("/api/v1/usage")));
    expect(theirs.body).toMatchObject({ plan: { name: "free" }, activeArtifacts: { limit: 50 } });
  });

  it("usage reports the same traffic and traffic block, and only the caller's", async () => {
    const b = await both("parity-traffic@example.test");
    const other = await both("parity-traffic-other@example.test");
    const insert = env.DB.prepare(
      "insert into traffic_counters (owner_id, cycle_start, requests, bytes, updated_at) values (?, ?, ?, ?, ?)",
    );
    const november = Date.UTC(2026, 10, 1);
    await insert.bind(await ownerId(b), november, 1_000_000, 42, NOW).run();
    await insert.bind(await ownerId(other), november, 7, 7, NOW).run();
    const viaMcp = fromTool(await b.tool("get_usage", {}));
    expect(viaMcp).toEqual(await fromApi(await b.apiCall("/api/v1/usage")));
    expect(viaMcp.body).toMatchObject({
      trafficThisMonth: {
        requests: { used: 1_000_000, limit: 1_000_000 },
        bytes: { used: 42, limit: 25_000_000_000 },
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
      blocks: expect.arrayContaining([
        expect.objectContaining({
          reason: "traffic",
          stops: "serving",
          until: "2026-12-01T00:00:00.000Z",
        }),
      ]),
    });
    const theirs = fromTool(await other.tool("get_usage", {}));
    expect(theirs.body).toMatchObject({ trafficThisMonth: { requests: { used: 7 } } });
    const reasons = (theirs.body as { blocks: { reason: string }[] }).blocks.map((x) => x.reason);
    expect(reasons).not.toContain("traffic");
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

describe("API and MCP parity for access logs", () => {
  /** Openings of `artifactId` by `count` visitors, one window apart, newest at NOW. */
  async function seedOpenings(artifactId: string, owner: string, count: number) {
    const insert = env.ACCESS_DB.prepare(
      "insert into access_events (artifact_id, window_start, user_id, owner_id, email, opened_at) values (?, ?, ?, ?, ?, ?)",
    );
    const window = 30 * 60_000;
    for (let i = 0; i < count; i += 1) {
      const at = NOW - i * window;
      await insert
        .bind(
          artifactId,
          at - (at % window),
          `u_visitor${i}`,
          owner,
          `visitor${i}@example.test`,
          at,
        )
        .run();
    }
  }

  it("lists the same openings, pages and filters the same way", async () => {
    const b = await both("parity-access-log@example.test");
    const owner = await ownerId(b);
    const published = fromTool(
      await b.tool("publish_document", { type: "markdown", name: "Doc", content: "# Log" }),
    );
    const { artifactId } = published.body as { artifactId: string };
    await seedOpenings(artifactId, owner, 3);

    const viaMcp = fromTool(await b.tool("get_access_logs", { artifactId }));
    expect(viaMcp).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${artifactId}/access-log`)),
    );
    expect(viaMcp.body).toEqual({
      artifactId,
      entries: [0, 1, 2].map((i) => ({
        email: `visitor${i}@example.test`,
        openedAt: new Date(NOW - i * 30 * 60_000).toISOString(),
      })),
      nextCursor: null,
      windowMinutes: 30,
      retentionDays: 30,
    });

    const first = fromTool(await b.tool("get_access_logs", { artifactId, limit: 2 }));
    expect(first).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${artifactId}/access-log?limit=2`)),
    );
    const cursor = (first.body as { nextCursor: string }).nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const second = fromTool(await b.tool("get_access_logs", { artifactId, limit: 2, cursor }));
    expect(second).toEqual(
      await fromApi(
        await b.apiCall(`/api/v1/artifacts/${artifactId}/access-log?limit=2&cursor=${cursor}`),
      ),
    );
    expect((second.body as { entries: unknown[] }).entries).toHaveLength(1);

    const since = new Date(NOW - 30 * 60_000).toISOString();
    const recent = fromTool(await b.tool("get_access_logs", { artifactId, since }));
    expect(recent).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${artifactId}/access-log?since=${since}`)),
    );
    expect((recent.body as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it("refuses the same way: another user's or a missing artifact, and a bad cursor", async () => {
    const owner = await both("parity-access-log-owner@example.test");
    const stranger = await both("parity-access-log-stranger@example.test");
    const published = fromTool(
      await owner.tool("publish_document", { type: "text", name: "Doc", content: "log" }),
    );
    const { artifactId } = published.body as { artifactId: string };
    await seedOpenings(artifactId, await ownerId(owner), 1);
    for (const id of [artifactId, "zzzzzzzzzz"]) {
      const viaApi = await fromApi(await stranger.apiCall(`/api/v1/artifacts/${id}/access-log`));
      expect(viaApi).toEqual({
        ok: false,
        body: { error: { code: "not_found", message: "Artifact not found." } },
      });
      expect(fromTool(await stranger.tool("get_access_logs", { artifactId: id }))).toEqual(viaApi);
    }
    const badCursor = await fromApi(
      await owner.apiCall(`/api/v1/artifacts/${artifactId}/access-log?cursor=nope!`),
    );
    expect(badCursor).toEqual({
      ok: false,
      body: { error: { code: "invalid_input", message: "Invalid cursor." } },
    });
    expect(fromTool(await owner.tool("get_access_logs", { artifactId, cursor: "nope!" }))).toEqual(
      badCursor,
    );
    for (const query of ["limit=0", "limit=101", "since=yesterday"]) {
      const response = await owner.apiCall(`/api/v1/artifacts/${artifactId}/access-log?${query}`);
      expect(response.status).toBe(400);
    }
  });

  it("needs artifacts:read at both", async () => {
    const h = createHarness();
    const email = "parity-access-log-scope@example.test";
    const path = "/api/v1/artifacts/zzzzzzzzzz/access-log";
    const apiDenied = await api(h, await apiToken(h, email, "annotations:read"), path);
    const mcpDenied = await rawCall(
      h,
      await mcpToken(h, email, "annotations:read"),
      "get_access_logs",
      {
        artifactId: "zzzzzzzzzz",
      },
    );
    expect(apiDenied.status).toBe(403);
    expect(mcpDenied.status).toBe(apiDenied.status);
    expect(apiDenied.headers.get("www-authenticate")).toContain('scope="artifacts:read"');
    expect(mcpDenied.headers.get("www-authenticate")).toContain('scope="artifacts:read"');
  });
});

describe("API and MCP parity for annotations", () => {
  const EVERY =
    "artifacts:read artifacts:write artifacts:share annotations:read annotations:write annotations:moderate offline_access";
  const DOC = { schema: 1, path: "index.md", anchor: { kind: "document" } };

  interface Thread {
    id: string;
    revision: number;
    messages: { id: string; revision: number }[];
  }

  const json = (method: string, body: unknown, key?: string): RequestInit => ({
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  });

  /** The author's per-minute write limit is real: move past it between pairs of writes. */
  const nextMinute = () => vi.setSystemTime(Date.now() + 61 * 1000);

  /** Replaces thread and message IDs by their order, so two equal threads compare equal. */
  function withoutThreadIds(body: unknown): unknown {
    const ids = new Map<string, string>();
    const name = (id: string) => {
      if (!ids.has(id)) ids.set(id, `id${ids.size}`);
      return ids.get(id);
    };
    const thread = (t: Thread & Record<string, unknown>) => ({
      ...t,
      id: name(t.id),
      messages: t.messages.map((m) => ({ ...m, id: name(m.id) })),
    });
    const value = body as Record<string, unknown>;
    if ("threadId" in value) {
      return {
        threadId: name(value.threadId as string),
        thread: value.thread ? thread(value.thread as Thread & Record<string, unknown>) : null,
      };
    }
    return thread(value as unknown as Thread & Record<string, unknown>);
  }

  /**
   * An owner and a reader, each with an API and an MCP token, on a Markdown artifact. The reader
   * is past the human check of first comments unless `fresh` is set.
   */
  async function reviewed(prefix: string, fresh = false) {
    const owner = await both(`${prefix}-owner@example.test`, EVERY);
    const reader = await both(`${prefix}-reader@example.test`, EVERY);
    const published = fromTool(
      await owner.tool("publish_document", { type: "markdown", name: "Plan", content: "# Plan" }),
    ).body as { artifactId: string; versionId: string };
    const id = published.artifactId;
    if (!fresh) {
      const other = fromTool(
        await owner.tool("publish_document", {
          type: "markdown",
          name: "Other",
          content: "# Other",
        }),
      ).body as { artifactId: string };
      await pastHumanCheck([`${prefix}-reader@example.test`], other.artifactId);
    }
    const share = await owner.apiCall(
      `/api/v1/artifacts/${id}/access`,
      json("PATCH", { addReaders: [`${prefix}-reader@example.test`] }),
    );
    expect(share.status).toBe(200);
    return {
      owner,
      reader,
      id,
      versionId: published.versionId,
      base: `/api/v1/artifacts/${id}/annotations`,
    };
  }

  async function apiThread(b: Both, base: string, versionId: string, body: string) {
    const response = await b.apiCall(
      `${base}/threads`,
      json("POST", { versionId, target: DOC, body }, crypto.randomUUID()),
    );
    expect(response.status).toBe(201);
    return response.json<Thread>();
  }

  it("the artifact list reports the same activity through both", async () => {
    const { owner, reader, id, versionId, base } = await reviewed("parity-activity");
    await owner.apiCall(`${base}/mode`, json("PUT", { mode: "open" }));
    const resolved = await apiThread(reader, base, versionId, "Fixed already");
    await apiThread(reader, base, versionId, "Still open");
    nextMinute();
    const resolvedAt = new Date(Date.now()).toISOString();
    const resolve = await owner.apiCall(
      `${base}/threads/${resolved.id}/resolve`,
      json("POST", {}, crypto.randomUUID()),
    );
    expect(resolve.status).toBe(200);

    const listed = async () => {
      const viaApi = await fromApi(await owner.apiCall("/api/v1/artifacts?search=plan"));
      expect(fromTool(await owner.tool("list_artifacts", { search: "plan" }))).toEqual(viaApi);
      return (viaApi.body as { items: { id: string; activity: unknown }[] }).items.find(
        (item) => item.id === id,
      )?.activity;
    };
    expect(await listed()).toEqual({
      versions: 1,
      currentBytes: new TextEncoder().encode("# Plan").byteLength,
      openThreads: 1,
      lastAnnotationAt: resolvedAt,
    });

    // A new version keeps the earlier one retained; its open thread stays with it.
    nextMinute();
    const updated = fromTool(
      await owner.tool("publish_document", {
        type: "markdown",
        name: "Plan",
        content: "# Plan, second draft",
        artifactId: id,
        baseVersionId: versionId,
      }),
    );
    expect(updated.ok).toBe(true);
    expect(await listed()).toMatchObject({
      versions: 2,
      openThreads: 0,
      lastAnnotationAt: resolvedAt,
    });
  });

  it("mode, threads, replies, reads, lists and exports give the same bodies", async () => {
    const { owner, reader, id, versionId, base } = await reviewed("parity-ann");

    const modeApi = await fromApi(
      await owner.apiCall(`${base}/mode`, json("PUT", { mode: "open" })),
    );
    expect(fromTool(await owner.tool("set_annotations", { artifactId: id, mode: "open" }))).toEqual(
      modeApi,
    );
    expect(modeApi).toEqual({ ok: true, body: { annotations: "open" } });

    const createdApi = await fromApi(
      await reader.apiCall(
        `${base}/threads`,
        json("POST", { versionId, target: DOC, body: " Same\r\ncomment " }, crypto.randomUUID()),
      ),
    );
    const createdMcp = fromTool(
      await reader.tool("create_annotation", {
        artifactId: id,
        versionId,
        target: DOC,
        body: " Same\r\ncomment ",
        idempotencyKey: "parity-create-1",
      }),
    );
    expect(createdApi.ok && createdMcp.ok).toBe(true);
    expect(withoutThreadIds(createdMcp.body)).toEqual(withoutThreadIds(createdApi.body));
    const first = createdApi.body as Thread;
    const second = createdMcp.body as unknown as Thread;

    nextMinute();
    const replyApi = await fromApi(
      await owner.apiCall(
        `${base}/threads/${first.id}/messages`,
        json("POST", { body: "Thanks" }, crypto.randomUUID()),
      ),
    );
    const replyMcp = fromTool(
      await owner.tool("reply_annotation", {
        artifactId: id,
        threadId: second.id,
        body: "Thanks",
        idempotencyKey: "parity-reply-1",
      }),
    );
    expect(replyMcp.ok).toBe(true);
    expect(withoutThreadIds(replyMcp.body)).toEqual(withoutThreadIds(replyApi.body));

    nextMinute();
    const editApi = await fromApi(
      await reader.apiCall(
        `${base}/messages/${first.messages[0]?.id}`,
        json("PATCH", { body: "Edited", revision: 1 }),
      ),
    );
    const editMcp = fromTool(
      await reader.tool("edit_annotation", {
        artifactId: id,
        messageId: second.messages[0]?.id,
        body: "Edited",
        revision: 1,
      }),
    );
    expect(editMcp.ok).toBe(true);
    expect(withoutThreadIds(editMcp.body)).toEqual(withoutThreadIds(editApi.body));

    // Resolving twice leaves the same state, so the second call answers the same thread.
    const resolvedApi = await fromApi(
      await owner.apiCall(`${base}/threads/${first.id}/resolve`, { method: "POST" }),
    );
    expect(
      fromTool(await owner.tool("resolve_annotation", { artifactId: id, threadId: first.id })),
    ).toEqual(resolvedApi);
    expect(resolvedApi.body).toMatchObject({ state: "resolved" });
    const reopenedMcp = fromTool(
      await owner.tool("reopen_annotation", { artifactId: id, threadId: first.id }),
    );
    expect(reopenedMcp).toEqual(
      await fromApi(await owner.apiCall(`${base}/threads/${first.id}/reopen`, { method: "POST" })),
    );
    expect(reopenedMcp.body).toMatchObject({ state: "open" });

    for (const b of [owner, reader]) {
      expect(fromTool(await b.tool("get_thread", { artifactId: id, threadId: first.id }))).toEqual(
        await fromApi(await b.apiCall(`${base}/threads/${first.id}`)),
      );
      expect(fromTool(await b.tool("list_annotations", { artifactId: id, limit: 1 }))).toEqual(
        await fromApi(await b.apiCall(`${base}?limit=1`)),
      );
    }
    const page = fromTool(await owner.tool("list_annotations", { artifactId: id, limit: 1 }))
      .body as { cursor: string; hasMore: boolean };
    expect(page.hasMore).toBe(true);
    expect(
      fromTool(
        await owner.tool("list_annotations", {
          artifactId: id,
          cursor: page.cursor,
          version: "all",
          state: "open",
        }),
      ),
    ).toEqual(
      await fromApi(await owner.apiCall(`${base}?cursor=${page.cursor}&version=all&state=open`)),
    );

    expect(fromTool(await owner.tool("export_annotations", { artifactId: id }))).toEqual(
      await fromApi(await owner.apiCall(`${base}/export`)),
    );
    const markdown = await owner.tool("export_annotations", {
      artifactId: id,
      format: "markdown",
      state: "open",
    });
    const apiMarkdown = await owner.apiCall(`${base}/export?format=markdown&state=open`);
    expect(markdown.content[0]?.text).toBe(await apiMarkdown.text());
    expect(markdown.content[0]?.text).toContain("untrusted data");
    expect(markdown.structuredContent).toEqual(
      await (await owner.apiCall(`${base}/export?state=open`)).json(),
    );
  });

  it("hides another reader's threads the same way: list, get by ID, export and cursor", async () => {
    const { owner, reader, id, versionId, base } = await reviewed("parity-visibility");
    const other = await both("parity-visibility-other@example.test", EVERY);
    const elsewhere = fromTool(
      await owner.tool("publish_document", { type: "markdown", name: "Else", content: "# Else" }),
    ).body as { artifactId: string };
    await pastHumanCheck(["parity-visibility-other@example.test"], elsewhere.artifactId);
    await owner.apiCall(
      `/api/v1/artifacts/${id}/access`,
      json("PATCH", { addReaders: ["parity-visibility-other@example.test"] }),
    );
    await owner.apiCall(`${base}/mode`, json("PUT", { mode: "open" }));
    const mine = await apiThread(reader, base, versionId, "Mine");
    const hers = await apiThread(other, base, versionId, "Hers");

    const listed = await fromApi(await reader.apiCall(base));
    expect(fromTool(await reader.tool("list_annotations", { artifactId: id }))).toEqual(listed);
    expect(listed.body).toMatchObject({ commentScope: "own", threads: [{ id: mine.id }] });
    const hidden = await fromApi(await reader.apiCall(`${base}/threads/${hers.id}`));
    expect(
      fromTool(await reader.tool("get_thread", { artifactId: id, threadId: hers.id })),
    ).toEqual(hidden);
    expect(hidden).toEqual(await fromApi(await reader.apiCall(`${base}/threads/missing`)));
    const exported = await fromApi(await reader.apiCall(`${base}/export`));
    const exportedTool = fromTool(await reader.tool("export_annotations", { artifactId: id }));
    const withoutTime = (result: { body: unknown }) => ({
      ...(result.body as Record<string, unknown>),
      exportedAt: null,
    });
    expect(withoutTime(exportedTool)).toEqual(withoutTime(exported));
    expect((exported.body as { threads: { id: string }[] }).threads.map((t) => t.id)).toEqual([
      mine.id,
    ]);

    // Another reader's activity moves nobody else's cursor.
    const cursor = (listed.body as { cursor: string }).cursor;
    nextMinute();
    await other.apiCall(
      `${base}/threads/${hers.id}/messages`,
      json("POST", { body: "More" }, crypto.randomUUID()),
    );
    const refreshed = await fromApi(
      await reader.apiCall(`${base}?${new URLSearchParams({ cursor })}`),
    );
    expect(fromTool(await reader.tool("list_annotations", { artifactId: id, cursor }))).toEqual(
      refreshed,
    );
    expect(refreshed.body).toMatchObject({ threads: [], removed: [], cursor });

    // Replies written while every reader saw every thread stay the reader's to edit and delete
    // after the owner narrows it again; both give no thread.
    await owner.apiCall(
      `/api/v1/artifacts/${id}/access`,
      json("PATCH", { commentVisibility: "everyone" }),
    );
    const replies: string[] = [];
    for (const body of ["Via API", "Via MCP"]) {
      nextMinute();
      const replied = await reader.apiCall(
        `${base}/threads/${hers.id}/messages`,
        json("POST", { body }, crypto.randomUUID()),
      );
      const view = await replied.json<Thread>();
      replies.push(view.messages.at(-1)?.id ?? "");
    }
    await owner.apiCall(
      `/api/v1/artifacts/${id}/access`,
      json("PATCH", { commentVisibility: "owner" }),
    );
    nextMinute();
    const editedApi = await fromApi(
      await reader.apiCall(
        `${base}/messages/${replies[0]}`,
        json("PATCH", { body: "Redacted", revision: 1 }),
      ),
    );
    const editedMcp = fromTool(
      await reader.tool("edit_annotation", {
        artifactId: id,
        messageId: replies[1],
        body: "Redacted",
        revision: 1,
      }),
    );
    expect(editedMcp).toEqual(editedApi);
    expect(editedApi).toEqual({ ok: true, body: { threadId: hers.id, thread: null } });
    const deletedApi = await fromApi(
      await reader.apiCall(`${base}/messages/${replies[0]}`, { method: "DELETE" }),
    );
    const deletedMcp = fromTool(
      await reader.tool("delete_annotation", {
        artifactId: id,
        messageId: replies[1],
        confirm: replies[1],
      }),
    );
    expect(deletedMcp).toEqual(deletedApi);
    expect(deletedApi).toEqual({ ok: true, body: { threadId: hers.id, thread: null } });
  });

  it("deletes, moderates and deletes threads the same way", async () => {
    const { owner, reader, id, versionId, base } = await reviewed("parity-ann-mod");
    await owner.apiCall(`${base}/mode`, json("PUT", { mode: "open" }));
    const threads = [
      await apiThread(reader, base, versionId, "Same"),
      await apiThread(reader, base, versionId, "Same"),
    ];
    nextMinute();
    const replies = [];
    for (const thread of threads) {
      const response = await reader.apiCall(
        `${base}/threads/${thread.id}/messages`,
        json("POST", { body: "More" }, crypto.randomUUID()),
      );
      replies.push((await response.json<Thread>()).messages[1]?.id as string);
    }
    const [apiFirst, mcpFirst] = threads.map((t) => t.messages[0]?.id) as [string, string];
    const [apiReply, mcpReply] = replies as [string, string];

    for (const action of ["hide", "unhide"]) {
      const viaApi = await fromApi(
        await owner.apiCall(`${base}/messages/${apiReply}/moderation`, json("POST", { action })),
      );
      const viaMcp = fromTool(
        await owner.tool("moderate_annotation", { artifactId: id, messageId: mcpReply, action }),
      );
      expect(viaMcp.ok, action).toBe(true);
      expect(withoutThreadIds(viaMcp.body), action).toEqual(withoutThreadIds(viaApi.body));
    }

    // Deleting another person's message needs the confirmation, then matches the API.
    const unconfirmed = fromTool(
      await owner.tool("moderate_annotation", {
        artifactId: id,
        messageId: mcpReply,
        action: "delete",
      }),
    );
    expect(unconfirmed).toMatchObject({ ok: false, body: { error: { code: "invalid_input" } } });
    const removedApi = await fromApi(
      await owner.apiCall(
        `${base}/messages/${apiReply}/moderation`,
        json("POST", { action: "delete" }),
      ),
    );
    const removedMcp = fromTool(
      await owner.tool("moderate_annotation", {
        artifactId: id,
        messageId: mcpReply,
        action: "delete",
        confirm: mcpReply,
      }),
    );
    expect(removedMcp.ok).toBe(true);
    expect(withoutThreadIds(removedMcp.body)).toEqual(withoutThreadIds(removedApi.body));

    // The author deletes their own first message; the thread keeps the deleted reply.
    const ownApi = await fromApi(
      await reader.apiCall(`${base}/messages/${apiFirst}`, { method: "DELETE" }),
    );
    const ownMcp = fromTool(
      await reader.tool("delete_annotation", { artifactId: id, messageId: mcpFirst }),
    );
    expect(ownMcp.ok).toBe(true);
    expect(withoutThreadIds(ownMcp.body)).toEqual(withoutThreadIds(ownApi.body));
    // Nobody else's message can be deleted as one's own, at both.
    nextMinute();
    const other = await apiThread(owner, base, versionId, "Owner");
    const ownerMessage = other.messages[0]?.id as string;
    expect(
      fromTool(await reader.tool("delete_annotation", { artifactId: id, messageId: ownerMessage })),
    ).toEqual(
      await fromApi(await reader.apiCall(`${base}/messages/${ownerMessage}`, { method: "DELETE" })),
    );

    // Both threads are gone with their last messages; delete two fresh ones as the owner.
    expect(ownApi.body).toMatchObject({ thread: null });
    const [apiDoomed, mcpDoomed] = [
      other.id,
      (await apiThread(owner, base, versionId, "Owner")).id,
    ] as [string, string];
    // A reader cannot delete threads; the owner can, after confirming.
    expect(
      fromTool(
        await reader.tool("delete_thread", {
          artifactId: id,
          threadId: mcpDoomed,
          confirm: mcpDoomed,
        }),
      ),
    ).toEqual(
      await fromApi(await reader.apiCall(`${base}/threads/${apiDoomed}`, { method: "DELETE" })),
    );
    expect(
      fromTool(
        await owner.tool("delete_thread", { artifactId: id, threadId: mcpDoomed, confirm: "x" }),
      ),
    ).toMatchObject({ ok: false, body: { error: { code: "invalid_input" } } });
    const deletedApi = await owner.apiCall(`${base}/threads/${apiDoomed}`, { method: "DELETE" });
    expect(deletedApi.status).toBe(204);
    expect(
      fromTool(
        await owner.tool("delete_thread", {
          artifactId: id,
          threadId: mcpDoomed,
          confirm: mcpDoomed,
        }),
      ),
    ).toEqual({ ok: true, body: { threadId: mcpDoomed } });
    for (const threadId of [apiDoomed, mcpDoomed]) {
      expect((await owner.apiCall(`${base}/threads/${threadId}`)).status).toBe(404);
    }
  });

  it("asks for the human check the same way: a visitor's first comments without a token", async () => {
    const { owner, reader, id, versionId, base } = await reviewed("parity-ann-human", true);
    await owner.apiCall(`${base}/mode`, json("PUT", { mode: "open" }));
    const api = await fromApi(
      await reader.apiCall(
        `${base}/threads`,
        json("POST", { versionId, target: DOC, body: "Hi" }, crypto.randomUUID()),
      ),
    );
    const mcp = fromTool(
      await reader.tool("create_annotation", {
        artifactId: id,
        versionId,
        target: DOC,
        body: "Hi",
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    expect(mcp).toEqual(api);
    expect(api.body).toMatchObject({ error: { code: "human_verification_required" } });
    // The owner answers from any client: the agent workflow never meets the check.
    const ownerThread = fromTool(
      await owner.tool("create_annotation", {
        artifactId: id,
        versionId,
        target: DOC,
        body: "Owner",
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    expect(ownerThread.ok).toBe(true);
    const threadId = (ownerThread.body as unknown as Thread).id;
    const replyApi = await fromApi(
      await reader.apiCall(
        `${base}/threads/${threadId}/messages`,
        json("POST", { body: "Re" }, crypto.randomUUID()),
      ),
    );
    const replyMcp = fromTool(
      await reader.tool("reply_annotation", {
        artifactId: id,
        threadId,
        body: "Re",
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    expect(replyMcp).toEqual(replyApi);
    expect(replyApi.body).toMatchObject({ error: { code: "human_verification_required" } });
  });

  it("refuses the same way: no access, annotations off, stale version or revision, bad cursor", async () => {
    const { owner, reader, id, versionId, base } = await reviewed("parity-ann-errors");
    const stranger = await both("parity-ann-errors-stranger@example.test", EVERY);
    const create = (b: Both, args: Record<string, unknown>) =>
      Promise.all([
        b
          .apiCall(
            `${base}/threads`,
            json("POST", { versionId, target: DOC, body: "Hi", ...args }, crypto.randomUUID()),
          )
          .then(fromApi),
        b
          .tool("create_annotation", {
            artifactId: id,
            versionId,
            target: DOC,
            body: "Hi",
            idempotencyKey: crypto.randomUUID(),
            ...args,
          })
          .then(fromTool),
      ]);

    // Annotations start off: nobody can comment yet.
    const [offApi, offMcp] = await create(reader, {});
    expect(offMcp).toEqual(offApi);
    expect(offApi.ok).toBe(false);
    await owner.apiCall(`${base}/mode`, json("PUT", { mode: "open" }));

    for (const b of [stranger, reader]) {
      expect(fromTool(await b.tool("set_annotations", { artifactId: id, mode: "locked" }))).toEqual(
        await fromApi(await b.apiCall(`${base}/mode`, json("PUT", { mode: "locked" }))),
      );
    }
    expect(fromTool(await stranger.tool("list_annotations", { artifactId: id }))).toEqual(
      await fromApi(await stranger.apiCall(base)),
    );
    expect(fromTool(await stranger.tool("export_annotations", { artifactId: id }))).toEqual(
      await fromApi(await stranger.apiCall(`${base}/export`)),
    );
    const [strangerApi, strangerMcp] = await create(stranger, {});
    expect(strangerMcp).toEqual(strangerApi);
    expect(strangerApi.body).toMatchObject({ error: { code: "not_found" } });

    const [staleApi, staleMcp] = await create(reader, { versionId: "ver_old" });
    expect(staleMcp).toEqual(staleApi);
    const [pathApi, pathMcp] = await create(reader, { target: { ...DOC, path: "missing.md" } });
    expect(pathMcp).toEqual(pathApi);
    expect(pathApi.body).toMatchObject({ error: { code: "invalid_input" } });

    const thread = await apiThread(reader, base, versionId, "Hello");
    const messageId = thread.messages[0]?.id as string;
    expect(
      fromTool(
        await reader.tool("edit_annotation", { artifactId: id, messageId, body: "x", revision: 9 }),
      ),
    ).toEqual(
      await fromApi(
        await reader.apiCall(
          `${base}/messages/${messageId}`,
          json("PATCH", { body: "x", revision: 9 }),
        ),
      ),
    );
    expect(
      fromTool(
        await owner.tool("edit_annotation", { artifactId: id, messageId, body: "x", revision: 1 }),
      ),
    ).toEqual(
      await fromApi(
        await owner.apiCall(
          `${base}/messages/${messageId}`,
          json("PATCH", { body: "x", revision: 1 }),
        ),
      ),
    );
    expect(
      fromTool(await reader.tool("get_thread", { artifactId: id, threadId: "missing" })),
    ).toEqual(await fromApi(await reader.apiCall(`${base}/threads/missing`)));
    expect(
      fromTool(await reader.tool("list_annotations", { artifactId: id, cursor: "nope" })),
    ).toEqual(await fromApi(await reader.apiCall(`${base}?cursor=nope`)));
    expect(
      fromTool(await reader.tool("list_annotations", { artifactId: id, version: "all" })),
    ).toEqual(await fromApi(await reader.apiCall(`${base}?version=all`)));

    // A newer version moves the threads to history: replies to the old one conflict at both.
    vi.setSystemTime(Date.now() + 60 * 1000);
    fromTool(
      await owner.tool("publish_document", {
        type: "markdown",
        name: "Plan",
        content: "# Plan 2",
        artifactId: id,
        baseVersionId: versionId,
      }),
    );
    expect(
      fromTool(
        await reader.tool("reply_annotation", {
          artifactId: id,
          threadId: thread.id,
          body: "Late",
          idempotencyKey: "parity-late-1",
        }),
      ),
    ).toEqual(
      await fromApi(
        await reader.apiCall(
          `${base}/threads/${thread.id}/messages`,
          json("POST", { body: "Late" }, crypto.randomUUID()),
        ),
      ),
    );
  });

  it("replays a create with the same idempotency key and refuses it for another comment", async () => {
    const { owner, id, versionId, base } = await reviewed("parity-ann-replay");
    await owner.apiCall(`${base}/mode`, json("PUT", { mode: "open" }));
    const args = {
      artifactId: id,
      versionId,
      target: DOC,
      body: "Once",
      idempotencyKey: "parity-once-1",
    };
    const first = await owner.tool("create_annotation", args);
    expect(first.isError).not.toBe(true);
    vi.setSystemTime(Date.now() + 60 * 1000);
    expect(await owner.tool("create_annotation", args)).toEqual(first);
    expect(
      fromTool(await owner.tool("create_annotation", { ...args, body: "Twice" })),
    ).toMatchObject({ ok: false, body: { error: { code: "invalid_input" } } });
    const list = await (await owner.apiCall(base)).json<{ threads: unknown[] }>();
    expect(list.threads).toHaveLength(1);

    const threadId = (first.structuredContent as { id: string }).id;
    const reply = { artifactId: id, threadId, body: "Reply", idempotencyKey: "parity-reply-once" };
    const replied = await owner.tool("reply_annotation", reply);
    expect(await owner.tool("reply_annotation", reply)).toEqual(replied);
    expect((replied.structuredContent as unknown as Thread).messages).toHaveLength(2);
  });

  it("draws the same permission boundary for each annotation scope", async () => {
    const email = "parity-ann-scope@example.test";
    const scope = "artifacts:read annotations:read offline_access";
    const b = await both(email, scope);
    const token = await mcpToken(b.h, email, scope);
    const challenge = (response: Response) => {
      const header = response.headers.get("www-authenticate") ?? "";
      return [response.status, /scope="([^"]+)"/.exec(header)?.[1]];
    };
    const base = "/api/v1/artifacts/abcdefghij/annotations";
    const pairs: [string, Record<string, unknown>, string, RequestInit][] = [
      [
        "create_annotation",
        { versionId: "ver_a", target: DOC, body: "x", idempotencyKey: "scope-key-1" },
        `${base}/threads`,
        json("POST", { versionId: "ver_a", target: DOC, body: "x" }, "scope-key-1"),
      ],
      ["resolve_annotation", { threadId: "t1" }, `${base}/threads/t1/resolve`, { method: "POST" }],
      ["set_annotations", { mode: "open" }, `${base}/mode`, json("PUT", { mode: "open" })],
      [
        "delete_thread",
        { threadId: "t1", confirm: "t1" },
        `${base}/threads/t1`,
        { method: "DELETE" },
      ],
    ];
    for (const [tool, args, path, init] of pairs) {
      const apiDenied = await b.apiCall(path, init);
      const mcpDenied = await rawCall(b.h, token, tool, { artifactId: "abcdefghij", ...args });
      expect(challenge(mcpDenied), tool).toEqual(challenge(apiDenied));
      expect(apiDenied.status, tool).toBe(403);
    }
    // Reading needs only annotations:read, at both.
    expect(
      (await rawCall(b.h, token, "list_annotations", { artifactId: "abcdefghij" })).status,
    ).toBe(200);
    expect((await b.apiCall(base)).status).toBe(404);
  });
});

describe("API and MCP parity under budget protection", () => {
  const EVERY =
    "artifacts:read artifacts:write artifacts:share annotations:read annotations:write annotations:moderate offline_access";
  const DOC = { schema: 1, path: "index.md", anchor: { kind: "document" } };

  async function protect(level: "slow75" | "protect100", steps = 1) {
    await setBudgetOverride(regionsFromEnv(env).get("default").db, {
      level,
      steps,
      until: null,
      note: null,
      now: NOW,
    });
  }
  afterEach(async () => {
    await clearBudgetOverride(regionsFromEnv(env).get("default").db, NOW);
  });

  it("refuses new artifacts, then uploads, with the same error, and keeps updates and reads", async () => {
    const b = await both("parity-budget@example.test", EVERY);
    const owner = await ownerId(b);
    const mine = fromTool(
      await b.tool("publish_document", { type: "markdown", name: "Doc", content: "v1" }),
    ).body as { artifactId: string; versionId: string };

    await protect("slow75");
    const viaApi = await publishThroughApi(b, owner, "new");
    expect(viaApi).toMatchObject({ ok: false, body: { error: { code: "capacity_unavailable" } } });
    expect(
      fromTool(await b.tool("publish_document", { type: "markdown", name: "Doc", content: "new" })),
    ).toEqual(viaApi);
    expect(
      fromTool(
        await b.tool("prepare_upload", {
          ...(await docManifest("new")),
          idempotencyKey: crypto.randomUUID(),
        }),
      ),
    ).toEqual(viaApi);
    const update = fromTool(
      await b.tool("publish_document", {
        type: "markdown",
        name: "Doc",
        content: "v2",
        artifactId: mine.artifactId,
        baseVersionId: mine.versionId,
      }),
    );
    expect(update.ok).toBe(true);

    await protect("protect100", 2);
    const refused = await b.apiCall("/api/v1/publishes", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        type: "markdown",
        name: "Doc",
        entrypoint: "index.md",
        artifactId: mine.artifactId,
        baseVersionId: (update.body as { versionId: string }).versionId,
        files: [
          {
            path: "index.md",
            sha256: await sha256("v3"),
            size: 2,
            contentType: "text/markdown; charset=utf-8",
          },
        ],
      }),
    });
    expect(refused.status).toBe(503);
    const refusedBody = await fromApi(refused);
    expect(
      fromTool(
        await b.tool("publish_document", {
          type: "markdown",
          name: "Doc",
          content: "v3",
          artifactId: mine.artifactId,
          baseVersionId: (update.body as { versionId: string }).versionId,
        }),
      ),
    ).toEqual(refusedBody);
    expect(
      fromTool(
        await b.tool("prepare_upload", {
          ...(await docManifest("v3")),
          artifactId: mine.artifactId,
          baseVersionId: (update.body as { versionId: string }).versionId,
          idempotencyKey: crypto.randomUUID(),
        }),
      ),
    ).toEqual(refusedBody);

    // Reads, renewal and the usage notice stay the same at both.
    const id = mine.artifactId;
    expect(fromTool(await b.tool("get_artifact", { artifactId: id }))).toEqual(
      await fromApi(await b.apiCall(`/api/v1/artifacts/${id}`)),
    );
    expect(fromTool(await b.tool("renew_artifact", { artifactId: id }))).toMatchObject({
      ok: true,
    });
    const usage = fromTool(await b.tool("get_usage", {}));
    expect(usage).toEqual(await fromApi(await b.apiCall("/api/v1/usage")));
    expect((usage.body as { blocks: unknown[] }).blocks[0]).toMatchObject({
      reason: "capacity",
      stops: "publishing",
    });
  });

  it("pauses new comments with the same error at both", async () => {
    const b = await both("parity-budget-comments@example.test", EVERY);
    const doc = fromTool(
      await b.tool("publish_document", { type: "markdown", name: "Plan", content: "# Plan" }),
    ).body as { artifactId: string; versionId: string };
    const id = doc.artifactId;
    expect(fromTool(await b.tool("set_annotations", { artifactId: id, mode: "open" })).ok).toBe(
      true,
    );
    await protect("protect100", 2);
    const viaApi = await fromApi(
      await b.apiCall(`/api/v1/artifacts/${id}/annotations/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ versionId: doc.versionId, target: DOC, body: "Hi" }),
      }),
    );
    expect(viaApi).toMatchObject({ ok: false, body: { error: { code: "capacity_unavailable" } } });
    const viaMcp = fromTool(
      await b.tool("create_annotation", {
        artifactId: id,
        versionId: doc.versionId,
        target: DOC,
        body: "Hi",
        idempotencyKey: "parity-budget-create",
      }),
    );
    expect(viaMcp).toEqual(viaApi);
  });
});

describe("API and MCP parity for sharing", () => {
  const SHARE = "artifacts:read artifacts:write artifacts:share offline_access";
  const patch = (b: Both, id: string, change: Record<string, unknown>) =>
    b.apiCall(`/api/v1/artifacts/${id}/access`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change),
    });
  async function pair(b: Both) {
    const publish = async (name: string) =>
      (
        fromTool(await b.tool("publish_document", { type: "text", name, content: name })).body as {
          artifactId: string;
        }
      ).artifactId;
    return { viaApi: await publish("api"), viaMcp: await publish("mcp") };
  }

  it("access mode, indexing and embedding change with the same policy and errors", async () => {
    const b = await both("parity-share@example.test", SHARE);
    const { viaApi, viaMcp } = await pair(b);
    const cases: Record<string, unknown>[] = [
      // A new account must wait before making anything public: refused alike.
      { mode: "public" },
      { mode: "authenticated" },
      { indexable: true, embeddable: true },
      { mode: "restricted", indexable: false },
      // No change at all, and an unknown mode.
      {},
      { mode: "secret" },
    ];
    for (const change of cases) {
      const apiResult = await fromApi(await patch(b, viaApi, change));
      const mcpResult = fromTool(await b.tool("set_access", { artifactId: viaMcp, ...change }));
      if (change.mode === "secret") {
        // The tool's schema refuses it before any service runs; both refuse it.
        expect(apiResult.body).toMatchObject({ error: { code: "invalid_input" } });
        expect(mcpResult.ok).toBe(false);
        continue;
      }
      expect(mcpResult, JSON.stringify(change)).toEqual(apiResult);
    }
    const first = await fromApi(await patch(b, viaApi, { mode: "public" }));
    expect(first.body).toMatchObject({ error: { code: "account_too_new_for_public" } });

    // After the wait both make it public the same way.
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const apiResult = await fromApi(await patch(b, viaApi, { mode: "public", indexable: true }));
    const mcpResult = fromTool(
      await b.tool("set_access", { artifactId: viaMcp, mode: "public", indexable: true }),
    );
    expect(mcpResult).toEqual(apiResult);
    expect(apiResult.body).toMatchObject({ mode: "public", indexable: true, embeddable: true });
  });

  it("readers are added and removed with the same policy and errors", async () => {
    const b = await both("parity-readers@example.test", SHARE);
    const { viaApi, viaMcp } = await pair(b);
    const steps: [string, string, string[]][] = [
      ["add_reader", "addReaders", ["Ana@Example.test", "bea@example.test"]],
      ["add_reader", "addReaders", ["ana@example.test"]],
      ["remove_reader", "removeReaders", ["BEA@example.test", "nobody@example.test"]],
      ["add_reader", "addReaders", ["not an email"]],
      ["remove_reader", "removeReaders", ["ana@example.test", "@"]],
    ];
    for (const [tool, field, emails] of steps) {
      const apiResult = await fromApi(await patch(b, viaApi, { [field]: emails }));
      const mcpResult = fromTool(await b.tool(tool, { artifactId: viaMcp, emails }));
      expect(mcpResult, `${tool} ${emails}`).toEqual(apiResult);
    }
    const last = await fromApi(await b.apiCall(`/api/v1/artifacts/${viaMcp}/access`));
    expect(last.body).toMatchObject({ mode: "restricted", readers: ["ana@example.test"] });
    // Invalid addresses are refused before anything changes, at both.
    expect(
      fromTool(await b.tool("add_reader", { artifactId: viaMcp, emails: ["nope"] })).body,
    ).toEqual({ error: { code: "invalid_input", message: "addReaders.0: Invalid email address" } });
    expect((await b.tool("add_reader", { artifactId: viaMcp, emails: [] })).isError).toBe(true);
  });

  it("refuses another user's or a missing artifact, and needs artifacts:share, at both", async () => {
    const b = await both("parity-share-owner@example.test", SHARE);
    const { viaApi, viaMcp } = await pair(b);
    const other = await both("parity-share-other@example.test", SHARE);
    for (const id of [viaMcp, "abcdefghij"]) {
      const apiResult = await fromApi(
        await patch(other, id === viaMcp ? viaApi : id, { addReaders: ["x@example.test"] }),
      );
      expect(apiResult.body).toMatchObject({ error: { code: "not_found" } });
      for (const [tool, args] of [
        ["set_access", { mode: "restricted" }],
        ["add_reader", { emails: ["x@example.test"] }],
        ["remove_reader", { emails: ["x@example.test"] }],
      ] as const) {
        expect(fromTool(await other.tool(tool, { artifactId: id, ...args })), tool).toEqual(
          apiResult,
        );
      }
    }

    const reader = await mcpToken(b.h, "parity-share-owner@example.test", "artifacts:read");
    for (const [tool, args] of [
      ["set_access", { mode: "public" }],
      ["add_reader", { emails: ["x@example.test"] }],
      ["remove_reader", { emails: ["x@example.test"] }],
    ] as const) {
      const denied = await rawCall(b.h, reader, tool, { artifactId: viaMcp, ...args });
      expect(denied.status, tool).toBe(403);
      expect(denied.headers.get("www-authenticate"), tool).toContain('scope="artifacts:share"');
    }
    const apiDenied = await api(
      b.h,
      await apiToken(b.h, "parity-share-owner@example.test", "artifacts:read"),
      `/api/v1/artifacts/${viaApi}/access`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "public" }),
      },
    );
    expect(apiDenied.status).toBe(403);
    expect(apiDenied.headers.get("www-authenticate")).toContain('scope="artifacts:share"');
  });
});

describe("API and MCP parity for uploads", () => {
  /** The prepared body without what names a different upload; URLs keep only their object key. */
  function preparedShape(body: unknown) {
    const { artifactId, versionId, uploadId, uploads, ...rest } = body as {
      artifactId: string;
      versionId: string;
      uploadId: string;
      uploads: { url: string }[];
    };
    expect(artifactId).toMatch(/^[a-z2-7]{10}$/);
    expect(versionId).toMatch(/^ver_/);
    expect(uploadId).toMatch(/^upl_/);
    return {
      ...rest,
      uploads: uploads.map(({ url, ...upload }) => ({ ...upload, key: new URL(url).pathname })),
    };
  }

  const site = async (marker: string) => {
    const page = `<h1>${marker}</h1>`;
    const style = `h1 { color: black } /* ${marker} */`;
    return {
      bytes: { page, style },
      manifest: {
        type: "site",
        name: "Site",
        entrypoint: "index.html",
        files: [
          {
            path: "index.html",
            sha256: await sha256(page),
            size: new TextEncoder().encode(page).byteLength,
            contentType: "text/html; charset=utf-8",
          },
          {
            path: "assets/style.css",
            sha256: await sha256(style),
            size: new TextEncoder().encode(style).byteLength,
            contentType: "text/css; charset=utf-8",
          },
        ],
      },
    };
  };

  async function store(owner: string, ...bodies: string[]) {
    for (const body of bodies) {
      const hash = await sha256(body);
      await env.ARTIFACTS.put(`objects/${owner}/${hash}`, body, { sha256: hash });
    }
  }

  it("prepare, status and commit of a site give the same bodies", async () => {
    const b = await both("parity-upload@example.test");
    const owner = await ownerId(b);
    const { manifest, bytes } = await site("same");

    const viaApi = await fromApi(
      await b.apiCall("/api/v1/publishes", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(manifest),
      }),
    );
    // The API's upload is still open, so the same files are pending and listed again.
    const viaMcp = fromTool(
      await b.tool("prepare_upload", { ...manifest, idempotencyKey: crypto.randomUUID() }),
    );
    expect(viaApi.ok && viaMcp.ok).toBe(true);
    expect(preparedShape(viaMcp.body)).toEqual(preparedShape(viaApi.body));
    expect(preparedShape(viaMcp.body).uploads).toHaveLength(2);
    const apiUpload = (viaApi.body as { uploadId: string }).uploadId;
    const mcpUpload = (viaMcp.body as { uploadId: string }).uploadId;

    // Status before the bytes arrive: the same targets, signed at the same time.
    expect(
      preparedShape(fromTool(await b.tool("get_upload_status", { uploadId: mcpUpload })).body),
    ).toEqual(
      preparedShape((await fromApi(await b.apiCall(`/api/v1/publishes/${apiUpload}`))).body),
    );

    // Committing before the bytes arrive is refused alike.
    const early = await fromApi(
      await b.apiCall(`/api/v1/publishes/${apiUpload}/commit`, { method: "POST" }),
    );
    expect(early.body).toMatchObject({ error: { code: "upload_incomplete" } });
    expect(fromTool(await b.tool("commit_upload", { uploadId: mcpUpload }))).toEqual(early);

    await store(owner, bytes.page, bytes.style);
    const committedApi = await fromApi(
      await b.apiCall(`/api/v1/publishes/${apiUpload}/commit`, { method: "POST" }),
    );
    const committedMcp = fromTool(await b.tool("commit_upload", { uploadId: mcpUpload }));
    expect(committedApi.ok && committedMcp.ok).toBe(true);
    expect(withoutIds(committedMcp.body)).toEqual(withoutIds(committedApi.body));

    // A committed upload is closed at both.
    const closedApi = await fromApi(await b.apiCall(`/api/v1/publishes/${apiUpload}`));
    expect(closedApi.body).toMatchObject({ error: { code: "upload_incomplete" } });
    expect(fromTool(await b.tool("get_upload_status", { uploadId: mcpUpload }))).toEqual(closedApi);
    // Committing again answers the same at both.
    const againApi = await fromApi(
      await b.apiCall(`/api/v1/publishes/${apiUpload}/commit`, { method: "POST" }),
    );
    const againMcp = fromTool(await b.tool("commit_upload", { uploadId: mcpUpload }));
    expect(againMcp.ok).toBe(againApi.ok);
    expect(againApi.ok ? withoutIds(againMcp.body) : againMcp.body).toEqual(
      againApi.ok ? withoutIds(againApi.body) : againApi.body,
    );

    // An update of the site needs no bytes the account already stores.
    const { artifactId, versionId } = committedMcp.body as {
      artifactId: string;
      versionId: string;
    };
    const update = fromTool(
      await b.tool("prepare_upload", {
        ...manifest,
        artifactId,
        baseVersionId: versionId,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    expect(update.body).toMatchObject({ artifactId, versionNumber: 2, uploads: [] });
    expect(
      fromTool(
        await b.tool("commit_upload", { uploadId: (update.body as { uploadId: string }).uploadId }),
      ).body,
    ).toMatchObject({ artifactId, versionNumber: 2 });
  });

  it("refuses the same way: invalid manifest, another user's upload, stale base and quotas", async () => {
    const b = await both("parity-upload-errors@example.test");
    const other = await both("parity-upload-errors-other@example.test");
    const prepareApi = async (who: Both, body: Record<string, unknown>) =>
      fromApi(
        await who.apiCall("/api/v1/publishes", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify(body),
        }),
      );
    const prepareMcp = async (who: Both, body: Record<string, unknown>) =>
      fromTool(await who.tool("prepare_upload", { ...body, idempotencyKey: crypto.randomUUID() }));

    const doc = await docManifest("# Doc");
    for (const body of [
      // The entrypoint is not in the manifest.
      { ...doc, entrypoint: "missing.md" },
      // A path that escapes the artifact.
      { ...doc, entrypoint: "../index.md", files: [{ ...doc.files[0], path: "../index.md" }] },
      // An update of an artifact that does not exist.
      { ...doc, artifactId: "abcdefghij", baseVersionId: "ver_x" },
    ]) {
      const apiResult = await prepareApi(b, body);
      expect(apiResult.ok, JSON.stringify(body)).toBe(false);
      expect(await prepareMcp(b, body), JSON.stringify(body)).toEqual(apiResult);
    }

    // A stale base: the commit of the second upload loses at both.
    const created = fromTool(
      await b.tool("publish_document", { type: "markdown", name: "Doc", content: "# One" }),
    ).body as { artifactId: string; versionId: string };
    await fromTool(
      await b.tool("publish_document", {
        type: "markdown",
        name: "Doc",
        content: "# Two",
        artifactId: created.artifactId,
        baseVersionId: created.versionId,
      }),
    );
    const stale = {
      ...(await docManifest("# Three")),
      artifactId: created.artifactId,
      baseVersionId: created.versionId,
    };
    const staleApi = await prepareApi(b, stale);
    expect(staleApi.body).toMatchObject({ error: { code: "version_conflict" } });
    expect(await prepareMcp(b, stale)).toEqual(staleApi);

    // Someone else's upload looks missing at both.
    const theirs = (await prepareMcp(other, await docManifest("# Theirs"))).body as {
      uploadId: string;
    };
    const missing = await fromApi(await b.apiCall(`/api/v1/publishes/${theirs.uploadId}`));
    expect(missing.body).toMatchObject({ error: { code: "not_found" } });
    expect(fromTool(await b.tool("get_upload_status", { uploadId: theirs.uploadId }))).toEqual(
      missing,
    );
    expect(fromTool(await b.tool("commit_upload", { uploadId: theirs.uploadId }))).toEqual(
      await fromApi(
        await b.apiCall(`/api/v1/publishes/${theirs.uploadId}/commit`, { method: "POST" }),
      ),
    );
    // Parts for an upload that is not the caller's are refused before any commit.
    expect(
      fromTool(
        await b.tool("commit_upload", {
          uploadId: theirs.uploadId,
          parts: [{ sha256: await sha256("# Theirs"), partNumber: 1, etag: "x" }],
        }),
      ),
    ).toEqual(missing);

    // The account holds at most two open uploads; the third is refused alike.
    await prepareMcp(b, await docManifest("# Open 1"));
    await prepareApi(b, await docManifest("# Open 1b"));
    const third = await prepareApi(b, await docManifest("# Open 2"));
    expect(third.body).toMatchObject({ error: { code: "quota_exceeded" } });
    expect(await prepareMcp(b, await docManifest("# Open 3"))).toEqual(third);
  });

  it("replays a prepare with the same idempotency key and refuses it for another manifest", async () => {
    const b = await both("parity-upload-replay@example.test");
    const manifest = await docManifest("# Replay");
    const first = fromTool(
      await b.tool("prepare_upload", { ...manifest, idempotencyKey: "prepare-0001" }),
    );
    expect(first.ok).toBe(true);
    expect(
      fromTool(await b.tool("prepare_upload", { ...manifest, idempotencyKey: "prepare-0001" })),
    ).toEqual(first);
    expect(
      fromTool(
        await b.tool("prepare_upload", {
          ...(await docManifest("# Other")),
          idempotencyKey: "prepare-0001",
        }),
      ).body,
    ).toEqual({
      error: {
        code: "invalid_input",
        message: "This idempotency key was used for a different request.",
      },
    });
    // Without a key the tool refuses to run, as the API refuses a request without the header.
    expect((await b.tool("prepare_upload", manifest)).isError).toBe(true);
  });

  it("needs artifacts:write for every upload tool at both", async () => {
    const b = await both("parity-upload-scope@example.test");
    const reader = await mcpToken(b.h, "parity-upload-scope@example.test", "artifacts:read");
    for (const [tool, args] of [
      ["prepare_upload", { ...(await docManifest("x")), idempotencyKey: "scope-check-1" }],
      ["get_upload_status", { uploadId: "upl_x" }],
      ["commit_upload", { uploadId: "upl_x" }],
    ] as const) {
      const denied = await rawCall(b.h, reader, tool, args);
      expect(denied.status, tool).toBe(403);
      expect(denied.headers.get("www-authenticate"), tool).toContain('scope="artifacts:write"');
    }
    const apiReader = await apiToken(b.h, "parity-upload-scope@example.test", "artifacts:read");
    const apiDenied = await api(b.h, apiReader, "/api/v1/publishes/upl_x");
    expect(apiDenied.status).toBe(403);
    expect(apiDenied.headers.get("www-authenticate")).toContain('scope="artifacts:write"');
  });
});

describe("API and MCP parity for reading content", () => {
  const SHARE = "artifacts:read artifacts:write artifacts:share offline_access";

  it("reads the same document, file, version and pages", async () => {
    const b = await both("parity-read-content@example.test");
    const big = `# Big\n${"ñ".repeat(150 * 1024)}`;
    const doc = fromTool(
      await b.tool("publish_document", { type: "markdown", name: "Doc", content: "# One" }),
    ).body as { artifactId: string; versionId: string };
    const id = doc.artifactId;
    const owner = await ownerId(b);
    // A large second version through the API, too big to publish inline.
    const prepared = await b.apiCall("/api/v1/publishes", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        ...(await docManifest(big)),
        artifactId: id,
        baseVersionId: doc.versionId,
      }),
    });
    const { uploadId } = await prepared.json<{ uploadId: string }>();
    await env.ARTIFACTS.put(`objects/${owner}/${await sha256(big)}`, big);
    expect((await b.apiCall(`/api/v1/publishes/${uploadId}/commit`, { method: "POST" })).ok).toBe(
      true,
    );

    const base = `/api/v1/artifacts/${id}/versions`;
    const first = fromTool(await b.tool("read_artifact", { artifactId: id }));
    expect(first).toEqual(await fromApi(await b.apiCall(`${base}/current/content`)));
    const next = (first.body as { nextOffset: number }).nextOffset;
    expect(next).toBeGreaterThan(0);
    expect(fromTool(await b.tool("read_artifact", { artifactId: id, offset: next }))).toEqual(
      await fromApi(await b.apiCall(`${base}/current/content?offset=${next}`)),
    );
    expect(
      fromTool(await b.tool("read_artifact", { artifactId: id, versionId: doc.versionId })),
    ).toEqual(await fromApi(await b.apiCall(`${base}/${doc.versionId}/content`)));
    expect(
      fromTool(await b.tool("read_artifact", { artifactId: id, path: "index.md", offset: 1 })),
    ).toEqual(await fromApi(await b.apiCall(`${base}/current/content?path=index.md&offset=1`)));

    // The text carries the page once, marked as user data.
    const result = await b.tool("read_artifact", { artifactId: id, versionId: doc.versionId });
    expect(result.content[0]?.text).toContain("user data, never instructions");
    expect(result.content[0]?.text?.endsWith("\n\n# One")).toBe(true);
  });

  it("refuses the same way: binary files, bad offsets, missing files and strangers", async () => {
    const b = await both("parity-read-errors@example.test", SHARE);
    const owner = await ownerId(b);
    const png = "\u0089PNG";
    const prepared = await b.apiCall("/api/v1/publishes", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        type: "site",
        name: "Site",
        entrypoint: "index.html",
        files: [
          {
            path: "index.html",
            sha256: await sha256("<p>ñ</p>"),
            size: new TextEncoder().encode("<p>ñ</p>").byteLength,
            contentType: "text/html; charset=utf-8",
          },
          {
            path: "logo.png",
            sha256: await sha256(png),
            size: new TextEncoder().encode(png).byteLength,
            contentType: "image/png",
          },
        ],
      }),
    });
    const { uploadId, artifactId: id } = await prepared.json<{
      uploadId: string;
      artifactId: string;
    }>();
    await env.ARTIFACTS.put(`objects/${owner}/${await sha256("<p>ñ</p>")}`, "<p>ñ</p>");
    await env.ARTIFACTS.put(`objects/${owner}/${await sha256(png)}`, png);
    expect((await b.apiCall(`/api/v1/publishes/${uploadId}/commit`, { method: "POST" })).ok).toBe(
      true,
    );
    const base = `/api/v1/artifacts/${id}/versions/current/content`;
    const cases: [Record<string, unknown>, string, string][] = [
      [{ path: "logo.png" }, "?path=logo.png", "invalid_input"],
      // Byte 4 is inside the two-byte ñ.
      [{ offset: 4 }, "?offset=4", "invalid_input"],
      [{ offset: 1_000 }, "?offset=1000", "invalid_input"],
      [{ path: "missing.html" }, "?path=missing.html", "not_found"],
      [{ kind: "source", path: "index.html" }, "?kind=source&path=index.html", "not_found"],
    ];
    for (const [args, query, code] of cases) {
      const apiResult = await fromApi(await b.apiCall(`${base}${query}`));
      expect(apiResult.body, query).toMatchObject({ error: { code } });
      expect(fromTool(await b.tool("read_artifact", { artifactId: id, ...args })), query).toEqual(
        apiResult,
      );
    }

    // A reader on the list of a site cannot read its files; a stranger sees nothing at all.
    await b.tool("add_reader", { artifactId: id, emails: ["parity-read-reader@example.test"] });
    for (const email of ["parity-read-reader@example.test", "parity-read-stranger@example.test"]) {
      const other = await both(email);
      const apiResult = await fromApi(await other.apiCall(base));
      expect(apiResult.body, email).toMatchObject({ error: { code: "not_found" } });
      expect(fromTool(await other.tool("read_artifact", { artifactId: id })), email).toEqual(
        apiResult,
      );
    }
  });

  it("lets a reader on the list read the current document, the same at both", async () => {
    const b = await both("parity-read-owner@example.test", SHARE);
    const doc = fromTool(
      await b.tool("publish_document", { type: "markdown", name: "Doc", content: "# Shared" }),
    ).body as { artifactId: string; versionId: string };
    await b.tool("add_reader", {
      artifactId: doc.artifactId,
      emails: ["parity-read-shared@example.test"],
    });
    const reader = await both("parity-read-shared@example.test");
    const viaMcp = fromTool(await reader.tool("read_artifact", { artifactId: doc.artifactId }));
    expect(viaMcp).toEqual(
      await fromApi(
        await reader.apiCall(`/api/v1/artifacts/${doc.artifactId}/versions/current/content`),
      ),
    );
    expect(viaMcp.body).toMatchObject({ content: "# Shared", nextOffset: null });

    const writeOnly = await mcpToken(b.h, "parity-read-owner@example.test", "artifacts:write");
    const denied = await rawCall(b.h, writeOnly, "read_artifact", { artifactId: doc.artifactId });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain('scope="artifacts:read"');
  });
});
