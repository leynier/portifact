// "SSO required" (decision 0021): people act on a workspace only through a sign-in with the
// workspace's own single sign-on provider. Applied where the role is decided (`actorOn`) from the
// credential the Worker recorded; every role, a service token, a non-member, the personal space,
// every credential kind with every method, renewals, the lock-out checks, what makes it
// unsatisfiable (clearing or suspending), the plan, the escape hatch, restores, races, two
// regions and what it costs in D1 calls.
import { env } from "cloudflare:test";
import {
  BACKGROUND,
  CLI_CLIENT_ID,
  type Credential,
  DEFAULT_POLICY,
  type RequestContext,
  type SignInMethod,
  type WorkspacePolicy,
} from "@portifact/contracts";
import { type Regions, regionsFromEnv, schema, withRequestContext } from "@portifact/db";
import { entitlements, POLICY_MESSAGES, policyOf } from "@portifact/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateAccess } from "../src/access.ts";
import { resolveActor } from "../src/actors.ts";
import { declineInvitation, inviteMember } from "../src/invitations.ts";
import { renewArtifact } from "../src/lifecycle.ts";
import { setOwnerPlan } from "../src/plans.ts";
import { issueReadHandoff, redeemReadHandoff, refreshReadSession } from "../src/read-access.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { removeSsoProvider } from "../src/sso.ts";
import {
  planHasSsoSql,
  syncSsoRequirementStates,
  workspaceSsoProvider,
} from "../src/sso-required.ts";
import { FakeDomains } from "../src/testing/fake-domains.ts";
import {
  recheckEmailDomains,
  removeWorkspaceDomain,
  verifyWorkspaceDomain,
} from "../src/workspace-domains.ts";
import {
  applyWorkspacePolicies,
  clearRequestPolicies,
  getWorkspacePolicy,
  previewWorkspacePolicy,
  setWorkspacePolicy,
} from "../src/workspace-policies.ts";
import { createWorkspace, leaveWorkspace, listUserWorkspaces } from "../src/workspaces.ts";
import { grantPlan, NOW, sha256, value } from "./fixtures.ts";
import { raceBeforeFirstWrite } from "./race.ts";
import { recording } from "./recording.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REQUIRED: WorkspacePolicy = { ...DEFAULT_POLICY, ssoRequired: true };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const hex = () => crypto.randomUUID().replaceAll("-", "");
const CODE: SignInMethod = { kind: "code" };
const GOOGLE: SignInMethod = { kind: "social", provider: "google" };
const sso = (providerId: string): SignInMethod => ({ kind: "sso", providerId });

const session = (userId: string, method: SignInMethod | null): Credential => ({
  kind: "session",
  userId,
  signedInAt: NOW - HOUR,
  method,
});
const cli = (userId: string, method: SignInMethod | null): Credential => ({
  kind: "oauth",
  userId,
  clientId: CLI_CLIENT_ID,
  client: "cli",
  signedInAt: NOW - HOUR,
  method,
});
const app = (userId: string, method: SignInMethod | null): Credential => ({
  kind: "oauth",
  userId,
  clientId: "dcr_client",
  client: "oauth_apps",
  signedInAt: NOW - HOUR,
  method,
});
const as = (credential?: Credential, offered = true): RequestContext => ({
  kind: "request",
  ip: "192.0.2.10",
  ...(offered ? { sso: true } : {}),
  ...(credential ? { credential } : {}),
});
const regionsAs = (credential?: Credential, offered = true): Regions =>
  regionsFromEnv(withRequestContext(env, as(credential, offered)));
const background = () => regionsFromEnv(withRequestContext(env, BACKGROUND)).global;

