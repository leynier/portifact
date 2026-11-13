// The owner document API of artifact data (decision 0026, delivery 5) through /api/v1, against
// the real documents object of `portifact-data` (bound by script name in the test pool): every
// route's success, the scopes, the roles, the switch, idempotent retries, the export pages and
// the audit relay settling with the real object. MCP parity is in mcp-parity.test.ts.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { dataNamespaces, runDataAudit } from "@portifact/services";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-13T09:00:00Z");
const DATA = "artifacts:read artifacts:write data:read data:write offline_access";
const db = () => regionsFromEnv(env).get("default").db;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface Owner {
  h: Harness;
  userId: string;
  call: (path: string, init?: RequestInit) => Promise<Response>;
  artifactId: string;
}

const json = (
  method: string,
  body?: unknown,
  key = `data-key-${crypto.randomUUID()}`,
): RequestInit => ({
  method,
  headers: { "content-type": "application/json", "idempotency-key": key },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function owner(email: string, scope = DATA, harness?: Harness): Promise<Owner> {
  const h = harness ?? createHarness();
  const token = await apiToken(h, email, scope);
  const call = (path: string, init?: RequestInit) => api(h, token, path, init);
  const { userId } = await (await call("/api/v1/me")).json<{ userId: string }>();
  const client = await connect(h, await mcpToken(h, email, "artifacts:read artifacts:write"));
  const published = await callTool(client, "publish_document", {
    type: "text",
    name: "Votes",
    content: "votes",
  });
  const artifactId = (published.structuredContent as { artifactId: string }).artifactId;
  return { h, userId, call, artifactId };
}

const base = (o: Owner) => `/api/v1/artifacts/${o.artifactId}/data`;
const docs = (o: Owner, collection = "votes") => `${base(o)}/collections/${collection}/documents`;

async function declare(o: Owner) {
  const response = await o.call(
    `${base(o)}/collections`,
    json("POST", { name: "votes", mode: "own", indexed: ["choice"] }),
  );
  expect(response.status).toBe(201);
  return response.json<{ collection: { name: string }; building: number }>();
}

describe("the owner document API", () => {
  it("declares, writes, reads, queries, counts and deletes on the real object", async () => {
    const o = await owner("data-flow@example.test");
    const empty = await (await o.call(base(o))).json<{ exists: boolean }>();
    expect(empty).toMatchObject({ exists: false, collections: [] });

    expect(await declare(o)).toMatchObject({ collection: { name: "votes" }, building: 0 });

    const created = await o.call(docs(o), json("POST", { choice: "a" }));
    expect(created.status).toBe(201);
    const doc = await created.json<{ _id: string; _by: string; choice: string }>();
    expect(doc).toMatchObject({ choice: "a", _by: "owner" });

    expect(await (await o.call(`${docs(o)}/${doc._id}`)).json()).toMatchObject({ choice: "a" });
    const replaced = await o.call(`${docs(o)}/${doc._id}`, json("PUT", { choice: "b" }));
    expect(await replaced.json()).toMatchObject({ _id: doc._id, choice: "b" });

    const page = await (await o.call(`${docs(o)}?equalsField=choice&equalsValue=b&limit=10`)).json<{
      documents: { _id: string }[];
      next: string | null;
    }>();
    expect(page.documents.map((item) => item._id)).toEqual([doc._id]);
    expect(await (await o.call(`${base(o)}/count?collection=votes`)).json()).toEqual({
      documents: 1,
    });

    const bulk = await o.call(
      `${docs(o)}/bulk`,
      json("POST", { documents: [{ choice: "c" }, { choice: "d" }] }),
    );
    expect(bulk.status).toBe(201);
    const { ids } = await bulk.json<{ ids: string[] }>();
    expect(
      await (
        await o.call(
          `${docs(o)}/bulk`,
          json("PUT", { documents: ids.map((id) => ({ id, body: { choice: "e" } })) }),
        )
      ).json(),
    ).toEqual({ replaced: 2 });
    expect(await (await o.call(`${docs(o)}/bulk-delete`, json("POST", { ids }))).json()).toEqual({
      removed: 2,
    });
    expect(await (await o.call(`${docs(o)}/${doc._id}`, json("DELETE"))).json()).toEqual({
      id: doc._id,
    });
    expect((await o.call(`${docs(o)}/${doc._id}`)).status).toBe(404);

    const described = await (await o.call(base(o))).json<{
      exists: boolean;
      collections: { name: string; documents: number }[];
      storedBytes: number;
    }>();
    expect(described.exists).toBe(true);
    expect(described.collections).toMatchObject([{ name: "votes", documents: 0 }]);
    // The storage report each answer carries reached D1.
    expect(described.storedBytes).toBeGreaterThan(0);
  });

  it("answers a retried change from its record, applied once", async () => {
    const o = await owner("data-retry@example.test");
    await declare(o);
    const init = json("POST", { choice: "a" }, "the-same-key-1");
    const first = await (await o.call(docs(o), init)).json<{ _id: string }>();
    const again = await (await o.call(docs(o), init)).json<{ _id: string }>();
    expect(again._id).toBe(first._id);
    expect(await (await o.call(`${base(o)}/count?collection=votes`)).json()).toEqual({
      documents: 1,
    });
    const other = await o.call(docs(o), json("POST", { choice: "z" }, "the-same-key-1"));
    expect(other.status).toBe(400);
  });

  it("exports pages with the header and every stored body", async () => {
    const o = await owner("data-export@example.test");
    await declare(o);
    await o.call(
      `${docs(o)}/bulk`,
      json("POST", { documents: [{ choice: "a", n: 1.5 }, { choice: "b" }] }),
    );
    const page = await (await o.call(`${base(o)}/export`)).json<{
      revision: number;
      rows: { collection: string; id: string; body: string }[];
      next: string | null;
      header: { generation: number; revision: number; collections: unknown[] };
    }>();
    expect(page.header.collections).toEqual([
      { name: "votes", mode: "own", uniqueKey: null, indexed: ["choice"] },
    ]);
    expect(page.header.revision).toBe(page.revision);
    expect(page.rows.map((row) => JSON.parse(row.body))).toEqual(
      expect.arrayContaining([{ choice: "a", n: 1.5 }, { choice: "b" }]),
    );
    expect(page.next).toBeNull();
    const cursor = `${page.rows[0]?.collection}/${page.rows[0]?.id}`;
    const later = await (await o.call(`${base(o)}/export?after=${cursor}`)).json<{
      rows: unknown[];
      header: unknown;
    }>();
    expect(later.header).toBeNull();
    expect(later.rows).toHaveLength(1);
    expect((await o.call(`${base(o)}/export?after=nope`)).status).toBe(400);
  });

  it("refuses invalid input before the object", async () => {
    const o = await owner("data-invalid@example.test");
    expect(
      (await o.call(`${base(o)}/collections`, json("POST", { name: "Bad Name", mode: "own" })))
        .status,
    ).toBe(400);
    expect((await o.call(`${base(o)}/count`)).status).toBe(400);
    expect((await o.call(`${docs(o)}?limit=1000`)).status).toBe(400);
    expect((await o.call(`${docs(o)}?createdOp=gt&createdValue=-1`)).status).toBe(400);
    const noKey = await o.call(`${base(o)}/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "votes", mode: "own" }),
    });
    expect(noKey.status).toBe(400);
    expect((await o.call(`${docs(o)}/bulk-delete`, json("POST", { ids: [] }))).status).toBe(400);
  });
});

describe("who may use it", () => {
  it("needs the data scopes: a token without them is refused", async () => {
    const h = createHarness();
    const o = await owner("data-scopes@example.test", DATA, h);
    const narrow = await apiToken(h, "data-scopes@example.test", "artifacts:read artifacts:write");
    const read = await api(h, narrow, base(o));
    expect(read.status).toBe(403);
    const readOnly = await apiToken(h, "data-scopes@example.test", "data:read");
    expect((await api(h, readOnly, base(o))).status).toBe(200);
    expect(
      (
        await api(
          h,
          readOnly,
          `${base(o)}/collections`,
          json("POST", { name: "votes", mode: "own" }),
        )
      ).status,
    ).toBe(403);
  });

  it("answers a stranger like a missing artifact", async () => {
    const h = createHarness();
    const o = await owner("data-owner@example.test", DATA, h);
    const stranger = await apiToken(h, "data-stranger@example.test", DATA);
    const response = await api(h, stranger, base(o));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers 404 while artifact data is off, except the export", async () => {
    const h = createHarness({ env: { ARTIFACT_DATA_ENABLED: undefined } });
    const o = await owner("data-off@example.test", DATA, h);
    const describe = await o.call(base(o));
    expect(describe.status).toBe(404);
    expect(await describe.json()).toMatchObject({
      error: { message: "Artifact data is not available." },
    });
    expect(
      (await o.call(`${base(o)}/collections`, json("POST", { name: "votes", mode: "own" }))).status,
    ).toBe(404);
    const exported = await o.call(`${base(o)}/export`);
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({ rows: [], next: null });
    const [row] = await db()
      .select()
      .from(schema.artifactData)
      .where(eq(schema.artifactData.artifactId, o.artifactId));
    expect(row).toBeUndefined();
  });
});

describe("the audit relay with the real object", () => {
  it("records a committed change once and a never-arrived one as nothing", async () => {
    const o = await owner("data-audit@example.test");
    await declare(o);
    await o.call(docs(o), json("POST", { choice: "a" }));
    const jobs = await db()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "data_audit"), eq(schema.outbox.subject, o.artifactId)));
    expect(jobs).toHaveLength(2);
    const objects = dataNamespaces(env, "default");
    for (const job of jobs) {
      expect(await runDataAudit(db(), objects, job, NOW + 60_000)).toBe("done");
      expect(await runDataAudit(db(), objects, job, NOW + 60_000)).toBe("done");
    }
    const events = await db()
      .select({ kind: schema.auditEvents.kind, actor: schema.auditEvents.actorId })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.artifactId, o.artifactId));
    expect(
      events
        .filter((event) => event.kind.startsWith("data."))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual([
      { kind: "data.collection_set", actor: o.userId },
      { kind: "data.document_created", actor: o.userId },
    ]);
  });
});

describe("more routes", () => {
  it("builds indexes, counts by author and refuses an invalid collection in a query", async () => {
    const o = await owner("data-routes@example.test");
    expect((await o.call(`${base(o)}/indexes/build`, json("POST"))).status).toBe(404);
    await declare(o);
    const built = await o.call(`${base(o)}/indexes/build`, json("POST"));
    expect(await built.json()).toEqual({ building: 0 });
    await o.call(docs(o), json("POST", { choice: "a" }));
    expect(await (await o.call(`${base(o)}/count?collection=votes&by=owner`)).json()).toEqual({
      documents: 1,
    });
    expect(
      await (
        await o.call(`${base(o)}/count?collection=votes&equalsField=choice&equalsValue=a`)
      ).json(),
    ).toEqual({ documents: 1 });
    expect((await o.call(`${docs(o, "Bad-Name")}`)).status).toBe(400);
    expect((await o.call(`${docs(o)}?createdOp=gt&createdValue=5&order=-created`)).status).toBe(
      200,
    );
  });

  it("refuses a change without a JSON body on every route", async () => {
    const o = await owner("data-bodies@example.test");
    const plain = (method: string): RequestInit => ({
      method,
      headers: { "content-type": "text/plain", "idempotency-key": crypto.randomUUID() },
      body: "x",
    });
    for (const [path, method] of [
      [`${base(o)}/collections`, "POST"],
      [docs(o), "POST"],
      [`${docs(o)}/bulk`, "POST"],
      [`${docs(o)}/bulk`, "PUT"],
      [`${docs(o)}/bulk-delete`, "POST"],
      [`${docs(o)}/AAAAAAAAAAAAAAAA`, "PUT"],
    ] as const) {
      const response = await o.call(path, plain(method));
      expect(response.status, `${method} ${path}`).toBe(400);
    }
  });
});
