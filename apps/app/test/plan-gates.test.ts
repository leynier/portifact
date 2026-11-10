// Paid features refused on `free` through /api/v1 and MCP (premium plan section 10: "every paid
// feature has a test that refuses it on free, with the same error in web, CLI and MCP"). The web
// dashboard calls the same /api/v1 routes, so the API answer is the web's; the CLI side is
// packages/cli/src/plan-gates.test.ts.
//
// A feature PR adds one line to GATED per operation it gates:
//
//   route("pin", "pin an artifact", (id) => [`/api/v1/artifacts/${id}/pin`, post()], "pin_artifact", (id) => ({ artifactId: id })),
//
// and every line gets the same checks: a free owner is refused with `plan_required` and the
// message from `planRequiredMessage`, the same body from the tool; the lowest plan with the
// feature is not refused; and the plan that counts is the artifact owner's, never the caller's
// (a workspace on a plan with the feature, acted on by an editor whose own space is free, is not
// refused; a free workspace acted on by an editor with a paid plan is).
//
// Service tokens (decision 0011) have one line: using a token of a workspace without the feature;
// creating one is session-only and tested with the same body in service-tokens.test.ts.
//
// Single sign-on (decision 0016) is a line with the dashboard session only (no MCP tool).
//
// Other owner-level gates served only to the dashboard session, with no MCP tool or CLI command, are
// not lines here: the brand (`branding`) is gated and tested in branding.test.ts with the same
// body, and its owner-plan and role rules in packages/services/test/branding.test.ts.
import { env } from "cloudflare:workers";
import {
  lowestPlanWith,
  type PlanFeature,
  type PlanName,
  planRequiredMessage,
} from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  authorizeOn,
  commitPublish,
  newServiceTokenSecret,
  preparePublish,
  requireOwnerFeature,
} from "@portifact/services";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failure as apiFailure } from "../src/api/http.ts";
import { failure as toolFailure } from "../src/mcp/tools.ts";
import { createHarness, ORIGIN } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken, type ToolResult } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-02T09:00:00Z");
const SCOPES =
  "artifacts:read artifacts:write artifacts:share artifacts:delete annotations:read annotations:write annotations:moderate offline_access";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface Client {
  userId: string;
  apiCall: (path: string, init?: RequestInit) => Promise<Response>;
  /** The API with the Portifact CLI's `credentials:manage` token, which manages webhooks. */
  manageCall: (path: string, init?: RequestInit) => Promise<Response>;
  /** The API with the dashboard's session, for owner settings no token reaches. */
  sessionCall: (path: string, init?: RequestInit) => Promise<Response>;
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

/** One operation's answer through the API (status and body) and through MCP (error flag and body). */
interface Answers {
  api: { status: number; body: unknown };
  /** Absent for operations no MCP tool offers (managing webhooks, decision 0003's addendum). */
  mcp?: { ok: boolean; body: unknown };
}

interface GatedOperation {
  feature: PlanFeature;
  name: string;
  /**
   * `owner` for operations on the caller's own space (webhooks), which the interfaces cannot aim
   * at a workspace yet: the plan that counts is the caller's personal space's.
   */
  scope?: "artifact" | "owner";
  /**
   * `workspace` for operations that exist only on a workspace's artifacts (the `workspace` and
   * `domain` access modes, decision 0010): the free case runs on a free workspace's artifact the
   * caller is an admin of, since a personal artifact is refused before the plan is read.
   */
  space?: "workspace";
  /** Runs the operation as `who` on artifact `id` through both interfaces. */
  run: (who: Client, id: string) => Promise<Answers>;
}

/** A gated operation served by an /api/v1 route and an MCP tool: the usual line in GATED. */
export function route(
  feature: PlanFeature,
  name: string,
  request: (id: string) => [string, RequestInit?],
  tool: string,
  args: (id: string) => Record<string, unknown>,
): GatedOperation {
  return {
    feature,
    name,
    run: async (who, id) => {
      const [path, init] = request(id);
      const response = await who.apiCall(path, init);
      const result = await who.tool(tool, args(id));
      return {
        api: { status: response.status, body: await response.json<unknown>() },
        mcp: { ok: result.isError !== true, body: result.structuredContent },
      };
    },
  };
}

const db = () => regionsFromEnv(env).get("default").db;

/**
 * A test-only operation that stands in until a real one is gated: it does what a gated service
 * and its adapters do (authorize the caller on the artifact's owner, then `requireOwnerFeature`
 * for that owner) and answers through the API's and the MCP server's own error builders.
 */
function probe(feature: PlanFeature): GatedOperation {
  return {
    feature,
    name: "test-only probe",
    run: async (who, id) => {
      const [artifact] = await db()
        .select({ ownerId: schema.artifacts.ownerId })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, id));
      if (!artifact) throw new Error("The probe needs an artifact");
      const actor = await authorizeOn(db(), who.userId, artifact.ownerId, "manage", () => {
        throw new Error("The probe's caller must manage the artifact");
      });
      if (!actor.ok) throw new Error(actor.message);
      const gate = await requireOwnerFeature(db(), artifact, feature, NOW);
      if (gate.ok) {
        return {
          api: { status: 200, body: { done: true } },
          mcp: { ok: true, body: { done: true } },
        };
      }
      const refused = apiFailure(gate.code, gate.message);
      const tool = toolFailure(gate.code, gate.message);
      return {
        api: { status: refused.status, body: refused.body },
        mcp: { ok: tool.isError !== true, body: tool.structuredContent },
      };
    },
  };
}

