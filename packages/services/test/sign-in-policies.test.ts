// A workspace's sign-in policies (decision 0021): the maximum session age and the allowed
// clients, applied where the role is decided (`actorOn`) from the credential the Worker recorded
// on the request context. Every role, a service token, a non-member, the personal space, every
// credential kind and age, read and review renewals, lock-out safety, the plan, the escape
// hatch, restores, races, two regions and what they cost in D1 calls.
import { env } from "cloudflare:test";
import {
  BACKGROUND,
  CLI_CLIENT_ID,
  type Credential,
  DEFAULT_POLICY,
  type RequestContext,
  type WorkspacePolicy,
} from "@portifact/contracts";
import {
  type RegionalDb,
  type Regions,
  regionsFromEnv,
  schema,
  withRequestContext,
} from "@portifact/db";
import { POLICY_MESSAGES, policyOf } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateAccess } from "../src/access.ts";
import { resolveActor } from "../src/actors.ts";
import { declineInvitation, inviteMember } from "../src/invitations.ts";
import { renewArtifact } from "../src/lifecycle.ts";
import {
  checkReadAccess,
  issueReadHandoff,
  redeemReadHandoff,
  refreshReadSession,
} from "../src/read-access.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import {
  applyWorkspacePolicies,
  clearRequestPolicies,
  getWorkspacePolicy,
  previewWorkspacePolicy,
  setWorkspacePolicy,
} from "../src/workspace-policies.ts";
import { createWorkspace, leaveWorkspace, listUserWorkspaces } from "../src/workspaces.ts";
import { grantPlan, NOW, sha256, user, value } from "./fixtures.ts";
import { raceBeforeFirstWrite } from "./race.ts";
import { recording } from "./recording.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const policy = (change: Partial<WorkspacePolicy> = {}): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...change,
});
const session = (userId: string, hoursAgo = 1): Credential => ({
  kind: "session",
  userId,
  signedInAt: NOW - hoursAgo * HOUR,
  method: { kind: "code" },
});
const cli = (userId: string, hoursAgo: number | null = 1): Credential => ({
  kind: "oauth",
  termsAccepted: true,
  userId,
  clientId: CLI_CLIENT_ID,
  client: "cli",
  signedInAt: hoursAgo === null ? null : NOW - hoursAgo * HOUR,
  method: { kind: "code" },
});
const app = (userId: string, hoursAgo = 1): Credential => ({
  kind: "oauth",
  termsAccepted: true,
  userId,
  clientId: "dcr_client",
  client: "oauth_apps",
  signedInAt: NOW - hoursAgo * HOUR,
  method: { kind: "code" },
});
const as = (credential?: Credential): RequestContext => ({
  kind: "request",
  ip: "192.0.2.10",
  ...(credential ? { credential } : {}),
});
const regionsAs = (credential?: Credential): Regions =>
  regionsFromEnv(withRequestContext(env, as(credential)));
const dbAs = (credential?: Credential): RegionalDb => regionsAs(credential).get("default").db;