async function person(name: string, domain: string) {
  const id = `u_${crypto.randomUUID()}`;
  const email = `${name.toLowerCase()}.${id.slice(2, 10)}@${domain}`;
  await background()
    .insert(schema.users)
    .values({
      id,
      name,
      email,
      emailVerified: true,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

/**
 * A workspace on Enterprise with a verified domain and a provider serving it: an admin, an
 * editor and a member at that domain, a member at another one, and an outsider.
 */
async function team(region: "default" | "eu" = "default") {
  const domain = `corp-${hex().slice(0, 10)}.example`;
  const admin = await person("Admin", domain);
  const editor = await person("Editor", domain);
  const member = await person("Member", domain);
  const contractor = await person("Contractor", "elsewhere.example");
  const outsider = await person("Outsider", domain);
  const slug = `sr-${hex().slice(0, 12)}`;
  const created = value(
    await createWorkspace(background(), {
      slug,
      name: "SSO required",
      adminUserId: admin.id,
      now: NOW,
      ...(region === "eu" ? { region } : {}),
    }),
  );
  await background()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: created.id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: created.id, userId: member.id, role: "member", updatedAt: NOW },
      { workspaceId: created.id, userId: contractor.id, role: "member", updatedAt: NOW },
    ]);
  await grantPlan(created.id, "enterprise", { seats: 10 });
  const domainId = `wd_${hex()}`;
  await background()
    .insert(schema.workspaceDomains)
    .values({
      id: domainId,
      workspaceId: created.id,
      domain,
      token: "t".repeat(32),
      state: "verified",
      createdAt: NOW,
      expiresAt: NOW + DAY,
      verifiedAt: NOW,
    });
  const providerId = `sso_${hex()}`;
  await background().insert(schema.workspaceSso).values({
    id: providerId,
    workspaceId: created.id,
    issuer: "https://login.corp.example",
    clientId: "portifact",
    clientSecretSealed: "sealed",
    secretKeyId: "k1",
    domains: domain,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return {
    id: created.id,
    slug,
    domain,
    domainId,
    providerId,
    admin,
    editor,
    member,
    contractor,
    outsider,
  };
}
type Team = Awaited<ReturnType<typeof team>>;

/** Saves as the dashboard does, through the admin's own session (an SSO one by default). */
async function save(
  t: Team,
  next: WorkspacePolicy,
  options: { credential?: Credential; outside?: number; offered?: boolean } = {},
) {
  const r = regionsAs(
    options.credential ?? session(t.admin.id, sso(t.providerId)),
    options.offered ?? true,
  );
  const current = value(
    await getWorkspacePolicy(r.global, { userId: t.admin.id, slug: t.slug, now: NOW }),
  );
  return setWorkspacePolicy(r, {
    userId: t.admin.id,
    slug: t.slug,
    policy: next,
    revision: current.revision,
    confirmedOutsideProvider: options.outside,
    now: NOW,
  });
}

const stored = async (t: Team) =>
  (
    await background()
      .select({ policy: schema.workspaces.policy })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, t.id))
  )[0]?.policy ?? null;

const refusal = (credential: Credential) => ({
  ok: false,
  code: "policy_refused",
  message: POLICY_MESSAGES.ssoRequired(credential),
  reason: "sso",
});

const policyEvents = (t: Team) =>
  regionsAs()
    .get("default")
    .db.select({ actorType: schema.auditEvents.actorType, detail: schema.auditEvents.detail })
    .from(schema.auditEvents)
    .where(
      and(eq(schema.auditEvents.ownerId, t.id), eq(schema.auditEvents.kind, "policy.changed")),
    );

async function artifactOf(t: Team, accessMode: "workspace" | "restricted" | "public") {
  const id = `sr${hex().slice(0, 8)}`;
  const body = `<p>${id}</p>`;
  const digest = await sha256(body);
  const db = regionsAs().get("default").db;
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
  await background()
    .insert(schema.artifactDirectory)
    .values({ id, region: "default", createdAt: NOW })
    .onConflictDoNothing();
  await env.ARTIFACTS.put(`objects/${t.id}/${digest}`, body);
  return id;
}