/** Every operation that reaches a paid feature: one line each (see the top of this file). */
const GATED: GatedOperation[] = [
  route(
    "pin",
    "pin an artifact",
    (id) => [`/api/v1/artifacts/${id}/pin`, { method: "POST" }],
    "pin_artifact",
    (id) => ({ artifactId: id }),
  ),
  route(
    "shareLinks",
    "create a share link",
    (id) => [
      `/api/v1/artifacts/${id}/share-links`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Gate" }),
      },
    ],
    "create_share_link",
    (id) => ({ artifactId: id, label: "Gate" }),
  ),
  route(
    "analytics",
    "read an artifact's analytics",
    (id) => [`/api/v1/artifacts/${id}/stats`],
    "get_artifact_stats",
    (id) => ({ artifactId: id }),
  ),
  route(
    "versionDiff",
    "compare two versions",
    (id) => [`/api/v1/artifacts/${id}/versions/current/diff/current`],
    "diff_versions",
    (id) => ({ artifactId: id, fromVersionId: "current" }),
  ),
  route(
    "versionDiff",
    "diff a file between two versions",
    (id) => [`/api/v1/artifacts/${id}/versions/current/diff/current/file?path=index.md`],
    "diff_version_file",
    (id) => ({ artifactId: id, fromVersionId: "current", path: "index.md" }),
  ),
  {
    feature: "webhooks",
    name: "create a webhook",
    scope: "owner",
    run: async (who) => {
      const response = await who.manageCall("/api/v1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(WEBHOOK),
      });
      return { api: { status: response.status, body: await response.json<unknown>() } };
    },
  },
  {
    feature: "webhooks",
    name: "enable a webhook",
    scope: "owner",
    run: (who) => onWebhook(who, "enable"),
  },
  {
    feature: "webhooks",
    name: "send a test event",
    scope: "owner",
    run: (who) => onWebhook(who, "test"),
  },
  route(
    "customDomains",
    "add a custom domain",
    (id) => [
      `/api/v1/artifacts/${id}/domain`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ hostname: `gate-${id}.example.com` }),
      },
    ],
    "add_custom_domain",
    (id) => ({ artifactId: id, hostname: `gate-${id}.example.com` }),
  ),
  {
    feature: "audit",
    name: "read the audit log",
    scope: "owner",
    run: async (who) => {
      const response = await who.apiCall("/api/v1/audit");
      const result = await who.tool("get_audit_log", {});
      return {
        api: { status: response.status, body: await response.json<unknown>() },
        mcp: { ok: result.isError !== true, body: result.structuredContent },
      };
    },
  },
  {
    feature: "auditExport",
    name: "export the audit log",
    scope: "owner",
    // No MCP tool returns an export: it is too large for a tool result.
    run: async (who) => {
      const response = await who.apiCall("/api/v1/audit/export?format=csv");
      const body = response.ok ? await response.text() : await response.json<unknown>();
      return { api: { status: response.status, body } };
    },
  },
  {
    feature: "contentSearch",
    name: "search inside the space's artifacts",
    scope: "owner",
    run: async (who) => {
      const response = await who.apiCall("/api/v1/search?q=gate");
      const result = await who.tool("search_content", { query: "gate" });
      return {
        api: { status: response.status, body: await response.json<unknown>() },
        mcp: { ok: result.isError !== true, body: result.structuredContent },
      };
    },
  },
  {
    feature: "serviceTokens",
    name: "use a service token",
    scope: "owner",
    run: (who) => withServiceToken(who),
  },
  route(
    "reviews",
    "request an approval review",
    (id) => [
      `/api/v1/artifacts/${id}/review/request`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ reviewers: ["gate@example.com"] }),
      },
    ],
    "request_review",
    (id) => ({ artifactId: id, reviewers: ["gate@example.com"] }),
  ),
  route(
    "reviews",
    "change an approval review",
    (id) => [
      `/api/v1/artifacts/${id}/review/request`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ showStatus: true }),
      },
    ],
    "request_review",
    (id) => ({ artifactId: id, action: "change", showStatus: true }),
  ),
  probe("workspaces"),
  ...(["workspace", "domain"] as const).map(
    (mode): GatedOperation => ({
      feature: "workspaces",
      name: `share with the ${mode} mode`,
      space: "workspace",
      // Repeating the mode an artifact already has is never gated, so each interface starts from
      // restricted.
      run: async (who, id) => {
        const restricted = () =>
          db()
            .update(schema.artifacts)
            .set({ accessMode: "restricted" })
            .where(eq(schema.artifacts.id, id));
        await restricted();
        const response = await who.apiCall(`/api/v1/artifacts/${id}/access`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        const body = await response.json<unknown>();
        await restricted();
        const result = await who.tool("set_access", { artifactId: id, mode });
        return {
          api: { status: response.status, body },
          mcp: { ok: result.isError !== true, body: result.structuredContent },
        };
      },
    }),
  ),
  {
    feature: "workspaces",
    name: "add a group to an artifact",
    space: "workspace",
    // A group of the artifact's own workspace (groups are made through the dashboard session, so
    // the row is written as that route writes it); each interface starts with none listed.
    run: async (who, id) => {
      const [row] = await db()
        .select({ ownerId: schema.artifacts.ownerId })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, id));
      if (!row) throw new Error("The group line needs an artifact");
      const groupId = `wg_${crypto.randomUUID().replaceAll("-", "")}`;
      await db().insert(schema.workspaceGroups).values({
        id: groupId,
        workspaceId: row.ownerId,
        name: groupId,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const clear = () =>
        db().delete(schema.artifactGroups).where(eq(schema.artifactGroups.artifactId, id));
      const response = await who.apiCall(`/api/v1/artifacts/${id}/access`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addGroups: [groupId] }),
      });
      const body = await response.json<unknown>();
      await clear();
      const result = await who.tool("add_group", { artifactId: id, groups: [groupId] });
      await clear();
      return {
        api: { status: response.status, body },
        mcp: { ok: result.isError !== true, body: result.structuredContent },
      };
    },
  },
  {
    feature: "workspaces",
    name: "list a workspace's open feedback",
    space: "workspace",
    // The space is the artifact's workspace, named by slug; a personal space needs no feature.
    run: async (who, id) => {
      const [row] = await db()
        .select({ slug: schema.workspaces.slug })
        .from(schema.artifacts)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.artifacts.ownerId))
        .where(eq(schema.artifacts.id, id));
      if (!row) throw new Error("The feedback line needs a workspace's artifact");
      const response = await who.apiCall(`/api/v1/feedback?workspace=${row.slug}`);
      const result = await who.tool("list_open_feedback", { workspace: row.slug });
      return {
        api: { status: response.status, body: await response.json<unknown>() },
        mcp: { ok: result.isError !== true, body: result.structuredContent },
      };
    },
  },
  // Single sign-on (decision 0016) is set up only through the dashboard session, on a
  // workspace; the editor case does not apply (only admins reach the plan check).
  {
    feature: "sso",
    name: "set up single sign-on",
    scope: "owner",
    space: "workspace",
    run: async (who, id) => {
      const [row] = await db()
        .select({ slug: schema.workspaces.slug })
        .from(schema.artifacts)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.artifacts.ownerId))
        .where(eq(schema.artifacts.id, id));
      if (!row) throw new Error("The SSO line needs a workspace's artifact");
      const response = await who.sessionCall(`/api/v1/workspaces/${row.slug}/sso`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issuer: "https://login.gate.example.com",
          clientId: "gate",
          clientSecret: "gate-secret",
          domains: ["gate.example.com"],
        }),
      });
      return { api: { status: response.status, body: await response.json<unknown>() } };
    },
  },
  // A SCIM token (decision 0017) is created only through the dashboard session, on a workspace;
  // using one on a lapsed plan is refused by the SCIM endpoints (scim.test.ts).
  {
    feature: "scim",
    name: "create a SCIM token",
    scope: "owner",
    space: "workspace",
    run: async (who, id) => {
      const [row] = await db()
        .select({ slug: schema.workspaces.slug })
        .from(schema.artifacts)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.artifacts.ownerId))
        .where(eq(schema.artifacts.id, id));
      if (!row) throw new Error("The SCIM line needs a workspace's artifact");
      const response = await who.sessionCall(`/api/v1/workspaces/${row.slug}/scim/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Gate", expiresInDays: 30 }),
      });
      return { api: { status: response.status, body: await response.json<unknown>() } };
    },
  },
  // Setting or tightening workspace policies (decision 0015) is session-only, with no bearer
  // route, MCP tool or CLI command: the gate is `requireFeature` on the workspace's plan, and its
  // body is checked through the session in workspace-policies.test.ts.
  probe("policies"),
];

/**
 * Calls the API with a service token of a workspace the caller administers, whose plan is set to
 * the caller's personal plan so the table's plans apply to it (decision 0011). Creating tokens is
 * session-only, so the token row is written as the create route writes it. No MCP: it refuses
 * service tokens.
 */
async function withServiceToken(who: Client): Promise<Answers> {
  const [plan] = await db()
    .select()
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, who.userId));
  const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .insert(schema.workspaces)
    .values({
      id: workspaceId,
      slug: workspaceId.slice(3, 23),
      name: "Team",
      createdBy: who.userId,
      updatedAt: NOW,
    });
  await db()
    .insert(schema.workspaceMembers)
    .values({ workspaceId, userId: who.userId, role: "admin", updatedAt: NOW });
  await onPlan(workspaceId, plan?.plan ?? "free");
  const secret = newServiceTokenSecret();
  await db()
    .insert(schema.serviceTokens)
    .values({
      id: `st_${crypto.randomUUID().replaceAll("-", "")}`,
      workspaceId,
      label: "Gate",
      role: "editor",
      scopes: "artifacts:read",
      tokenHash: await sha256(secret),
      createdBy: who.userId,
      createdAt: NOW,
      expiresAt: NOW + 86_400_000,
    });
  const response = await who.apiCall("/api/v1/artifacts", {
    headers: { authorization: `Bearer ${secret}` },
  });
  return { api: { status: response.status, body: await response.json<unknown>() } };
}

const WEBHOOK = {
  url: "https://hooks.example.com/in",
  format: "generic",
  events: ["artifact.published"],
};

/**
 * Enables or tests a webhook the caller made while on a plan with the feature, after setting the
 * plan the test chose: the row is written as a grant would, the webhook is disabled for `enable`.
 */
async function onWebhook(who: Client, operation: "enable" | "test"): Promise<Answers> {
  const [plan] = await db()
    .select()
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, who.userId));
  await onPlan(who.userId, "pro");
  const created = await who.manageCall("/api/v1/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(WEBHOOK),
  });
  const { webhook } = await created.json<{ webhook: { id: string } }>();
  if (operation === "enable") {
    await db()
      .update(schema.webhooks)
      .set({ disabledAt: NOW, disabledReason: "manual" })
      .where(eq(schema.webhooks.id, webhook.id));
  }
  await onPlan(who.userId, plan?.plan ?? "free");
  const [path, method, body] =
    operation === "enable"
      ? [`/api/v1/webhooks/${webhook.id}`, "PATCH", { enabled: true }]
      : [`/api/v1/webhooks/${webhook.id}/test`, "POST", undefined];
  const response = await who.manageCall(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { api: { status: response.status, body: await response.json<unknown>() } };
}

async function client(email: string): Promise<Client> {
  const h = createHarness();
  const apiAccess = await apiToken(h, email, SCOPES);
  const mcp = await connect(h, await mcpToken(h, email, SCOPES));
  const apiCall = (path: string, init?: RequestInit) => api(h, apiAccess, path, init);
  const manage = await apiToken(h, email, "artifacts:read credentials:manage");
  const manageCall = (path: string, init?: RequestInit) => api(h, manage, path, init);
  const { userId } = await (await apiCall("/api/v1/me")).json<{ userId: string }>();
  let cookie: string | null = null;
  const sessionCall = async (path: string, init: RequestInit = {}) => {
    cookie ??= await h.signIn(email);
    return h.request(path, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        cookie,
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
      },
    });
  };
  return {
    userId,
    apiCall,
    manageCall,
    sessionCall,
    tool: (name, args) => callTool(mcp, name, args),
  };
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Publishes a Markdown document in `ownerId` as `userId`, through the services. */
async function publishIn(ownerId: string, userId: string): Promise<string> {
  const content = `# ${crypto.randomUUID()}`;
  const sha = await sha256(content);
  const prepared = await preparePublish(db(), {
    userId,
    targetOwnerId: ownerId,
    type: "markdown",
    name: "Gated doc",
    entrypoint: "index.md",
    baseVersionId: null,
    files: [
      {
        path: "index.md",
        kind: "published",
        sha256: sha,
        size: content.length,
        contentType: "text/markdown; charset=utf-8",
      },
    ],
    now: NOW,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  await env.ARTIFACTS.put(`objects/${ownerId}/${sha}`, content, { sha256: sha });
  const committed = await commitPublish(db(), env.ARTIFACTS, {
    userId,
    sessionId: prepared.value.sessionId,
    now: NOW,
  });
  if (!committed.ok) throw new Error(committed.message);
  return committed.value.artifactId;
}

/** Puts an owner (a user or a workspace) on a plan, as the operator's grant writes the row. */
async function onPlan(ownerId: string, plan: PlanName) {
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId, plan, seats: 1, grantedBy: "test", updatedAt: NOW })
    .onConflictDoUpdate({ target: schema.ownerPlans.ownerId, set: { plan } });
}

