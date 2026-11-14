// The artifact data MCP tools (decision 0026, delivery 5) against /api/v1/artifacts/:id/data,
// over the real documents object: every operation through both gives the same body and the same
// error, needs the same scope, and refuses a stranger and a workspace member alike.
import { env } from "cloudflare:workers";
import { DEFAULT_POLICY } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace } from "@portifact/services";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
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
      "get_data_writers",
      "query_artifact_data",
    ]);
  });

  it("describes reads as read-only, deletes as destructive and documents as untrusted", async () => {
    const h = createHarness();
    const client = await connect(h, await mcpTokenWith(h, "data-list@example.test", SCOPES));
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const [name, scope] of DATA_TOOL_SCOPES) {
      const tool = byName.get(name);
      expect(tool?.annotations?.readOnlyHint, name).toBe(scope === "data:read");
    }
    for (const name of [
      "delete_data_document",
      "delete_data_documents",
      "erase_artifact_data",
      "delete_author_data",
    ]) {
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
    // Every tool answers a stranger like a missing artifact, before anything reaches the object.
    const target = { artifactId: id, collection: "votes" };
    const doc = "AAAAAAAAAAAAAAAA";
    for (const [name, args] of [
      ["declare_data_collection", { artifactId: id, name: "votes", mode: "own" }],
      ["build_data_indexes", { artifactId: id }],
      ["query_artifact_data", target],
      ["get_data_document", { ...target, id: doc }],
      ["count_artifact_data", target],
      ["export_artifact_data", { artifactId: id }],
      ["create_data_document", { ...target, body: {} }],
      ["replace_data_document", { ...target, id: doc, body: {} }],
      ["delete_data_document", { ...target, id: doc, confirm: true }],
      ["create_data_documents", { ...target, documents: [{}] }],
      ["replace_data_documents", { ...target, documents: [{ id: doc, body: {} }] }],
      ["delete_data_documents", { ...target, ids: [doc], confirm: true }],
    ] as const) {
      expect(fromTool(await stranger.tool(name, args)), name).toEqual({
        ok: false,
        body: { error: { code: "not_found", message: "Artifact not found." } },
      });
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

  it("summarizes collections, pages and exports in text, with a cursor when more remain", async () => {
    const b = await both("data-text@example.test");
    const id = await publish(b);
    const declared = await b.tool("declare_data_collection", {
      artifactId: id,
      name: "people",
      mode: "read",
      uniqueKey: "email",
      indexed: ["team"],
    });
    expect(declared.isError).not.toBe(true);
    await b.tool("create_data_documents", {
      artifactId: id,
      collection: "people",
      documents: [
        { email: "a@x.test", team: "red" },
        { email: "b@x.test", team: "red" },
        { email: "c@x.test", team: "blue" },
      ],
    });
    await b.tool("declare_data_collection", { artifactId: id, name: "notes", mode: "own" });
    const described = await b.tool("describe_artifact_data", { artifactId: id });
    const text = (described.content as { text: string }[])[0]?.text;
    expect(text).toContain("unique email");
    expect(text).toContain("indexed team (ready)");
    expect(text).toMatch(/^- notes: own, 0 document\(s\), 0 bytes$/m);
    const page = await b.tool("query_artifact_data", {
      artifactId: id,
      collection: "people",
      equalsField: "team",
      equalsValue: "red",
      limit: 1,
    });
    expect((page.content as { text: string }[])[0]?.text).toContain("More: call again with after");
    const next = (page.structuredContent as { next: string }).next;
    const second = await b.tool("query_artifact_data", {
      artifactId: id,
      collection: "people",
      equalsField: "team",
      equalsValue: "red",
      limit: 1,
      after: next,
    });
    expect((second.structuredContent as { documents: unknown[] }).documents).toHaveLength(1);
    const built = await b.tool("build_data_indexes", { artifactId: id });
    expect((built.content as { text: string }[])[0]?.text).toContain(
      "Every indexed field is built.",
    );
    const exported = await b.tool("export_artifact_data", { artifactId: id });
    expect(exported.structuredContent).toMatchObject({ next: null, header: { revision: 3 } });
    const badCursor = await b.tool("export_artifact_data", { artifactId: id, after: "people" });
    expect(badCursor.isError).toBe(true);
    const missing = await b.tool("get_data_document", {
      artifactId: id,
      collection: "people",
      id: "AAAAAAAAAAAAAAAA",
    });
    expect(missing.structuredContent).toMatchObject({ error: { code: "not_found" } });
  });

  it("pages a large export with a cursor", async () => {
    const b = await both("data-running@example.test");
    const id = await publish(b);
    await b.tool("declare_data_collection", { artifactId: id, name: "notes", mode: "own" });
    // A hundred bodies of 15 KiB: more than one export page's 1 MiB (written through the API,
    // since an MCP request body is itself capped at 1 MiB).
    const text = "x".repeat(15 * 1024);
    const created = await b.apiCall(
      `/api/v1/artifacts/${id}/data/collections/notes/documents/bulk`,
      send("POST", { documents: Array.from({ length: 100 }, (_, n) => ({ n, text })) }),
    );
    expect(created.status).toBe(201);
    const first = await b.tool("export_artifact_data", { artifactId: id });
    const page = first.structuredContent as { rows: unknown[]; next: string | null };
    expect(page.rows.length).toBeLessThan(100);
    expect(page.next).not.toBeNull();
    expect((first.content as { text: string }[])[0]?.text).toContain(
      `More: call again with after "${page.next}"`,
    );
    const rest = await b.tool("export_artifact_data", { artifactId: id, after: page.next });
    const second = rest.structuredContent as { rows: unknown[]; next: string | null };
    expect(page.rows.length + second.rows.length).toBe(100);
    expect(second.next).toBeNull();
  });
});

describe("the owner's erase and one author's deletion", () => {
  async function seeded(b: Both) {
    const id = await publish(b);
    const base = `/api/v1/artifacts/${id}/data`;
    expect(
      (await b.apiCall(`${base}/collections`, send("POST", { name: "votes", mode: "shared" })))
        .status,
    ).toBe(201);
    const created = await b.apiCall(
      `${base}/collections/votes/documents/bulk`,
      send("POST", { documents: [{ n: 1 }, { n: 2 }] }),
    );
    expect(created.status).toBe(201);
    return { id, base };
  }

  it("erases through the API and MCP alike, and asks for confirm at both", async () => {
    const b = await both("data-erase@example.test");
    const first = await seeded(b);
    expect((await b.apiCall(`${first.base}/erase`, send("POST", {}))).status).toBe(400);
    expect((await b.tool("erase_artifact_data", { artifactId: first.id })).isError).toBe(true);
    const viaApi = await fromApi(
      await b.apiCall(`${first.base}/erase`, send("POST", { confirm: true })),
    );
    expect(viaApi).toEqual({ ok: true, body: { erased: true, generation: 1 } });
    const after = await fromApi(await b.apiCall(first.base));
    expect(after).toMatchObject({ ok: true, body: { collections: [] } });

    // The same artifact again, declared anew, erased through MCP.
    expect(
      (
        await b.apiCall(
          `${first.base}/collections`,
          send("POST", { name: "votes", mode: "shared" }),
        )
      ).status,
    ).toBe(201);
    const viaTool = fromTool(
      await b.tool("erase_artifact_data", { artifactId: first.id, confirm: true }),
    );
    expect(viaTool).toEqual({ ok: true, body: { erased: true, generation: 2 } });
  });

  it("deletes one author's documents alike, refusing an author that is not opaque", async () => {
    const b = await both("data-author@example.test");
    const { id, base } = await seeded(b);
    const author = "v_AAAAAAAAAAAAAAAA";
    const viaApi = await fromApi(
      await b.apiCall(`${base}/authors/${author}/delete`, send("POST", { confirm: true })),
    );
    expect(viaApi).toEqual({ ok: true, body: { removed: 0, more: false } });
    const viaTool = fromTool(
      await b.tool("delete_author_data", { artifactId: id, author, confirm: true }),
    );
    expect(viaTool).toEqual(viaApi);
    const bad = await b.apiCall(`${base}/authors/owner/delete`, send("POST", { confirm: true }));
    expect(bad.status).toBe(400);
    expect(
      (await b.tool("delete_author_data", { artifactId: id, author: "owner", confirm: true }))
        .isError,
    ).toBe(true);
    expect((await b.apiCall(`${base}/authors/${author}/delete`, send("POST", {}))).status).toBe(
      400,
    );
  });

  it("refuses a stranger and a reader token the same way at both", async () => {
    const h = createHarness();
    const owner = await both("data-erase-owner@example.test");
    const { id } = await seeded(owner);
    const stranger = await both("data-erase-stranger@example.test");
    const api404 = await stranger.apiCall(
      `/api/v1/artifacts/${id}/data/erase`,
      send("POST", { confirm: true }),
    );
    expect(api404.status).toBe(404);
    const tool404 = fromTool(
      await stranger.tool("erase_artifact_data", { artifactId: id, confirm: true }),
    );
    expect(tool404).toEqual({ ok: false, body: await api404.json() });
    const reader = await apiToken(h, "data-erase-reader@example.test", "artifacts:read data:read");
    expect(
      (await api(h, reader, `/api/v1/artifacts/${id}/data/erase`, send("POST", { confirm: true })))
        .status,
    ).toBe(403);
    const mcpReader = await mcpTokenWith(
      h,
      "data-erase-reader@example.test",
      "artifacts:read data:read",
    );
    expect(
      (
        await rawCall(h, mcpReader, "delete_author_data", {
          artifactId: id,
          author: "v_AAAAAAAAAAAAAAAA",
          confirm: true,
        })
      ).status,
    ).toBe(403);
  });
});

describe("who may write from the page (delivery 9)", () => {
  const writers = (b: Both, id: string, value?: string) =>
    b.apiCall(
      `/api/v1/artifacts/${id}/data/writers`,
      value === undefined
        ? undefined
        : {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ writers: value }),
          },
    );

  async function withData(b: Both, workspace?: string): Promise<string> {
    const id = await publish(b, workspace);
    const declared = await b.apiCall(
      `/api/v1/artifacts/${id}/data/collections`,
      send("POST", { name: "board", mode: "shared" }),
    );
    expect(declared.status).toBe(201);
    return id;
  }

  async function workspaceOf(owner: Both, plan: "free" | "enterprise", policy?: unknown) {
    const ownerUser = (await (await owner.apiCall("/api/v1/me")).json<{ userId: string }>()).userId;
    const regions = regionsFromEnv(env);
    const slug = `wr-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createWorkspace(regions.global, {
      slug,
      name: "Writers",
      adminUserId: ownerUser,
      now: Date.now(),
    });
    if (!created.ok) throw new Error(created.message);
    if (plan !== "free") {
      await regions.global.insert(schema.ownerPlans).values({
        ownerId: created.value.id,
        plan,
        seats: 1,
        grantedBy: "test",
        updatedAt: Date.now(),
      });
    }
    if (policy !== undefined) {
      await regions.global
        .update(schema.workspaces)
        .set({ policy })
        .where(eq(schema.workspaces.id, created.value.id));
    }
    return { slug, workspaceId: created.value.id };
  }

  async function writerEvents(id: string) {
    return regionsFromEnv(env)
      .get("default")
      .db.select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.kind, "data.writers_changed"),
          eq(schema.auditEvents.artifactId, id),
        ),
      );
  }

  it("reads and sets them alike through the API and MCP, and the description carries them", async () => {
    const b = await both("data-writers@example.test");
    const id = await withData(b);
    const shown = await fromApi(await writers(b, id));
    expect(shown).toEqual({
      ok: true,
      body: { artifactId: id, writers: "signed_in", anonymous: "off" },
    });
    expect(fromTool(await b.tool("get_data_writers", { artifactId: id }))).toEqual(shown);

    const opened = fromTool(
      await b.tool("set_data_writers", { artifactId: id, writers: "anyone" }),
    );
    expect(opened).toEqual({
      ok: true,
      body: { artifactId: id, writers: "anyone", anonymous: "available" },
    });
    expect(await fromApi(await writers(b, id, "anyone"))).toEqual(opened);
    const described = await (await b.apiCall(`/api/v1/artifacts/${id}/data`)).json<{
      writers: string;
    }>();
    expect(described.writers).toBe("anyone");
    expect(await fromApi(await writers(b, id, "signed_in"))).toEqual({
      ok: true,
      body: { artifactId: id, writers: "signed_in", anonymous: "off" },
    });
    // One event per change; setting the same value again records nothing.
    expect(await writerEvents(id)).toHaveLength(2);
  });

  it("asks a workspace for policies in its plan, then for its policy, and always allows narrowing", async () => {
    const owner = await both("data-writers-ws@example.test");
    const free = await workspaceOf(owner, "free");
    const onFree = await withData(owner, free.slug);
    const planRefused = await fromApi(await writers(owner, onFree, "anyone"));
    expect(planRefused).toMatchObject({ ok: false, body: { error: { code: "plan_required" } } });
    expect(
      fromTool(await owner.tool("set_data_writers", { artifactId: onFree, writers: "anyone" })),
    ).toEqual(planRefused);
    expect((await writers(owner, onFree, "signed_in")).status).toBe(200);

    const strict = await workspaceOf(owner, "enterprise");
    const onStrict = await withData(owner, strict.slug);
    const policyRefused = await fromApi(await writers(owner, onStrict, "anyone"));
    expect(policyRefused).toMatchObject({
      ok: false,
      body: { error: { code: "policy_refused" } },
    });
    expect(
      fromTool(await owner.tool("set_data_writers", { artifactId: onStrict, writers: "anyone" })),
    ).toEqual(policyRefused);

    const open = await workspaceOf(owner, "enterprise", {
      ...DEFAULT_POLICY,
      anonymousDataWriters: "allowed",
    });
    const onOpen = await withData(owner, open.slug);
    expect(await fromApi(await writers(owner, onOpen, "anyone"))).toEqual({
      ok: true,
      body: { artifactId: onOpen, writers: "anyone", anonymous: "available" },
    });
  });

  it("refuses a stranger like a missing artifact and a member as forbidden", async () => {
    const owner = await both("data-writers-owner@example.test");
    const stranger = await both("data-writers-stranger@example.test");
    const member = await both("data-writers-member@example.test");
    const ws = await workspaceOf(owner, "free");
    const memberUser = (await (await member.apiCall("/api/v1/me")).json<{ userId: string }>())
      .userId;
    await regionsFromEnv(env).global.insert(schema.workspaceMembers).values({
      workspaceId: ws.workspaceId,
      userId: memberUser,
      role: "member",
      updatedAt: Date.now(),
    });
    const id = await withData(owner, ws.slug);
    const missing = await fromApi(await writers(stranger, id, "signed_in"));
    expect(missing).toEqual({
      ok: false,
      body: { error: { code: "not_found", message: "Artifact not found." } },
    });
    expect(
      fromTool(await stranger.tool("set_data_writers", { artifactId: id, writers: "signed_in" })),
    ).toEqual(missing);
    const forbidden = await fromApi(await writers(member, id));
    expect(forbidden).toMatchObject({ ok: false, body: { error: { code: "forbidden" } } });
    expect(fromTool(await member.tool("get_data_writers", { artifactId: id }))).toEqual(forbidden);
  });

  it("answers that an artifact without data has none, and needs data:write to change", async () => {
    const email = "data-writers-empty@example.test";
    const b = await both(email);
    const id = await publish(b);
    expect(await fromApi(await writers(b, id))).toMatchObject({
      ok: false,
      body: { error: { code: "not_found" } },
    });
    const reader = await apiToken(b.h, email, "artifacts:read data:read");
    const refused = await api(b.h, reader, `/api/v1/artifacts/${id}/data/writers`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ writers: "signed_in" }),
    });
    expect(refused.status).toBe(403);
    expect((await writers(b, id, "everyone")).status).toBe(400);
  });

  it("only narrows for a token whose account has not accepted the current terms", async () => {
    const email = "data-writers-terms@example.test";
    const b = await both(email);
    const id = await withData(b);
    await env.DB.prepare("update users set terms_version = ? where email = ?")
      .bind("2000-01-01", email)
      .run();
    const widen = await fromApi(await writers(b, id, "anyone"));
    expect(widen).toMatchObject({ ok: false, body: { error: { code: "terms_not_accepted" } } });
    // MCP adds that the agent should ask the user (terms-tokens.test.ts); the code is the same.
    expect(
      fromTool(await b.tool("set_data_writers", { artifactId: id, writers: "anyone" })),
    ).toMatchObject({ ok: false, body: { error: { code: "terms_not_accepted" } } });
    expect(await fromApi(await writers(b, id, "signed_in"))).toMatchObject({ ok: true });
  });
});