describe("acting on a workspace that requires single sign-on", () => {
  it("admits every role only through a sign-in with this workspace's provider, on every credential", async () => {
    const t = await team();
    value(await save(t, REQUIRED, { outside: 1 }));
    const other = `sso_${hex()}`;
    for (const who of [t.admin, t.editor, t.member]) {
      for (const make of [session, cli, app]) {
        const through = make(who.id, sso(t.providerId));
        expect((await resolveActor(regionsAs(through).global, who.id, t.id)).ok).toBe(true);
        for (const method of [CODE, GOOGLE, sso(other), null]) {
          const credential = make(who.id, method);
          expect(await resolveActor(regionsAs(credential).global, who.id, t.id)).toEqual(
            refusal(credential),
          );
        }
      }
    }
  });

  it("fails closed without a credential or with someone else's", async () => {
    const t = await team();
    value(await save(t, REQUIRED, { outside: 1 }));
    for (const context of [regionsAs(), regionsAs(session(t.admin.id, sso(t.providerId)))]) {
      expect(await resolveActor(context.global, t.member.id, t.id)).toMatchObject({
        ok: false,
        reason: "sso",
      });
    }
  });

  it("never binds a service token, background work, the personal space or someone with no role", async () => {
    const t = await team();
    const tokenId = value(
      await createServiceToken(regionsAs(session(t.admin.id, sso(t.providerId))).global, {
        userId: t.admin.id,
        slug: t.slug,
        body: {
          label: "CI",
          role: "editor",
          scopes: ["artifacts:read"],
          expiresInDays: 30,
          restriction: { kind: "none" },
        },
        now: NOW,
      }),
    ).token.id;
    value(await save(t, REQUIRED, { outside: 1 }));
    expect((await resolveActor(regionsAs().global, tokenId, t.id)).ok).toBe(true);
    expect((await resolveActor(background(), t.member.id, t.id)).ok).toBe(true);
    const code = session(t.member.id, CODE);
    expect((await resolveActor(regionsAs(code).global, t.member.id, t.member.id)).ok).toBe(true);
    expect(
      await resolveActor(regionsAs(session(t.outsider.id, CODE)).global, t.outsider.id, t.id),
    ).toEqual({ ok: false, code: "not_found", message: "Not found." });
  });

  it("refuses use cases and never lets a blocked member read as an outsider, but lets them leave and decline", async () => {
    const t = await team();
    const doc = await artifactOf(t, "restricted");
    await regionsAs()
      .get("default")
      .db.insert(schema.artifactReaders)
      .values({ artifactId: doc, email: t.member.email });
    value(await save(t, REQUIRED, { outside: 1 }));
    const code = session(t.member.id, CODE);
    expect(
      await renewArtifact(regionsAs(code).get("default").db, {
        userId: t.member.id,
        artifactId: doc,
        now: NOW,
      }),
    ).toEqual(refusal(code));
    // Listing keeps the workspace, blocked by single sign-on, with no read added.
    const listed = await listUserWorkspaces(regionsAs(code).global, t.member.id);
    expect(listed.find((w) => w.id === t.id)).toMatchObject({ blocked: true, blockedBy: "sso" });
    // An invitation to another workspace that requires it is declined with the same credential.
    const other = await team();
    value(await save(other, REQUIRED, { outside: 1 }));
    const sent: string[] = [];
    value(
      await inviteMember(
        regionsAs(session(other.admin.id, sso(other.providerId))).global,
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
      await declineInvitation(regionsAs(code).global, {
        userId: t.member.id,
        key: { token: sent[0] as string },
        now: NOW,
      }),
    ).toEqual({ ok: true, value: { declined: true } });
    expect(
      await leaveWorkspace(regionsAs(code).global, { userId: t.member.id, slug: t.slug }),
    ).toEqual({ ok: true, value: { removed: true } });
  });

  it("ends a read session at renewal when the app session did not sign in through the provider", async () => {
    const t = await team();
    const doc = await artifactOf(t, "workspace");
    const insertSession = async (method: string | null) => {
      const id = `as_${crypto.randomUUID()}`;
      await background()
        .insert(schema.sessions)
        .values({
          id,
          token: `tok_${id}`,
          userId: t.member.id,
          expiresAt: new Date(NOW + 7 * DAY),
          createdAt: new Date(NOW - HOUR),
          updatedAt: new Date(NOW),
          signInMethod: method,
        });
      return id;
    };
    const readSession = async (authSessionId: string) => {
      const state = "s".repeat(43);
      const issued = value(
        await issueReadHandoff(regionsAs(session(t.member.id, CODE)).get("default").db, {
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
      return value(
        await redeemReadHandoff(regionsAs().get("default").db, {
          code: issued.code,
          artifactId: doc,
          states: [state],
          host: `${doc}.portifact.dev`,
          devHost: `${doc}.portifact.dev`,
          now: NOW,
        }),
      ).sessionId;
    };
    const viaCode = await readSession(await insertSession("code"));
    const viaSso = await readSession(await insertSession(`sso:${t.providerId}`));
    const renew = (sessionId: string, offered = true) =>
      refreshReadSession(regionsAs(undefined, offered).get("default").db, {
        sessionId,
        artifactId: doc,
        now: NOW + 1,
      });
    expect((await renew(viaCode)).ok).toBe(true);
    value(await save(t, REQUIRED, { outside: 1 }));
    expect(await renew(viaCode)).toMatchObject({ ok: false, reason: "sso" });
    expect((await renew(viaSso)).ok).toBe(true);
    // A Worker without single sign-on applies it exactly the same: never a per-Worker switch.
    expect(await renew(viaCode, false)).toMatchObject({ ok: false, reason: "sso" });
    expect((await renew(viaSso, false)).ok).toBe(true);
  });
});

describe("never a setting nobody can satisfy", () => {
  it("needs single sign-on offered, a provider that can sign people in and the admin's own SSO session", async () => {
    const t = await team();
    // Single sign-on off: it cannot be newly required.
    expect(await save(t, REQUIRED, { offered: false, outside: 1 })).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.ssoOff,
    });
    expect(await stored(t)).toBeNull();
    // The admin's own session signed in another way: refused, in the preview too.
    for (const method of [CODE, GOOGLE, sso(`sso_${hex()}`), null]) {
      const credential = session(t.admin.id, method);
      expect(await save(t, REQUIRED, { credential, outside: 1 })).toEqual({
        ok: false,
        code: "invalid_input",
        message: POLICY_MESSAGES.ssoLocksOut,
      });
      expect(
        await previewWorkspacePolicy(regionsAs(credential), {
          userId: t.admin.id,
          slug: t.slug,
          policy: REQUIRED,
          now: NOW,
        }),
      ).toMatchObject({ ok: false, message: POLICY_MESSAGES.ssoLocksOut });
    }
    // No verified domain the provider serves.
    await background()
      .update(schema.workspaceDomains)
      .set({ state: "pending" })
      .where(eq(schema.workspaceDomains.id, t.domainId));
    expect(await save(t, REQUIRED, { outside: 1 })).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.ssoNotUsable,
    });
  });

  it("needs sso in the plan to set it", async () => {
    const t = await team();
    await background()
      .update(schema.ownerPlans)
      .set({ plan: "team" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    expect(await save(t, REQUIRED, { outside: 1 })).toMatchObject({
      ok: false,
      code: "plan_required",
    });
  });

  it("previews who it binds and needs the members the provider cannot serve confirmed", async () => {
    const t = await team();
    const preview = value(
      await previewWorkspacePolicy(regionsAs(session(t.admin.id, sso(t.providerId))), {
        userId: t.admin.id,
        slug: t.slug,
        policy: REQUIRED,
        now: NOW,
      }),
    );
    expect(preview.sso).toEqual({ members: 4, outsideProvider: 1, withoutSsoSession: 4 });
    expect(await save(t, REQUIRED)).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.ssoOutside(1),
    });
    expect(await save(t, REQUIRED, { outside: 0 })).toMatchObject({
      ok: false,
      message: POLICY_MESSAGES.ssoOutsideGrew,
    });
    const state = value(await save(t, REQUIRED, { outside: 1 }));
    expect(state.policy.ssoRequired).toBe(true);
    expect(state.sso).toEqual({ usable: true, yourSession: true, offered: true });
    expect(await stored(t)).toMatchObject({ ssoRequired: true });
    expect(
      await resolveActor(regionsAs(session(t.contractor.id, CODE)).global, t.contractor.id, t.id),
    ).toMatchObject({ reason: "sso" });
    expect((await policyEvents(t)).find((e) => e.actorType === "user")).toEqual({
      actorType: "user",
      detail: { fields: ["ssoRequired"], ssoRequired: true, outsideProvider: 1, confirmed: false },
    });
    // Lifting it needs no confirmation and no plan.
    await background()
      .update(schema.ownerPlans)
      .set({ plan: "free" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    expect(value(await save(t, DEFAULT_POLICY)).policy.ssoRequired).toBe(false);
    expect(await stored(t)).toBeNull();
  });

  it("keeps binding and shows admins it cannot be met where single sign-on is off; only admins see the provider state", async () => {
    const t = await team();
    value(await save(t, REQUIRED, { outside: 1 }));
    // Switched off: the stored requirement binds (fail closed), the admin with a code session too.
    const code = session(t.admin.id, CODE);
    expect(await resolveActor(regionsAs(code, false).global, t.admin.id, t.id)).toMatchObject({
      reason: "sso",
    });
    // An admin whose session went through the provider before the switch reads that it cannot
    // be met, and nothing hides it.
    const off = value(
      await getWorkspacePolicy(regionsAs(session(t.admin.id, sso(t.providerId)), false).global, {
        userId: t.admin.id,
        slug: t.slug,
        now: NOW,
      }),
    );
    expect(off.policy.ssoRequired).toBe(true);
    expect(off.sso).toEqual({ usable: true, yourSession: true, offered: false });
    // That admin can still lift it; nobody can newly require it.
    value(await save(t, DEFAULT_POLICY, { offered: false }));
    expect(await stored(t)).toBeNull();
    value(await save(t, REQUIRED, { outside: 1 }));
    // Where single sign-on is off and nothing is required, nothing is offered.
    const plain = await team();
    expect(
      value(
        await getWorkspacePolicy(regionsAs(session(plain.admin.id, CODE), false).global, {
          userId: plain.admin.id,
          slug: plain.slug,
          now: NOW,
        }),
      ).sso,
    ).toBeNull();
    const member = value(
      await getWorkspacePolicy(regionsAs(session(t.member.id, sso(t.providerId))).global, {
        userId: t.member.id,
        slug: t.slug,
        now: NOW,
      }),
    );
    expect(member.policy.ssoRequired).toBe(true);
    expect(member.sso).toBeNull();
  });
});

describe("what makes it unsatisfiable", () => {
  it("removing the provider clears it in the same batch, by the system and recorded", async () => {
    const t = await team();
    value(await save(t, { ...REQUIRED, publicAccess: "forbidden" }, { outside: 1 }));
    value(
      await removeSsoProvider(regionsAs(session(t.admin.id, sso(t.providerId))).global, {
        userId: t.admin.id,
        slug: t.slug,
        now: NOW + 1,
      }),
    );
    expect(policyOf(await stored(t))).toMatchObject({
      ssoRequired: false,
      publicAccess: "forbidden",
    });
    expect(
      (await resolveActor(regionsAs(session(t.member.id, CODE)).global, t.member.id, t.id)).ok,
    ).toBe(true);
    expect((await policyEvents(t)).find((e) => e.actorType === "system")).toEqual({
      actorType: "system",
      detail: {
        fields: ["ssoRequired"],
        ssoRequired: false,
        reason: "sso_removed",
        confirmed: false,
      },
    });
  });

  it("suspends it while the provider serves no verified domain or the plan lacks sso, and binds again after", async () => {
    const t = await team();
    value(await save(t, REQUIRED, { outside: 1 }));
    const code = session(t.member.id, CODE);
    const acts = async () => (await resolveActor(regionsAs(code).global, t.member.id, t.id)).ok;
    expect(await acts()).toBe(false);
    // The daily re-check removed the domain.
    await background()
      .update(schema.workspaceDomains)
      .set({ state: "pending" })
      .where(eq(schema.workspaceDomains.id, t.domainId));
    expect(await workspaceSsoProvider(background(), t.id, NOW)).toBeNull();
    expect(await acts()).toBe(true);
    await background()
      .update(schema.workspaceDomains)
      .set({ state: "verified" })
      .where(eq(schema.workspaceDomains.id, t.domainId));
    expect(await acts()).toBe(false);
    // The plan lapsed: the sign-in itself is refused, so the requirement cannot bind.
    await background()
      .update(schema.ownerPlans)
      .set({ validUntil: NOW - 1 })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    expect(await acts()).toBe(true);
    expect(policyOf(await stored(t)).ssoRequired).toBe(true);
    await background()
      .update(schema.ownerPlans)
      .set({ validUntil: null })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    expect(await acts()).toBe(false);
    // Single sign-on switched off on the Worker: applied all the same (fail closed).
    expect((await resolveActor(regionsAs(code, false).global, t.member.id, t.id)).ok).toBe(false);
  });
});

describe("the operator", () => {
  it("lifts it with the other request policies", async () => {
    const t = await team();
    value(await save(t, { ...REQUIRED, sessionMaxHours: 8 }, { outside: 1 }));
    expect(await clearRequestPolicies(background(), t.id, NOW)).toEqual({
      outcome: "cleared",
      fields: ["sessionMaxHours", "ssoRequired"],
    });
    expect(
      (await resolveActor(regionsAs(session(t.member.id, CODE)).global, t.member.id, t.id)).ok,
    ).toBe(true);
  });

  it("restores it only where the provider can sign people in, and never lifts it silently", async () => {
    const t = await team();
    expect(
      await applyWorkspacePolicies(background(), [{ workspaceId: t.id, policy: REQUIRED }], NOW),
    ).toMatchObject({ ok: true, applied: 1, ssoUnusable: [] });
    expect(
      await applyWorkspacePolicies(
        background(),
        [{ workspaceId: t.id, policy: DEFAULT_POLICY }],
        NOW + 1,
      ),
    ).toMatchObject({ applied: 0, lifting: [{ workspaceId: t.id, fields: ["ssoRequired"] }] });
    const bare = await team();
    await background()
      .delete(schema.workspaceSso)
      .where(eq(schema.workspaceSso.id, bare.providerId));
    expect(
      await applyWorkspacePolicies(background(), [{ workspaceId: bare.id, policy: REQUIRED }], NOW),
    ).toMatchObject({ applied: 0, ssoUnusable: [bare.id] });
    expect(await stored(bare)).toBeNull();
  });
});

describe("races", () => {
  it("refuses a request that decides the role again after the save, inside one request", async () => {
    const t = await team();
    const doc = await artifactOf(t, "restricted");
    const code = session(t.editor.id, CODE);
    const raced = raceBeforeFirstWrite(
      async () => {
        value(await save(t, REQUIRED, { outside: 1 }));
      },
      env.DB,
      as(code),
    );
    expect(
      await updateAccess(raced, {
        userId: t.editor.id,
        artifactId: doc,
        change: { addReaders: [`first@${t.domain}`] },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "policy_refused", reason: "sso" });
  });
});

describe("two regions", () => {
  it("binds an EU workspace's people with no statement crossing databases", async () => {
    const t = await team("eu");
    value(await save(t, REQUIRED, { outside: 1 }));
    // The strict region guard is on: a wrong-handle statement would throw.
    const code = session(t.member.id, CODE);
    expect(await resolveActor(regionsAs(code).get("eu").db.global, t.member.id, t.id)).toEqual(
      refusal(code),
    );
    const through = cli(t.member.id, sso(t.providerId));
    expect((await resolveActor(regionsAs(through).global, t.member.id, t.id)).ok).toBe(true);
  });
});

describe("D1 calls", () => {
  it("adds no call to resolving a role or listing workspaces, with or without the requirement", async () => {
    const t = await team();
    const count = async (credential: Credential) => {
      const { database, count: calls } = recording(env.DB, as(credential));
      await resolveActor(database.global, t.member.id, t.id);
      await listUserWorkspaces(database.global, t.member.id);
      return calls();
    };
    const before = await count(session(t.member.id, CODE));
    value(await save(t, REQUIRED, { outside: 1 }));
    expect(await count(session(t.member.id, CODE))).toBe(before);
    expect(await count(session(t.member.id, sso(t.providerId)))).toBe(before);
    expect(before).toBe(2);
  });
});

describe("entering and leaving suspension, recorded by the write that causes it", () => {
  const transitions = async (t: Team) =>
    (
      await background()
        .select({ kind: schema.auditEvents.kind, detail: schema.auditEvents.detail })
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.ownerId, t.id),
            inArray(schema.auditEvents.kind, ["policy.sso_suspended", "policy.sso_resumed"]),
          ),
        )
        .orderBy(schema.auditEvents.recordedAt)
    ).map((e) => `${e.kind}:${(e.detail as { cause: string }).cause}`);
  const flag = async (t: Team) =>
    (
      await background()
        .select({ s: schema.workspaces.ssoSuspended })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, t.id))
    )[0]?.s;
  const adminCode = (t: Team) => regionsAs(session(t.admin.id, CODE)).global;

  it("an admin removing the provider's domain suspends it, and verifying one again resumes it", async () => {
    const t = await team();
    value(await save(t, REQUIRED, { outside: 1 }));
    // Bound now, so the admin acts through their SSO session.
    const admin = regionsAs(session(t.admin.id, sso(t.providerId))).global;
    value(
      await removeWorkspaceDomain(admin, {
        userId: t.admin.id,
        slug: t.slug,
        domainId: t.domainId,
        now: NOW,
      }),
    );
    expect(await transitions(t)).toEqual(["policy.sso_suspended:domain"]);
    expect(await flag(t)).toBe(1);
    // Suspended: a code session acts; a retried removal records nothing more.
    expect((await resolveActor(adminCode(t), t.admin.id, t.id)).ok).toBe(true);
    await removeWorkspaceDomain(adminCode(t), {
      userId: t.admin.id,
      slug: t.slug,
      domainId: t.domainId,
      now: NOW,
    });
    expect(await transitions(t)).toEqual(["policy.sso_suspended:domain"]);
    // Claiming and proving the domain again resumes it.
    const id = `wd_${hex()}`;
    const token = "v".repeat(32);
    await background()
      .insert(schema.workspaceDomains)
      .values({
        id,
        workspaceId: t.id,
        domain: t.domain,
        token,
        state: "pending",
        createdAt: NOW,
        expiresAt: NOW + DAY,
      });
    const dns = new FakeDomains();
    dns.publishTxt(`_portifact-email.${t.domain}`, `portifact-email-verify=${token}`);
    value(
      await verifyWorkspaceDomain(adminCode(t), dns, {
        userId: t.admin.id,
        slug: t.slug,
        domainId: id,
        now: NOW + 1,
      }),
    );
    expect(await transitions(t)).toEqual([
      "policy.sso_suspended:domain",
      "policy.sso_resumed:domain",
    ]);
    expect(await flag(t)).toBe(0);
    expect((await resolveActor(adminCode(t), t.admin.id, t.id)).ok).toBe(false);
  });

  it("the daily re-check removing the domain suspends it", async () => {
    const t = await team();
    value(await save(t, REQUIRED, { outside: 1 }));
    await background()
      .update(schema.workspaceDomains)
      .set({ failedChecks: 99, checkedAt: NOW - 3 * DAY })
      .where(eq(schema.workspaceDomains.id, t.domainId));
    await recheckEmailDomains(background(), new FakeDomains(), NOW);
    expect(await transitions(t)).toEqual(["policy.sso_suspended:domain"]);
  });

  it("a plan change losing or gaining sso suspends or resumes it, and the scan notices an expiry", async () => {
    const t = await team();
    value(await save(t, REQUIRED, { outside: 1 }));
    const grant = (plan: "team" | "enterprise", validUntil: number | null = null) =>
      setOwnerPlan(regionsAs().get("default").db, {
        ownerId: t.id,
        plan,
        seats: 10,
        validUntil,
        overrides: null,
        grantedBy: "test",
        note: null,
        now: NOW,
      });
    value(await grant("team"));
    expect(await transitions(t)).toEqual(["policy.sso_suspended:plan"]);
    value(await grant("enterprise", NOW + HOUR));
    expect(await transitions(t)).toEqual(["policy.sso_suspended:plan", "policy.sso_resumed:plan"]);
    // The plan expires with no write: the scan records it, once.
    expect(await syncSsoRequirementStates(background(), NOW + 2 * HOUR)).toEqual({ changed: 1 });
    expect(await syncSsoRequirementStates(background(), NOW + 2 * HOUR)).toEqual({ changed: 0 });
    expect(await transitions(t)).toEqual([
      "policy.sso_suspended:plan",
      "policy.sso_resumed:plan",
      "policy.sso_suspended:scan",
    ]);
  });

  it("decides whether the plan includes sso exactly as entitlements does", async () => {
    const owner = `ws_${hex()}`;
    const rows = [
      { plan: "enterprise", validUntil: null, overrides: null },
      { plan: "enterprise", validUntil: NOW - 1, overrides: null },
      { plan: "enterprise", validUntil: NOW + 1, overrides: null },
      { plan: "team", validUntil: null, overrides: null },
      { plan: "team", validUntil: null, overrides: { features: { sso: true } } },
      { plan: "enterprise", validUntil: null, overrides: { features: { sso: false } } },
      { plan: "pro", validUntil: null, overrides: { features: { webhooks: true } } },
      { plan: "free", validUntil: null, overrides: null },
    ] as const;
    for (const row of rows) {
      await background().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, owner));
      await grantPlan(owner, row.plan, { validUntil: row.validUntil, overrides: row.overrides });
      const [read] = await background().all<{ has: number }>(
        sql`select ${planHasSsoSql(owner, NOW)} as has`,
      );
      const expected = entitlements(
        { plan: row.plan, seats: 1, validUntil: row.validUntil, overrides: row.overrides },
        NOW,
      ).features.includes("sso");
      expect(Number(read?.has) === 1, JSON.stringify(row)).toBe(expected);
    }
    await background().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, owner));
    const [none] = await background().all<{ has: number }>(
      sql`select ${planHasSsoSql(owner, NOW)} as has`,
    );
    expect(Number(none?.has)).toBe(0);
  });
});