/** One address per line of GATED: a feature may gate several operations. */
const slug = (op: GatedOperation) =>
  `${op.feature}-${op.name}`.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");

function expectRefused(answers: Answers, feature: PlanFeature, label: string) {
  const body = { error: { code: "plan_required", message: planRequiredMessage(feature) } };
  expect(answers.api, label).toEqual({ status: 403, body });
  if (answers.mcp) expect(answers.mcp, label).toEqual({ ok: false, body });
}

function expectNotRefused(answers: Answers, label: string) {
  for (const body of [answers.api.body, ...(answers.mcp ? [answers.mcp.body] : [])]) {
    expect((body as { error?: { code?: string } }).error?.code, label).not.toBe("plan_required");
  }
}

/** A workspace with `userId` in `role`, on the free plan (no row). */
async function workspaceWith(userId: string, role: "admin" | "editor"): Promise<string> {
  const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .insert(schema.workspaces)
    .values({
      id: workspaceId,
      slug: workspaceId.slice(3, 23),
      name: "Team",
      createdBy: userId,
      updatedAt: NOW,
    });
  await db().insert(schema.workspaceMembers).values({ workspaceId, userId, role, updatedAt: NOW });
  return workspaceId;
}

describe.each(GATED)("$feature: $name", (op) => {
  it("is refused on free with plan_required, the same in the API and MCP", async () => {
    const owner = await client(`gate-free-${slug(op)}@example.test`);
    const space = op.space === "workspace" ? await workspaceWith(owner.userId, "admin") : null;
    const ownerId = space ?? owner.userId;
    const id = await publishIn(ownerId, owner.userId);
    expectRefused(await op.run(owner, id), op.feature, "free");

    await onPlan(ownerId, lowestPlanWith(op.feature));
    expectNotRefused(await op.run(owner, id), lowestPlanWith(op.feature));
  });
});

// Operations on the caller's own space have no artifact owner to follow.
const ON_ARTIFACTS = GATED.filter((op) => op.scope !== "owner");

describe.each(ON_ARTIFACTS)("$feature: $name, on a workspace's artifact", (op) => {
  it("follows the artifact owner's plan, not the caller's", async () => {
    const editor = await client(`gate-editor-${slug(op)}@example.test`);
    const workspaceId = await workspaceWith(editor.userId, "editor");
    const id = await publishIn(workspaceId, editor.userId);

    // A Team workspace (Enterprise for the features only it has); the editor's own space is free.
    const workspacePlan = lowestPlanWith(op.feature) === "enterprise" ? "enterprise" : "team";
    await onPlan(workspaceId, workspacePlan);
    expectNotRefused(await op.run(editor, id), `editor on a ${workspacePlan} workspace`);

    // The editor's paid plan does not reach a free workspace's artifact.
    await onPlan(editor.userId, "enterprise");
    await onPlan(workspaceId, "free");
    expectRefused(await op.run(editor, id), op.feature, "editor with a paid plan, free workspace");
  });
});