async function team(plan: "enterprise" | "free" = "enterprise") {
  const admin = await user("Admin");
  const editor = await user("Editor");
  const member = await user("Member");
  const outsider = await user("Outsider");
  const slug = `sp-${crypto.randomUUID().slice(0, 12)}`;
  const created = value(
    await createWorkspace(regionsAs(session("x")).global, {
      slug,
      name: "Sign-in policies",
      adminUserId: admin.id,
      now: NOW,
    }),
  );
  await regionsAs()
    .global.insert(schema.workspaceMembers)
    .values([
      { workspaceId: created.id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: created.id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  if (plan === "enterprise") await grantPlan(created.id, "enterprise", { seats: 10 });
  return { id: created.id, slug, admin, editor, member, outsider };
}
type Team = Awaited<ReturnType<typeof team>>;

/** Saves as the dashboard does, through the admin's own dashboard session. */
async function save(t: Team, next: WorkspacePolicy, credential = session(t.admin.id)) {
  const r = regionsAs(credential);
  const current = value(
    await getWorkspacePolicy(r.global, { userId: t.admin.id, slug: t.slug, now: NOW }),
  );
  return setWorkspacePolicy(r, {
    userId: t.admin.id,
    slug: t.slug,
    policy: next,
    revision: current.revision,
    now: NOW,
  });
}

async function serviceToken(t: Team) {
  return value(
    await createServiceToken(regionsAs(session(t.admin.id)).global, {
      userId: t.admin.id,
      slug: t.slug,
      body: {
        label: "CI",
        role: "editor",
        scopes: ["artifacts:read", "artifacts:write"],
        expiresInDays: 30,
        restriction: { kind: "none" },
      },
      now: NOW,
    }),
  ).token.id;
}

async function artifactOf(t: Team, accessMode: "workspace" | "restricted" | "public") {
  const id = `sp${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const body = `<p>${id}</p>`;
  const digest = await sha256(body);
  const db = dbAs();
  await db.insert(schema.artifacts).values({
    id,
    ownerId: t.id,
    type: "site",
    name: "Plan",
    state: "active",
    accessMode,
    currentVersionId: `${id}-v1`,
    expiresAt: NOW + 10 * DAY,
  });
  await regionsAs()
    .global.insert(schema.artifactDirectory)
    .values({ id, region: "default", createdAt: NOW })
    .onConflictDoNothing();
  await env.ARTIFACTS.put(`objects/${t.id}/${digest}`, body);
  return id;
}

const ageRefusal = (credential: Credential, hours = 8) => ({
  ok: false,
  code: "policy_refused",
  message: POLICY_MESSAGES.sessionAge(hours, credential),
  reason: "session_age",
});

describe("the maximum session age", () => {
  it("binds every role through every credential kind by its sign-in, never by its last use", async () => {
    const t = await team();
    value(await save(t, policy({ sessionMaxHours: 8 })));
    for (const who of [t.admin, t.editor, t.member]) {
      for (const fresh of [session(who.id, 7), cli(who.id, 7.9), app(who.id, 2)]) {
        expect((await resolveActor(regionsAs(fresh).global, who.id, t.id)).ok).toBe(true);
      }
      for (const old of [session(who.id, 9), cli(who.id, 30), app(who.id, 8.5)]) {
        expect(await resolveActor(regionsAs(old).global, who.id, t.id)).toEqual(ageRefusal(old));
      }
    }
  });

  it("fails closed without a credential, with someone else's, or with a token that does not say", async () => {
    const t = await team();
    value(await save(t, policy({ sessionMaxHours: 8 })));
    for (const context of [
      regionsAs(),
      regionsAs(session(t.admin.id)),
      regionsAs(cli(t.member.id, null)),
    ]) {
      expect(await resolveActor(context.global, t.member.id, t.id)).toMatchObject({
        ok: false,
        code: "policy_refused",
        reason: "session_age",
      });
    }
  });

  it("never binds a service token, background work, the personal space or someone with no role", async () => {
    const t = await team();
    value(await save(t, policy({ sessionMaxHours: 1, allowedClients: [] })));
    const tokenId = await serviceToken(t);
    expect((await resolveActor(regionsAs().global, tokenId, t.id)).ok).toBe(true);
    expect(
      (
        await resolveActor(
          regionsFromEnv(withRequestContext(env, BACKGROUND)).global,
          t.member.id,
          t.id,
        )
      ).ok,
    ).toBe(true);
    expect(
      (await resolveActor(regionsAs(session(t.member.id, 500)).global, t.member.id, t.member.id))
        .ok,
    ).toBe(true);
    expect(
      await resolveActor(regionsAs(session(t.outsider.id, 500)).global, t.outsider.id, t.id),
    ).toEqual({
      ok: false,
      code: "not_found",
      message: "Not found.",
    });
  });

  it("refuses every use case on the workspace, and never lets a blocked member read as an outsider", async () => {
    const t = await team();
    const doc = await artifactOf(t, "restricted");
    await dbAs().insert(schema.artifactReaders).values({ artifactId: doc, email: t.member.email });
    value(await save(t, policy({ sessionMaxHours: 8 })));
    const old = session(t.admin.id, 9);
    expect(
      await renewArtifact(dbAs(old), { userId: t.admin.id, artifactId: doc, now: NOW }),
    ).toEqual(ageRefusal(old));
    // A listed reader who is also a member is bound: the reader list names an account the policy binds.
    const reader = session(t.member.id, 9);
    expect(
      await checkReadAccess(dbAs(reader), { artifactId: doc, userId: t.member.id, now: NOW }),
    ).toEqual(ageRefusal(reader));
    // A public artifact reads as for anyone.
    const open = await artifactOf(t, "public");
    expect(
      (await checkReadAccess(dbAs(reader), { artifactId: open, userId: t.member.id, now: NOW })).ok,
    ).toBe(true);
    // Leaving only reduces access, so it is never refused.
    expect(
      (
        await leaveWorkspace(regionsAs(reader).global, {
          userId: t.member.id,
          slug: t.slug,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
  });

  it("ends a read session at renewal once the app session behind it signed in too long ago", async () => {
    const t = await team();
    const doc = await artifactOf(t, "workspace");
    const authSessionId = `as_${crypto.randomUUID()}`;
    await regionsAs()
      .global.insert(schema.sessions)
      .values({
        id: authSessionId,
        token: `tok_${authSessionId}`,
        userId: t.member.id,
        expiresAt: new Date(NOW + 7 * DAY),
        createdAt: new Date(NOW - 9 * HOUR),
        updatedAt: new Date(NOW),
      });
    const state = "s".repeat(43);
    const issued = value(
      await issueReadHandoff(dbAs(session(t.member.id, 9)), {
        artifactId: doc,
        userId: t.member.id,
        authSessionId,
        state,
        now: NOW,
        requestedHost: null,
        contentDomain: "portifact.dev",
        customDomains: false,
        confirmed: false,
      }),
    );
    const redeemed = value(
      await redeemReadHandoff(dbAs(), {
        code: issued.code,
        artifactId: doc,
        states: [state],
        host: `${doc}.portifact.dev`,
        devHost: `${doc}.portifact.dev`,
        now: NOW,
      }),
    );
    const renew = () =>
      refreshReadSession(dbAs(), { sessionId: redeemed.sessionId, artifactId: doc, now: NOW + 1 });
    expect((await renew()).ok).toBe(true);
    value(await save(t, policy({ sessionMaxHours: 8 })));
    expect(await renew()).toMatchObject({
      ok: false,
      code: "policy_refused",
      reason: "session_age",
    });
    // Signing in again (the app session's sign-in is recent) renews it.
    await regionsAs()
      .global.update(schema.sessions)
      .set({ createdAt: new Date(NOW - HOUR) })
      .where(eq(schema.sessions.id, authSessionId));
    expect((await renew()).ok).toBe(true);
    // The renewal never ends the app session itself.
    expect(
      await regionsAs()
        .global.select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, authSessionId)),
    ).toHaveLength(1);
  });
});

describe("the allowed clients", () => {
  it("lets the dashboard always act, and only the kinds of client the policy lists", async () => {
    const t = await team();
    value(await save(t, policy({ allowedClients: ["cli"] })));
    const at = (credential: Credential) =>
      resolveActor(regionsAs(credential).global, t.editor.id, t.id);
    expect((await at(session(t.editor.id, 500))).ok).toBe(true);
    expect((await at(cli(t.editor.id))).ok).toBe(true);
    expect(await at(app(t.editor.id))).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.client("oauth_apps"),
      reason: "client",
    });
    value(await save(t, policy({ allowedClients: [] })));
    expect(await at(cli(t.editor.id))).toMatchObject({ message: POLICY_MESSAGES.client("cli") });
    const listed = await listUserWorkspaces(regionsAs(cli(t.editor.id)).global, t.editor.id);
    expect(listed.find((row) => row.id === t.id)).toMatchObject({
      blocked: true,
      blockedBy: "client",
    });
  });
});

describe("changing the sign-in policies", () => {
  it("refuses a save that would lock the saving admin out, in the preview too", async () => {
    const t = await team();
    const old = session(t.admin.id, 9);
    expect(await save(t, policy({ sessionMaxHours: 8 }), old)).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.sessionLocksOut(8),
    });
    expect(
      await previewWorkspacePolicy(regionsAs(old), {
        userId: t.admin.id,
        slug: t.slug,
        policy: policy({ sessionMaxHours: 8 }),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    // The dashboard is always an allowed client: allowing none other never locks the admin out.
    expect((await save(t, policy({ allowedClients: [] }))).ok).toBe(true);
  });

  it("previews who it binds, as counts, and shows the admin their own sign-in", async () => {
    const t = await team();
    await regionsAs()
      .global.insert(schema.sessions)
      .values([
        {
          id: `as_${crypto.randomUUID()}`,
          token: crypto.randomUUID(),
          userId: t.editor.id,
          expiresAt: new Date(NOW + DAY),
          createdAt: new Date(NOW - 2 * HOUR),
          updatedAt: new Date(NOW),
        },
      ]);
    await regionsAs()
      .global.insert(schema.oauthRefreshTokens)
      .values({
        id: `rt_${crypto.randomUUID()}`,
        token: crypto.randomUUID(),
        clientId: CLI_CLIENT_ID,
        userId: t.member.id,
        scopes: '["artifacts:read"]',
        expiresAt: new Date(NOW + DAY),
        createdAt: new Date(NOW),
      });
    const preview = value(
      await previewWorkspacePolicy(regionsAs(session(t.admin.id)), {
        userId: t.admin.id,
        slug: t.slug,
        policy: policy({ sessionMaxHours: 8, allowedClients: [] }),
        now: NOW,
      }),
    );
    // Three members; only the editor holds a recent live session; only the member a CLI grant
    // (a device grant without a session: its sign-in is not known, so it counts as old).
    expect(preview.signIns).toEqual({ members: 3, staleMembers: 2, clientMembers: 1 });
    // A fresh dashboard session does not hide an old CLI grant: the editor is refused there.
    await regionsAs()
      .global.insert(schema.oauthRefreshTokens)
      .values({
        id: `rt_${crypto.randomUUID()}`,
        token: crypto.randomUUID(),
        clientId: CLI_CLIENT_ID,
        userId: t.editor.id,
        scopes: '["artifacts:read"]',
        expiresAt: new Date(NOW + DAY),
        createdAt: new Date(NOW),
        authTime: new Date(NOW - 30 * HOUR),
      });
    expect(
      value(
        await previewWorkspacePolicy(regionsAs(session(t.admin.id)), {
          userId: t.admin.id,
          slug: t.slug,
          policy: policy({ sessionMaxHours: 8 }),
          now: NOW,
        }),
      ).signIns,
    ).toMatchObject({ staleMembers: 3 });
    expect(
      value(
        await previewWorkspacePolicy(regionsAs(session(t.admin.id)), {
          userId: t.admin.id,
          slug: t.slug,
          policy: policy({ allowedClients: ["cli"] }),
          now: NOW,
        }),
      ).signIns,
    ).toEqual({ members: 3, staleMembers: 0, clientMembers: 0 });
    const state = value(
      await getWorkspacePolicy(regionsAs(session(t.admin.id, 2)).global, {
        userId: t.admin.id,
        slug: t.slug,
        now: NOW,
      }),
    );
    expect(state.yourSignInAt).toBe(NOW - 2 * HOUR);
    const memberView = value(
      await getWorkspacePolicy(regionsAs(session(t.member.id)).global, {
        userId: t.member.id,
        slug: t.slug,
        now: NOW,
      }),
    );
    expect(memberView.yourSignInAt).toBeNull();
  });

  it("needs the plan to set or tighten, never to loosen, keeps applying after a lapse, and audits", async () => {
    const t = await team("free");
    expect(await save(t, policy({ sessionMaxHours: 8 }))).toMatchObject({
      ok: false,
      code: "plan_required",
    });
    await grantPlan(t.id, "enterprise", { seats: 10 });
    value(await save(t, policy({ sessionMaxHours: 8, allowedClients: ["cli"] })));
    await regionsAs().global.delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    expect(await resolveActor(regionsAs(app(t.member.id)).global, t.member.id, t.id)).toMatchObject(
      {
        reason: "client",
      },
    );
    expect(await save(t, policy({ sessionMaxHours: 4, allowedClients: ["cli"] }))).toMatchObject({
      code: "plan_required",
    });
    value(await save(t, policy({ sessionMaxHours: 24, allowedClients: ["cli", "oauth_apps"] })));
    value(await save(t, DEFAULT_POLICY));
    const events = await regionsAs()
      .global.select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, t.id));
    expect(events.map((row) => row.detail)).toContainEqual(
      expect.objectContaining({ sessionMaxHours: 8, allowedClients: ["cli"] }),
    );
    expect(events.map((row) => row.detail)).toContainEqual(
      expect.objectContaining({ sessionMaxHours: null, allowedClients: null }),
    );
  });

  it("is only for admins", async () => {
    const t = await team();
    const r = regionsAs(session(t.editor.id));
    expect(
      await setWorkspacePolicy(r, {
        userId: t.editor.id,
        slug: t.slug,
        policy: policy({ sessionMaxHours: 8 }),
        revision: 0,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("reducing access is never refused", () => {
  it.each([
    ["an old sign-in", policy({ sessionMaxHours: 8 }), (id: string) => session(id, 9)],
    ["a refused client", policy({ allowedClients: [] }), (id: string) => app(id)],
  ] as const)(
    "lets a member blocked by %s leave and decline an invitation",
    async (_, rule, as) => {
      const t = await team();
      const other = await team();
      value(await save(t, rule));
      value(await save(other, rule));
      const blocked = regionsAs(as(t.member.id)).global;
      expect(await resolveActor(blocked, t.member.id, t.id)).toMatchObject({
        ok: false,
        code: "policy_refused",
      });
      // An invitation to a second workspace with the same policy is declined with the same
      // credential: declining never acts on a workspace.
      const sent: string[] = [];
      value(
        await inviteMember(
          regionsAs(session(other.admin.id)).global,
          {
            userId: other.admin.id,
            slug: other.slug,
            email: t.member.email,
            role: "member",
            now: NOW,
          },
          {
            async send(message) {
              sent.push(message.token);
            },
          },
        ),
      );
      expect(
        await declineInvitation(blocked, {
          userId: t.member.id,
          key: { token: sent[0] as string },
          now: NOW,
        }),
      ).toEqual({ ok: true, value: { declined: true } });
      expect(await leaveWorkspace(blocked, { userId: t.member.id, slug: t.slug })).toEqual({
        ok: true,
        value: { removed: true },
      });
    },
  );
});

describe("the operator", () => {
  it("lifts the sign-in policies with the networks, keeping the rest", async () => {
    const t = await team();
    value(
      await save(t, policy({ publicAccess: "forbidden", sessionMaxHours: 8, allowedClients: [] })),
    );
    const background = regionsFromEnv(withRequestContext(env, BACKGROUND)).global;
    expect(await clearRequestPolicies(background, t.id, NOW)).toEqual({
      outcome: "cleared",
      fields: ["sessionMaxHours", "allowedClients"],
    });
    expect(
      (await resolveActor(regionsAs(app(t.member.id, 500)).global, t.member.id, t.id)).ok,
    ).toBe(true);
  });

  it("restores them, validated, and never lifts one silently", async () => {
    const t = await team();
    const background = regionsFromEnv(withRequestContext(env, BACKGROUND)).global;
    expect(
      await applyWorkspacePolicies(
        background,
        [
          {
            workspaceId: t.id,
            policy: policy({ sessionMaxHours: 8, allowedClients: ["oauth_apps", "cli"] }),
          },
        ],
        NOW,
      ),
    ).toMatchObject({ ok: true, applied: 1, lifting: [] });
    const stored = async () =>
      (
        await background
          .select({ policy: schema.workspaces.policy })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, t.id))
      )[0]?.policy ?? null;
    expect(await stored()).toMatchObject({
      sessionMaxHours: 8,
      allowedClients: ["cli", "oauth_apps"],
    });
    expect(
      await applyWorkspacePolicies(
        background,
        [{ workspaceId: t.id, policy: DEFAULT_POLICY }],
        NOW + 1,
      ),
    ).toMatchObject({
      applied: 0,
      lifting: [{ workspaceId: t.id, fields: ["sessionMaxHours", "allowedClients"] }],
    });
    expect(policyOf(await stored())).toMatchObject({ sessionMaxHours: 8 });
  });
});

describe("races", () => {
  it("binds from the next role decision: a write already past it finishes", async () => {
    const t = await team();
    const doc = await artifactOf(t, "restricted");
    const old = session(t.admin.id, 9);
    const raced = raceBeforeFirstWrite(
      async () => {
        value(await save(t, policy({ sessionMaxHours: 8 })));
      },
      env.DB,
      as(old),
    );
    expect(
      await renewArtifact(raced, { userId: t.admin.id, artifactId: doc, now: NOW }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await renewArtifact(dbAs(old), { userId: t.admin.id, artifactId: doc, now: NOW + 1 }),
    ).toEqual(ageRefusal(old));
  });

  it("refuses a request that decides the role again after the save, inside one request", async () => {
    const t = await team();
    const doc = await artifactOf(t, "restricted");
    const old = session(t.admin.id, 9);
    const raced = raceBeforeFirstWrite(
      async () => {
        value(await save(t, policy({ sessionMaxHours: 8 })));
      },
      env.DB,
      as(old),
    );
    expect(
      await updateAccess(raced, {
        userId: t.admin.id,
        artifactId: doc,
        change: { addReaders: ["first@example.test"] },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "policy_refused", reason: "session_age" });
  });
});

describe("two regions", () => {
  it("binds an EU workspace's people with no statement crossing databases", async () => {
    const admin = await user("EU admin");
    const member = await user("EU member");
    const slug = `sp-eu-${crypto.randomUUID().slice(0, 8)}`;
    const ws = value(
      await createWorkspace(regionsAs(session(admin.id)).global, {
        slug,
        name: "EU",
        adminUserId: admin.id,
        now: NOW,
        region: "eu",
      }),
    );
    await grantPlan(ws.id, "enterprise", { seats: 5 });
    await regionsAs()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: member.id, role: "member", updatedAt: NOW });
    value(
      await save(
        { id: ws.id, slug, admin, editor: member, member, outsider: member },
        policy({ sessionMaxHours: 8, allowedClients: ["cli"] }),
      ),
    );
    // The strict region guard is on: a wrong-handle statement would throw.
    const old = session(member.id, 9);
    expect(await resolveActor(regionsAs(old).get("eu").db.global, member.id, ws.id)).toEqual(
      ageRefusal(old),
    );
    expect(await resolveActor(regionsAs(app(member.id)).global, member.id, ws.id)).toMatchObject({
      reason: "client",
    });
    expect((await resolveActor(regionsAs(cli(member.id)).global, member.id, ws.id)).ok).toBe(true);
  });
});

describe("D1 calls", () => {
  it("adds no call to resolving a role or listing workspaces, with or without the policies", async () => {
    const t = await team();
    const count = async (credential: Credential) => {
      const { database, count: calls } = recording(env.DB, as(credential));
      await resolveActor(database.global, t.member.id, t.id);
      await listUserWorkspaces(database.global, t.member.id);
      return calls();
    };
    const before = await count(session(t.member.id));
    value(await save(t, policy({ sessionMaxHours: 8, allowedClients: ["cli"] })));
    expect(await count(session(t.member.id))).toBe(before);
    expect(await count(session(t.member.id, 9))).toBe(before);
    expect(before).toBe(2);
  });
});
