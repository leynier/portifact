// Idempotency records and regions (decision 0005, "What leaves the EU"): every keyed operation of
// the API and MCP stores its record, which holds the response it replays, in the database the
// operation writes. For an EU workspace that is the EU database, never the default one; custom
// domains are global, so their record is too. A retry with the same key and body replays the
// record without applying twice, and the same key with another body is refused. A person who lost
// their role gets what anyone without it gets, never the stored answer, which may hold content.
// With one database the keyed paths make the D1 calls develop made.
import { env } from "cloudflare:workers";
import { aliasBinding, regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace } from "@portifact/services";
import { FakeDomains } from "@portifact/services/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken, type ToolResult } from "./mcp-helpers.ts";

const SCOPES =
  "artifacts:read artifacts:write artifacts:share annotations:read annotations:write offline_access";
const OPTIONS = {
  env: { R2_BUCKET_EU: "portifact-artifacts-eu", CUSTOM_DOMAINS_ENABLED: "true" },
  domains: new FakeDomains(),
};

interface Client {
  userId: string;
  email: string;
  call: (method: string, path: string, body?: unknown, key?: string) => Promise<Answer>;
  tool: (name: string, args: Record<string, unknown>) => Promise<Answer>;
}

/** An API or MCP answer as one shape: whether it worked, the error code and the body. */
interface Answer {
  ok: boolean;
  code: string | null;
  body: unknown;
}

async function client(
  email: string,
  options: Parameters<typeof createHarness>[0] = OPTIONS,
): Promise<Client> {
  const h = createHarness(options);
  const token = await apiToken(h, email, SCOPES);
  const mcp = await connect(h, await mcpToken(h, email, SCOPES));
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const response = await api(h, token, path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await response.json()) as { error?: { code: string } };
    return { ok: response.ok, code: parsed.error?.code ?? null, body: parsed };
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result: ToolResult = await callTool(mcp, name, args);
    const body = (result.structuredContent ?? { text: result.content[0]?.text }) as {
      error?: { code: string };
    };
    return { ok: result.isError !== true, code: body.error?.code ?? null, body };
  };
  const me = await call("GET", "/api/v1/me");
  return { userId: (me.body as { userId: string }).userId, email, call, tool };
}

const eu = () => env.DB_EU as D1Database;

