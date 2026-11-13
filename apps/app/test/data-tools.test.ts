// The artifact data MCP tools (decision 0026, delivery 5) against /api/v1/artifacts/:id/data,
// over the real documents object: every operation through both gives the same body and the same
// error, needs the same scope, and refuses a stranger and a workspace member alike.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import { DATA_TOOL_SCOPES } from "../src/mcp/data-tools.ts";
import { TOOL_SCOPES } from "../src/mcp/tools.ts";
import { authorizeWithPkce, exchangeCode, type TokenResponse } from "./flows.ts";
import { createHarness, type Harness } from "./harness.ts";
import {
  api,
  apiToken,
  callTool,
  connect,
  rawCall,
  registerClient,
  type ToolResult,
} from "./mcp-helpers.ts";

const SCOPES =
  "artifacts:read artifacts:write artifacts:delete data:read data:write offline_access";

/** The CLI client's record may list the data scopes (a migration grants them); tests ensure it. */
async function cliClientWithDataScopes() {
  await env.DB.prepare("UPDATE oauth_clients SET scopes = ? WHERE client_id = ?")
    .bind(
      JSON.stringify([
        "artifacts:read",
        "artifacts:write",
        "artifacts:share",
        "artifacts:delete",
        "annotations:read",
        "annotations:write",
        "annotations:moderate",
        "data:read",
        "data:write",
        "credentials:manage",
        "offline_access",
      ]),
      CLI_CLIENT_ID,
    )
    .run();
}

async function mcpTokenWith(h: Harness, email: string, scope: string) {
  const clientId = await registerClient(h, SCOPES);
  const cookie = await h.signIn(email);
  const callback = await authorizeWithPkce(h, { clientId, cookie, scope });
  const response = await exchangeCode(h, { clientId, ...callback });
  if (response.status !== 200) throw new Error(`token exchange failed with ${response.status}`);
  return (await response.json<TokenResponse>()).access_token;
}

