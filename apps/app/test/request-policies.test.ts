// A workspace's network allowlists (decision 0020) through every interface of the app Worker:
// the API with a bearer token, MCP, the dashboard's session and the entry to protected artifacts.
// The address comes only from CF-Connecting-IP; the same caller gets the same refusal everywhere.
import { env } from "cloudflare:workers";
import { DEFAULT_POLICY, type WorkspacePolicy } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { POLICY_MESSAGES } from "@portifact/domain";
import { createWorkspace } from "@portifact/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-10T09:00:00Z");
const DAY = 86_400_000;
const SCOPES =
  "artifacts:read artifacts:write artifacts:share artifacts:delete annotations:read offline_access";
const OFFICE = "192.0.2.10";
const HOME = "198.51.100.20";
const OFFICE_ONLY: WorkspacePolicy = { ...DEFAULT_POLICY, ipAllowlist: ["192.0.2.0/24"] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const regions = () => regionsFromEnv(env);

/** A harness whose every request comes from `at.ip`, as Cloudflare would say in CF-Connecting-IP. */
function from(h: Harness, at: { ip: string }): Harness {
  return {
    ...h,
    request: (path: string, init?: RequestInit) => {
      const request = new Request(path.startsWith("https://") ? path : `${ORIGIN}${path}`, init);
      request.headers.set("cf-connecting-ip", at.ip);
      return h.request(request.url, request);
    },
  };
}

async function person(prefix: string, role: string) {
  const h = createHarness();
  const at = { ip: OFFICE };
  const located = from(h, at);
  const email = `${prefix}-${role}@example.test`;
  const token = await apiToken(h, email, SCOPES);
  const mcp = await connect(located, await mcpToken(h, email, SCOPES));
  const cookie = await h.signIn(email);
  const call = (path: string, init?: RequestInit) => api(located, token, path, init);
  const { userId } = await (await call("/api/v1/me")).json<{ userId: string }>();
  return {
    userId,
    at,
    h: located,
    cookie,
    call,
    tool: (name: string, args: Record<string, unknown>) => callTool(mcp, name, args),
  };
}
type Person = Awaited<ReturnType<typeof person>>;

/** What the dashboard's fetch sends. */
const dashboard = (cookie: string, method = "GET", body?: unknown): RequestInit => ({
  method,
  headers: {
    cookie,
    "sec-fetch-site": "same-origin",
    origin: ORIGIN,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function team(prefix: string) {
  // `member` is an editor: listing artifacts is an editor's action.
  const [admin, member] = [await person(prefix, "admin"), await person(prefix, "editor")];
  const slug = `${prefix}-team`;
  const created = await createWorkspace(regions().global, {
    slug,
    name: "Team",
    adminUserId: admin.userId,
    now: NOW,
  });
  if (!created.ok) throw new Error(created.message);
  await regions().global.insert(schema.workspaceMembers).values({
    workspaceId: created.value.id,
    userId: member.userId,
    role: "editor",
    updatedAt: NOW,
  });
  await regions().global.insert(schema.ownerPlans).values({
    ownerId: created.value.id,
    plan: "enterprise",
    seats: 10,
    grantedBy: "test",
    updatedAt: NOW,
  });
  return { id: created.value.id, slug, admin, member };
}

async function setPolicy(admin: Person, slug: string, next: WorkspacePolicy) {
  const base = `/api/v1/workspaces/${slug}/policies`;
  const current = await (await admin.h.request(base, dashboard(admin.cookie))).json<{
    revision: number;
  }>();
  return admin.h.request(
    base,
    dashboard(admin.cookie, "PUT", { policy: next, revision: current.revision }),
  );
}

const refusal = (ip: string) => ({
  error: { code: "policy_refused", message: POLICY_MESSAGES.networkPerson(ip) },
});

describe("a network allowlist through the app Worker", () => {
  it("answers the API and MCP alike, from the address Cloudflare reports", async () => {
    const t = await team("rpa");
    const saved = await setPolicy(t.admin, t.slug, OFFICE_ONLY);
    expect(await saved.json()).toMatchObject({ editable: true });

    const path = `/api/v1/artifacts?workspace=${t.slug}`;
    expect((await t.member.call(path)).status).toBe(200);
    t.member.at.ip = HOME;
    const refused = await t.member.call(path);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(refusal(HOME));
    const viaMcp = await t.member.tool("list_artifacts", { workspace: t.slug });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.structuredContent).toEqual(refusal(HOME));
    // A header the client sets cannot stand in for the address: only CF-Connecting-IP counts.
    const spoofed = await t.member.call(path, { headers: { "x-forwarded-for": OFFICE } });
    expect(spoofed.status).toBe(403);
  });

  it("keeps the workspace in the list, marked blocked, and shows the networks to admins only", async () => {
    const t = await team("rpl");
    await setPolicy(t.admin, t.slug, OFFICE_ONLY);
    t.member.at.ip = HOME;
    const listed = await (await t.member.call("/api/v1/workspaces")).json<{
      items: { slug: string; blocked: boolean; policy: { ipAllowlist: unknown } }[];
    }>();
    expect(listed.items).toEqual([
      expect.objectContaining({
        slug: t.slug,
        blocked: true,
        policy: expect.objectContaining({ ipAllowlist: "hidden" }),
      }),
    ]);
    const viaMcp = await t.member.tool("list_workspaces", {});
    expect(viaMcp.structuredContent).toEqual(listed);
    const admin = await (await t.admin.call("/api/v1/workspaces")).json<{
      items: { blocked: boolean; policy: { ipAllowlist: unknown } }[];
    }>();
    expect(admin.items[0]).toMatchObject({
      blocked: false,
      policy: { ipAllowlist: ["192.0.2.0/24"] },
    });
  });

  it("refuses the dashboard's session too, and a save that would lock the admin out", async () => {
    const t = await team("rpd");
    t.admin.at.ip = HOME;
    const lockOut = await setPolicy(t.admin, t.slug, OFFICE_ONLY);
    expect(lockOut.status).toBe(400);
    expect(await lockOut.json()).toEqual({
      error: { code: "invalid_input", message: POLICY_MESSAGES.networkLocksOut(HOME) },
    });
    t.admin.at.ip = OFFICE;
    expect((await setPolicy(t.admin, t.slug, OFFICE_ONLY)).status).toBe(200);
    const shown = await (
      await t.admin.h.request(`/api/v1/workspaces/${t.slug}/policies`, dashboard(t.admin.cookie))
    ).json<{ yourIp: string | null }>();
    expect(shown.yourIp).toBe(OFFICE);
    t.member.at.ip = HOME;
    const members = await t.member.h.request(
      `/api/v1/workspaces/${t.slug}/members`,
      dashboard(t.member.cookie),
    );
    expect(members.status).toBe(403);
    expect(await members.json()).toEqual(refusal(HOME));
  });

  it("sends a refused reader to a page that names neither the workspace nor the artifact", async () => {
    const t = await team("rpr");
    const id = "rp7d2qm4xa";
    await regions()
      .get("default")
      .db.insert(schema.artifacts)
      .values({
        id,
        ownerId: t.id,
        type: "site",
        name: "Secret plan",
        state: "active",
        accessMode: "workspace",
        currentVersionId: "v1",
        expiresAt: NOW + 10 * DAY,
      });
    await setPolicy(t.admin, t.slug, OFFICE_ONLY);
    t.member.at.ip = HOME;
    const entry = await t.member.h.request(`/read/${id}?state=${"s".repeat(43)}`, {
      headers: { cookie: t.member.cookie },
      redirect: "manual",
    });
    expect(entry.status).toBe(303);
    expect(entry.headers.get("location")).toBe("/login?error=network_refused");
  });
});