async function count(database: D1Database, query: string, ...params: string[]): Promise<number> {
  const row = await database
    .prepare(query)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Where the record of `key` is: in the EU database, in the default one, or both. */
async function recordOf(userId: string, key: string) {
  const query = "select count(*) as n from operations where actor_id = ? and idempotency_key = ?";
  return {
    eu: await count(eu(), query, userId, key),
    default: await count(env.DB, query, userId, key),
  };
}

let owner: Client;
let reviewer: Client;
let slug: string;
let workspaceId: string;

async function publishDoc(name: string, content = `# ${name}`) {
  const answer = await owner.tool("publish_document", {
    workspace: slug,
    type: "markdown",
    name,
    content,
  });
  expect(answer.ok, JSON.stringify(answer.body)).toBe(true);
  return answer.body as { artifactId: string; versionId: string };
}

/** Comments open and the reviewer (and `others`) on the reader list, as the owner sets them. */
async function shared(artifactId: string, others: string[] = []) {
  await eu()
    .prepare("update artifacts set annotations = 'open' where id = ?")
    .bind(artifactId)
    .run();
  const access = await owner.call("PATCH", `/api/v1/artifacts/${artifactId}/access`, {
    addReaders: [reviewer.email, ...others],
  });
  expect(access.ok, JSON.stringify(access.body)).toBe(true);
}

const DOC = { schema: 1, path: "index.md", anchor: { kind: "document" } };

beforeAll(async () => {
  owner = await client(`idem-owner-${crypto.randomUUID()}@example.test`);
  reviewer = await client(`idem-reviewer-${crypto.randomUUID()}@example.test`);
  const regions = regionsFromEnv(env);
  slug = `idem-${crypto.randomUUID().slice(0, 8)}`;
  const created = await createWorkspace(regions.global, {
    slug,
    name: "EU",
    adminUserId: owner.userId,
    now: Date.now(),
    region: "eu",
  });
  if (!created.ok) throw new Error(created.message);
  workspaceId = created.value.id;
  await regions.global
    .insert(schema.ownerPlans)
    .values({ ownerId: workspaceId, plan: "enterprise", grantedBy: "test", updatedAt: 0 });
});

// At most two open uploads per owner (`0016_open_uploads_limit`): each case's are closed after it,
// as cancelling them would, so the next case can open its own.
afterEach(async () => {
  if (!workspaceId) return;
  await eu().batch([
    eu().prepare("delete from upload_sessions where owner_id = ?").bind(workspaceId),
    eu().prepare("update account_usage set open_uploads = 0 where owner_id = ?").bind(workspaceId),
  ]);
});

interface Arranged {
  run: (key: string, variant: 0 | 1) => Promise<Answer>;
  effect: () => Promise<number>;
  actor?: Client;
}

interface KeyedCase {
  name: string;
  /** Where the record must be: the EU database, or the global one (custom domains). */
  home: "eu" | "default";
  /** Arranges what the operation needs and says how to run it with a key and a body variant. */
  arrange: () => Promise<Arranged>;
}

const threads = (artifactId: string) =>
  count(eu(), "select count(*) as n from annotation_threads where artifact_id = ?", artifactId);
const messages = (threadId: string) =>
  count(eu(), "select count(*) as n from annotation_messages where thread_id = ?", threadId);

/** Another admin of the workspace, so each case stays under the per-person comment rate. */
async function freshAdmin(): Promise<Client> {
  const admin = await client(`idem-admin-${crypto.randomUUID()}@example.test`);
  await regionsFromEnv(env)
    .global.insert(schema.workspaceMembers)
    .values({ workspaceId, userId: admin.userId, role: "admin", updatedAt: Date.now() });
  return admin;
}

async function threadOn(by: Client, artifactId: string, versionId: string): Promise<string> {
  const thread = await by.tool("create_annotation", {
    artifactId,
    versionId,
    target: DOC,
    body: "First",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(thread.ok, JSON.stringify(thread.body)).toBe(true);
  return (thread.body as { id: string }).id;
}

const CASES: KeyedCase[] = [
  {
    name: "API annotation create",
    home: "eu",
    arrange: async () => {
      const { artifactId, versionId } = await publishDoc("Thread API");
      await shared(artifactId);
      const by = await freshAdmin();
      return {
        actor: by,
        run: (key, variant) =>
          by.call(
            "POST",
            `/api/v1/artifacts/${artifactId}/annotations/threads`,
            { versionId, target: DOC, body: variant ? "B" : "A" },
            key,
          ),
        effect: () => threads(artifactId),
      };
    },
  },
  {
    name: "API annotation reply",
    home: "eu",
    arrange: async () => {
      const { artifactId, versionId } = await publishDoc("Reply API");
      await shared(artifactId);
      const by = await freshAdmin();
      const threadId = await threadOn(by, artifactId, versionId);
      return {
        actor: by,
        run: (key, variant) =>
          by.call(
            "POST",
            `/api/v1/artifacts/${artifactId}/annotations/threads/${threadId}/messages`,
            { body: variant ? "B" : "A" },
            key,
          ),
        effect: () => messages(threadId),
      };
    },
  },
  {
    name: "MCP create_annotation",
    home: "eu",
    arrange: async () => {
      const { artifactId, versionId } = await publishDoc("Thread MCP");
      await shared(artifactId);
      const by = await freshAdmin();
      return {
        actor: by,
        run: (key, variant) =>
          by.tool("create_annotation", {
            artifactId,
            versionId,
            target: DOC,
            body: variant ? "B" : "A",
            idempotencyKey: key,
          }),
        effect: () => threads(artifactId),
      };
    },
  },
  {
    name: "MCP reply_annotation",
    home: "eu",
    arrange: async () => {
      const { artifactId, versionId } = await publishDoc("Reply MCP");
      await shared(artifactId);
      const by = await freshAdmin();
      const threadId = await threadOn(by, artifactId, versionId);
      return {
        actor: by,
        run: (key, variant) =>
          by.tool("reply_annotation", {
            artifactId,
            threadId,
            body: variant ? "B" : "A",
            idempotencyKey: key,
          }),
        effect: () => messages(threadId),
      };
    },
  },
  ...(["API", "MCP"] as const).flatMap((via): KeyedCase[] => [
    {
      name: `${via} review.request`,
      home: "eu",
      arrange: async () => {
        const { artifactId } = await publishDoc(`Review request ${via}`);
        await shared(artifactId);
        return {
          run: (key, variant) => {
            const body = { reviewers: [reviewer.email], showStatus: variant === 1 };
            return via === "API"
              ? owner.call("POST", `/api/v1/artifacts/${artifactId}/review/request`, body, key)
              : owner.tool("request_review", { artifactId, ...body, idempotencyKey: key });
          },
          effect: () =>
            count(
              eu(),
              "select count(*) as n from review_requests where artifact_id = ?",
              artifactId,
            ),
        };
      },
    },
    {
      name: `${via} review.change`,
      home: "eu",
      arrange: async () => {
        const { artifactId } = await publishDoc(`Review change ${via}`);
        const second = `idem-second-${crypto.randomUUID()}@example.test`;
        await shared(artifactId, [second]);
        const requested = await owner.tool("request_review", {
          artifactId,
          reviewers: [reviewer.email],
        });
        expect(requested.ok, JSON.stringify(requested.body)).toBe(true);
        return {
          run: (key, variant) => {
            const body = variant ? { add: [reviewer.email] } : { add: [second] };
            return via === "API"
              ? owner.call("PATCH", `/api/v1/artifacts/${artifactId}/review/request`, body, key)
              : owner.tool("request_review", {
                  artifactId,
                  action: "change",
                  ...body,
                  idempotencyKey: key,
                });
          },
          effect: () =>
            count(
              eu(),
              "select count(*) as n from review_reviewers where request_id in (select id from review_requests where artifact_id = ?)",
              artifactId,
            ),
        };
      },
    },
    {
      name: `${via} review.verdict`,
      home: "eu",
      arrange: async () => {
        const { artifactId } = await publishDoc(`Review verdict ${via}`);
        await shared(artifactId);
        const requested = await owner.tool("request_review", {
          artifactId,
          reviewers: [reviewer.email],
        });
        expect(requested.ok, JSON.stringify(requested.body)).toBe(true);
        return {
          actor: reviewer,
          run: (key, variant) => {
            const body = { verdict: variant ? "changes" : "approve" };
            return via === "API"
              ? reviewer.call("POST", `/api/v1/artifacts/${artifactId}/review/verdict`, body, key)
              : reviewer.tool("submit_review", { artifactId, ...body, idempotencyKey: key });
          },
          effect: () =>
            count(
              eu(),
              "select count(*) as n from review_verdicts where request_id in (select id from review_requests where artifact_id = ?)",
              artifactId,
            ),
        };
      },
    },
    {
      name: `${via} rollback`,
      home: "eu",
      arrange: async () => {
        const first = await publishDoc(`Rollback ${via}`, "# One");
        const second = await owner.tool("publish_document", {
          artifactId: first.artifactId,
          baseVersionId: first.versionId,
          type: "markdown",
          name: `Rollback ${via}`,
          content: "# Two",
        });
        expect(second.ok, JSON.stringify(second.body)).toBe(true);
        const base = (second.body as { versionId: string }).versionId;
        return {
          run: (key, variant) => {
            const body = { versionId: variant ? base : first.versionId, baseVersionId: base };
            return via === "API"
              ? owner.call("POST", `/api/v1/artifacts/${first.artifactId}/rollback`, body, key)
              : owner.tool("rollback_artifact", {
                  artifactId: first.artifactId,
                  ...body,
                  idempotencyKey: key,
                });
          },
          effect: () =>
            count(
              eu(),
              "select count(*) as n from versions where artifact_id = ?",
              first.artifactId,
            ),
        };
      },
    },
    {
      name: `${via} upload prepare`,
      home: "eu",
      arrange: async () => {
        const files = [
          { path: "index.html", sha256: "b".repeat(64), size: 3, contentType: "text/html" },
        ];
        return {
          run: (key, variant) => {
            const body = {
              type: "site",
              name: variant ? "B" : "A",
              entrypoint: "index.html",
              files,
            };
            return via === "API"
              ? owner.call("POST", `/api/v1/publishes?workspace=${slug}`, body, key)
              : owner.tool("prepare_upload", { workspace: slug, ...body, idempotencyKey: key });
          },
          effect: () =>
            count(
              eu(),
              "select count(*) as n from upload_sessions where owner_id = ?",
              workspaceId,
            ),
        };
      },
    },
    {
      name: `${via} domain add`,
      // Custom domains and their claims are global (decision 0006): so is their record.
      home: "default",
      arrange: async () => {
        const { artifactId } = await publishDoc(`Domain ${via}`);
        const label = crypto.randomUUID().slice(0, 8);
        return {
          run: (key, variant) => {
            const hostname = `${variant ? "b" : "a"}-${label}.example.com`;
            return via === "API"
              ? owner.call("POST", `/api/v1/artifacts/${artifactId}/domain`, { hostname }, key)
              : owner.tool("add_custom_domain", { artifactId, hostname, idempotencyKey: key });
          },
          effect: () =>
            count(
              env.DB,
              "select count(*) as n from domain_claims where artifact_id = ?",
              artifactId,
            ),
        };
      },
    },
  ]),
  {
    name: "MCP publish_document",
    home: "eu",
    arrange: async () => ({
      run: (key, variant) =>
        owner.tool("publish_document", {
          workspace: slug,
          type: "markdown",
          name: variant ? "Keyed B" : "Keyed A",
          content: "# Keyed",
          idempotencyKey: key,
        }),
      effect: () =>
        count(eu(), "select count(*) as n from artifacts where owner_id = ?", workspaceId),
    }),
  },
];

describe("keyed operations of an EU workspace", () => {
  it.each(CASES)(
    "$name keeps its record at home, replays it once and refuses another body",
    async (c) => {
      const { run, effect, actor = owner } = await c.arrange();
      const key = crypto.randomUUID();
      const before = await effect();
      const first = await run(key, 0);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const after = await effect();
      expect(after).toBe(before + 1);

      const record = await recordOf(actor.userId, key);
      expect(record).toEqual(c.home === "eu" ? { eu: 1, default: 0 } : { eu: 0, default: 1 });

      // The same key and body: the stored answer, and nothing applied twice.
      const again = await run(key, 0);
      expect(again).toEqual(first);
      expect(await effect()).toBe(after);

      // The same key with another body is refused before anything runs.
      const other = await run(key, 1);
      expect(other.ok).toBe(false);
      expect(other.code).toBe("invalid_input");
      expect(await effect()).toBe(after);
    },
  );
});

describe("a stored answer after the role is gone", () => {
  // The owner scope is resolved before the record is read, in the API and in MCP alike: someone
  // removed from the workspace between two attempts gets what anyone without a role gets, never
  // the stored response, which may hold content they can no longer see.
  it.each(["API", "MCP"] as const)("is not replayed through %s", async (via) => {
    const member = await client(`idem-left-${crypto.randomUUID()}@example.test`);
    await regionsFromEnv(env)
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId, userId: member.userId, role: "editor", updatedAt: Date.now() });
    const key = crypto.randomUUID();
    const files = [
      { path: "index.html", sha256: "c".repeat(64), size: 3, contentType: "text/html" },
    ];
    const send = () =>
      via === "API"
        ? member.call(
            "POST",
            `/api/v1/publishes?workspace=${slug}`,
            { type: "site", name: "Left", entrypoint: "index.html", files },
            key,
          )
        : member.tool("publish_document", {
            workspace: slug,
            type: "markdown",
            name: "Left",
            content: "# Left",
            idempotencyKey: key,
          });
    const first = await send();
    expect(first.ok, JSON.stringify(first.body)).toBe(true);
    await regionsFromEnv(env)
      .global.delete(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, member.userId),
        ),
      );
    const replay = await send();
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe("not_found");
    expect(JSON.stringify(replay.body)).not.toContain("Left");
  });
});