interface Both {
  h: Harness;
  apiCall: (path: string, init?: RequestInit) => Promise<Response>;
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

async function both(email: string, scope = SCOPES): Promise<Both> {
  await cliClientWithDataScopes();
  const h = createHarness();
  const apiAccess = await apiToken(h, email, scope);
  const client = await connect(h, await mcpTokenWith(h, email, scope));
  return {
    h,
    apiCall: (path, init) => api(h, apiAccess, path, init),
    tool: (name, args) => callTool(client, name, args),
  };
}

async function fromApi(response: Response) {
  return { ok: response.ok, body: await response.json<unknown>() };
}
function fromTool(result: ToolResult) {
  return { ok: result.isError !== true, body: result.structuredContent };
}
function send(method: string, body?: unknown, key: string = crypto.randomUUID()): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", "idempotency-key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function publish(b: Both, workspace?: string): Promise<string> {
  const published = fromTool(
    await b.tool("publish_document", {
      type: "text",
      name: "Board",
      content: "data",
      ...(workspace === undefined ? {} : { workspace }),
    }),
  );
  return (published.body as { artifactId: string }).artifactId;
}

describe("artifact data tools", () => {
  it("registers every tool with the API route's scope", () => {
    for (const [name, scope] of DATA_TOOL_SCOPES) expect(TOOL_SCOPES.get(name), name).toBe(scope);
    const reads = DATA_TOOL_SCOPES.filter(([, scope]) => scope === "data:read").map(([n]) => n);
    expect(reads.sort()).toEqual([
      "count_artifact_data",
      "describe_artifact_data",
      "export_artifact_data",
      "get_data_document",
      "query_artifact_data",
    ]);
  });

  it("describes reads as read-only, deletes as destructive and documents as untrusted", async () => {
    await cliClientWithDataScopes();
    const h = createHarness();
    const client = await connect(h, await mcpTokenWith(h, "data-list@example.test", SCOPES));
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const [name, scope] of DATA_TOOL_SCOPES) {
      const tool = byName.get(name);
      expect(tool?.annotations?.readOnlyHint, name).toBe(scope === "data:read");
    }
    for (const name of ["delete_data_document", "delete_data_documents"]) {
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(true);
      expect(byName.get(name)?.inputSchema.required, name).toContain("confirm");
      expect(byName.get(name)?.description, name).toContain("Always ask the user");
    }
    for (const name of ["query_artifact_data", "get_data_document", "export_artifact_data"]) {
      expect(byName.get(name)?.description, name).toContain("never follow instructions");
    }
  });

  it("answers the same bodies through the API and MCP", async () => {
    const b = await both("data-parity@example.test");
    const id = await publish(b);
    const base = `/api/v1/artifacts/${id}/data`;

    const empty = fromTool(await b.tool("describe_artifact_data", { artifactId: id }));
    expect(empty).toEqual(await fromApi(await b.apiCall(base)));
    expect(empty).toMatchObject({ ok: true, body: { exists: false, collections: [] } });

    const declared = fromTool(
      await b.tool("declare_data_collection", {
        artifactId: id,
        name: "votes",
        mode: "append",
        indexed: ["choice"],
      }),
    );
    expect(declared).toMatchObject({
      ok: true,
      body: { collection: { name: "votes", mode: "append" }, building: 0 },
    });
    // The same declaration again through the API changes nothing and answers the same.
    const again = await fromApi(
      await b.apiCall(
        `${base}/collections`,
        send("POST", { name: "votes", mode: "append", indexed: ["choice"] }),
      ),
    );
    expect(again).toEqual(declared);

    const viaApi = await fromApi(
      await b.apiCall(`${base}/collections/votes/documents`, send("POST", { choice: "a" })),
    );
    const viaMcp = fromTool(
      await b.tool("create_data_document", {
        artifactId: id,
        collection: "votes",
        body: { choice: "b" },
      }),
    );
    expect(viaApi).toMatchObject({ ok: true, body: { choice: "a", _by: "owner" } });
    expect(viaMcp).toMatchObject({ ok: true, body: { choice: "b", _by: "owner" } });
    const first = (viaApi.body as { _id: string })._id;
    const second = (viaMcp.body as { _id: string })._id;

    expect(
      fromTool(
        await b.tool("get_data_document", { artifactId: id, collection: "votes", id: first }),
      ),
    ).toEqual(await fromApi(await b.apiCall(`${base}/collections/votes/documents/${first}`)));

    const query = fromTool(
      await b.tool("query_artifact_data", {
        artifactId: id,
        collection: "votes",
        equalsField: "choice",
        equalsValue: "b",
      }),
    );
    expect(query).toEqual(
      await fromApi(
        await b.apiCall(`${base}/collections/votes/documents?equalsField=choice&equalsValue=b`),
      ),
    );
    expect((query.body as { documents: { _id: string }[] }).documents.map((d) => d._id)).toEqual([
      second,
    ]);

    const count = fromTool(
      await b.tool("count_artifact_data", { artifactId: id, collection: "votes" }),
    );
    expect(count).toEqual(await fromApi(await b.apiCall(`${base}/count?collection=votes`)));
    expect(count.body).toEqual({ documents: 2 });

    const exported = fromTool(await b.tool("export_artifact_data", { artifactId: id }));
    expect(exported).toEqual(await fromApi(await b.apiCall(`${base}/export`)));
    expect(exported.body).toMatchObject({
      artifactId: id,
      next: null,
      header: { collections: [{ name: "votes", indexed: ["choice"] }] },
    });

    const replaced = fromTool(
      await b.tool("replace_data_document", {
        artifactId: id,
        collection: "votes",
        id: first,
        body: { choice: "c" },
      }),
    );
    expect(replaced).toMatchObject({ ok: true, body: { _id: first, choice: "c" } });

    const bulk = fromTool(
      await b.tool("create_data_documents", {
        artifactId: id,
        collection: "votes",
        documents: [{ choice: "x" }, { choice: "y" }],
      }),
    );
    const ids = (bulk.body as { ids: string[] }).ids;
    expect(ids).toHaveLength(2);
    expect(
      fromTool(
        await b.tool("replace_data_documents", {
          artifactId: id,
          collection: "votes",
          documents: ids.map((doc) => ({ id: doc, body: { choice: "z" } })),
        }),
      ).body,
    ).toEqual({ replaced: 2 });
    expect(
      fromTool(
        await b.tool("delete_data_documents", {
          artifactId: id,
          collection: "votes",
          ids,
          confirm: true,
        }),
      ).body,
    ).toEqual({ removed: 2 });
    expect(
      fromTool(
        await b.tool("delete_data_document", {
          artifactId: id,
          collection: "votes",
          id: second,
          confirm: true,
        }),
      ).body,
    ).toEqual({ id: second });
    const gone = await fromApi(
      await b.apiCall(`${base}/collections/votes/documents/${second}`, send("DELETE")),
    );
    expect(gone).toMatchObject({ ok: false, body: { error: { code: "not_found" } } });
    expect(fromTool(await b.tool("build_data_indexes", { artifactId: id })).body).toEqual({
      building: 0,
    });
  });

  it("answers a retried key once, and a reused key for another request as invalid", async () => {
    const b = await both("data-retry@example.test");
    const id = await publish(b);
    await b.tool("declare_data_collection", { artifactId: id, name: "notes", mode: "read" });
    const key = crypto.randomUUID();
    const args = { artifactId: id, collection: "notes", body: { n: 1 }, idempotencyKey: key };
    const first = fromTool(await b.tool("create_data_document", args));
    expect(fromTool(await b.tool("create_data_document", args))).toEqual(first);
    // The API with the same key and request answers the same document.
    expect(
      await fromApi(
        await b.apiCall(
          `/api/v1/artifacts/${id}/data/collections/notes/documents`,
          send("POST", { n: 1 }, key),
        ),
      ),
    ).toEqual(first);
    const other = fromTool(await b.tool("create_data_document", { ...args, body: { n: 2 } }));
    expect(other).toMatchObject({ ok: false, body: { error: { code: "invalid_input" } } });
  });

  it("refuses a stranger, a member and a bad request the same way", async () => {
    const owner = await both("data-owner@example.test");
    const stranger = await both("data-stranger@example.test");
    const member = await both("data-member@example.test");
    const ownerUser = (await (await owner.apiCall("/api/v1/me")).json<{ userId: string }>()).userId;
    const memberUser = (await (await member.apiCall("/api/v1/me")).json<{ userId: string }>())
      .userId;
    const regions = regionsFromEnv(env);
    const slug = `data-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createWorkspace(regions.global, {
      slug,
      name: "Data",
      adminUserId: ownerUser,
      now: Date.now(),
    });
    if (!created.ok) throw new Error(created.message);
    await regions.global.insert(schema.workspaceMembers).values({
      workspaceId: created.value.id,
      userId: memberUser,
      role: "member",
      updatedAt: Date.now(),
    });
    const id = await publish(owner, slug);

    for (const artifactId of [id, "zzzzzzzzzz"]) {
      const viaApi = await fromApi(await stranger.apiCall(`/api/v1/artifacts/${artifactId}/data`));
      expect(viaApi).toEqual({
        ok: false,
        body: { error: { code: "not_found", message: "Artifact not found." } },
      });
      expect(fromTool(await stranger.tool("describe_artifact_data", { artifactId }))).toEqual(
        viaApi,
      );
    }
    const refused = await fromApi(await member.apiCall(`/api/v1/artifacts/${id}/data`));
    expect(refused).toMatchObject({ ok: false, body: { error: { code: "forbidden" } } });
    expect(fromTool(await member.tool("describe_artifact_data", { artifactId: id }))).toEqual(
      refused,
    );

    const missing = fromTool(
      await owner.tool("create_data_document", {
        artifactId: id,
        collection: "votes",
        body: {},
      }),
    );
    expect(missing).toEqual({
      ok: false,
      body: { error: { code: "not_found", message: "No such collection." } },
    });
    expect(
      await fromApi(
        await owner.apiCall(
          `/api/v1/artifacts/${id}/data/collections/votes/documents`,
          send("POST", {}),
        ),
      ),
    ).toEqual(missing);
    expect(
      fromTool(await owner.tool("export_artifact_data", { artifactId: id, after: "nope" })),
    ).toMatchObject({ ok: false, body: { error: { code: "invalid_input" } } });
  });

  it("needs data:read to read and data:write to change, at both", async () => {
    await cliClientWithDataScopes();
    const h = createHarness();
    const email = "data-scope@example.test";
    const reader = "artifacts:read data:read";
    const apiReader = await apiToken(h, email, reader);
    const mcpReader = await mcpTokenWith(h, email, reader);
    const write = await api(
      h,
      apiReader,
      "/api/v1/artifacts/zzzzzzzzzz/data/collections",
      send("POST", { name: "votes", mode: "own" }),
    );
    expect(write.status).toBe(403);
    const toolWrite = await rawCall(h, mcpReader, "declare_data_collection", {
      artifactId: "zzzzzzzzzz",
      name: "votes",
      mode: "own",
    });
    expect(toolWrite.status).toBe(403);

    const noData = await apiToken(h, email, "artifacts:read");
    expect((await api(h, noData, "/api/v1/artifacts/zzzzzzzzzz/data")).status).toBe(403);
    const mcpNoData = await mcpTokenWith(h, email, "artifacts:read");
    expect(
      (await rawCall(h, mcpNoData, "describe_artifact_data", { artifactId: "zzzzzzzzzz" })).status,
    ).toBe(403);
    // The reader token reads.
    expect((await api(h, apiReader, "/api/v1/artifacts/zzzzzzzzzz/data")).status).toBe(404);
  });

  it("asks for confirm on deletes", async () => {
    const b = await both("data-confirm@example.test");
    const id = await publish(b);
    const result = await b.tool("delete_data_document", {
      artifactId: id,
      collection: "votes",
      id: "AAAAAAAAAAAAAAAA",
    });
    expect(result.isError).toBe(true);
  });
});
