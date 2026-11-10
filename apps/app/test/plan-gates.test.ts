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
// Owner-level gates served only to the dashboard session, with no MCP tool or CLI command, are
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
  preparePublish,
  requireOwnerFeature,
} from "@portifact/services";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failure as apiFailure } from "../src/api/http.ts";
import { failure as toolFailure } from "../src/mcp/tools.ts";
import { createHarness } from "./harness.ts";
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
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

/** One operation's answer through the API (status and body) and through MCP (error flag and body). */
interface Answers {
  api: { status: number; body: unknown };
  mcp: { ok: boolean; body: unknown };
}

interface GatedOperation {
  feature: PlanFeature;
  name: string;
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
  probe("workspaces"),
  probe("sso"),
];

async function client(email: string): Promise<Client> {
  const h = createHarness();
  const apiAccess = await apiToken(h, email, SCOPES);
  const mcp = await connect(h, await mcpToken(h, email, SCOPES));
  const apiCall = (path: string, init?: RequestInit) => api(h, apiAccess, path, init);
  const { userId } = await (await apiCall("/api/v1/me")).json<{ userId: string }>();
  return { userId, apiCall, tool: (name, args) => callTool(mcp, name, args) };
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
  expect(answers.mcp, label).toEqual({ ok: false, body });
}

function expectNotRefused(answers: Answers, label: string) {
  for (const body of [answers.api.body, answers.mcp.body]) {
    expect((body as { error?: { code?: string } }).error?.code, label).not.toBe("plan_required");
  }
}

describe.each(GATED)("$feature: $name", (op) => {
  it("is refused on free with plan_required, the same in the API and MCP", async () => {
    const owner = await client(`gate-free-${slug(op)}@example.test`);
    const id = await publishIn(owner.userId, owner.userId);
    expectRefused(await op.run(owner, id), op.feature, "free");

    await onPlan(owner.userId, lowestPlanWith(op.feature));
    expectNotRefused(await op.run(owner, id), lowestPlanWith(op.feature));
  });

  it("follows the artifact owner's plan, not the caller's", async () => {
    const editor = await client(`gate-editor-${slug(op)}@example.test`);
    const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    await db()
      .insert(schema.workspaces)
      .values({
        id: workspaceId,
        slug: workspaceId.slice(3, 23),
        name: "Team",
        createdBy: editor.userId,
        updatedAt: NOW,
      });
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId, userId: editor.userId, role: "editor", updatedAt: NOW });
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