/**
 * D1 calls of the keyed adapters with one database (a personal space, whose region's database is
 * the global one), through a recording binding: the numbers develop made, measured by running this
 * test with develop's `apps/app/src/api/{http,annotations,approval-reviews,domains,routes}.ts` and
 * `apps/app/src/mcp/{tools,annotation-tools,review-tools,upload-tools,version-tools}.ts` on
 * 2026-11-11 (the same numbers). With a second region bound, a replay on an artifact reads the
 * directory once more than develop did (the record now lives in the artifact's region). A thread
 * replay then reads the thread again as the caller (its authorization and the thread, four calls),
 * because the record keeps only the thread's ID (`idempotentThreadWrite`): the write path is
 * unchanged.
 */
const DEVELOP_CALLS = {
  apiThreadCreate: 17,
  apiThreadReplay: 12,
  mcpPublishDocument: 30,
  mcpPublishReplay: 9,
  apiPrepare: 20,
  apiPrepareReplay: 8,
};

let calls = 0;

/** `binding`, with every D1 call (a statement or a batch) counted. */
function counting(binding: D1Database): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        const real = Reflect.get(target, property, target);
        if (typeof real !== "function") return real;
        if (property === "bind") return (...args: unknown[]) => wrap(real.apply(target, args));
        if (["all", "raw", "run", "first"].includes(String(property))) {
          return (...args: unknown[]) => {
            calls += 1;
            return real.apply(target, args);
          };
        }
        return real.bind(target);
      },
    });
  const originals = new WeakMap<object, D1PreparedStatement>();
  const proxy = new Proxy(binding, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          const wrapped = wrap(statement);
          originals.set(wrapped, statement);
          return wrapped;
        };
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          calls += 1;
          return target.batch(statements.map((s) => originals.get(s) ?? s));
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return aliasBinding(proxy, binding);
}

describe("D1 calls of keyed adapters with one database", () => {
  it("are what develop makes", async () => {
    const personal = await client(`idem-costs-${crypto.randomUUID()}@example.test`, {
      // Production's shape: one region bound, so the default region's database is the global one.
      // Unbinding the EU region: the harness spreads these over the test environment.
      env: {
        DB: counting(env.DB),
        DB_EU: undefined,
        ACCESS_DB_EU: undefined,
        ARTIFACTS_EU: undefined,
        R2_BUCKET_EU: undefined,
      } as unknown as Partial<Cloudflare.Env>,
    });
    const measure = async (run: () => Promise<Answer>) => {
      calls = 0;
      const answer = await run();
      expect(answer.ok, JSON.stringify(answer.body)).toBe(true);
      return calls;
    };
    const published = await personal.tool("publish_document", {
      type: "markdown",
      name: "Costs",
      content: "# Costs",
    });
    const { artifactId, versionId } = published.body as { artifactId: string; versionId: string };
    await env.DB.prepare("update artifacts set annotations = 'open' where id = ?")
      .bind(artifactId)
      .run();
    const threadKey = crypto.randomUUID();
    const thread = () =>
      personal.call(
        "POST",
        `/api/v1/artifacts/${artifactId}/annotations/threads`,
        { versionId, target: DOC, body: "Costs" },
        threadKey,
      );
    const publishKey = crypto.randomUUID();
    const publish = () =>
      personal.tool("publish_document", {
        type: "markdown",
        name: "Costs keyed",
        content: "# Keyed",
        idempotencyKey: publishKey,
      });
    const prepareKey = crypto.randomUUID();
    const prepare = () =>
      personal.call(
        "POST",
        "/api/v1/publishes",
        {
          type: "site",
          name: "Costs upload",
          entrypoint: "index.html",
          files: [
            { path: "index.html", sha256: "d".repeat(64), size: 3, contentType: "text/html" },
          ],
        },
        prepareKey,
      );
    const costs = {
      apiThreadCreate: await measure(thread),
      apiThreadReplay: await measure(thread),
      mcpPublishDocument: await measure(publish),
      mcpPublishReplay: await measure(publish),
      apiPrepare: await measure(prepare),
      apiPrepareReplay: await measure(prepare),
    };
    expect(costs).toEqual(DEVELOP_CALLS);
  });
});
