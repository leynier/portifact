// SCIM provisioning for a workspace (premium plan E2, decision 0017): the directory's tokens and
// settings, authentication, provisioning with and without an account, deactivation and deletion,
// seats, the last admin, verified domains, removals by hand, sign-in claims, races, single
// sign-on, restores and pruning.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { revokeInvitation } from "../src/invitations.ts";
import {
  authenticateScimToken,
  claimDirectoryMemberships,
  createScimToken,
  createScimUser,
  deleteScimUser,
  directoryPendingExpiry,
  findScimToken,
  getScimOverview,
  getScimUser,
  hitScimRateLimit,
  listScimUsers,
  operatorRevokeScimToken,
  patchScimUser,
  pruneDirectoryUsers,
  replaceScimUser,
  revokeScimToken,
  type ScimCaller,
  type ScimDeps,
  updateScimSettings,
} from "../src/scim.ts";
import { joinWorkspaceThroughSso } from "../src/sso.ts";
import { leaveWorkspace, removeMember } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, value } from "./fixtures.ts";
import { raceGlobalBeforeFirstWrite } from "./race.ts";

const hex = () => crypto.randomUUID().replaceAll("-", "");
const global = () => db().global;
const BASE = "https://app.portifact.com/scim/v2";
const ended: string[] = [];
const END = async (account: string) => {
  ended.push(account);
};
const NO_EMAIL: ScimDeps = { sender: null, endSessions: END };

async function person(email: string) {
  const id = `u_${hex()}`;
  await global()
    .insert(schema.users)
    .values({
      id,
      name: "Someone",
      email,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  return id;
}

interface Team {
  id: string;
  slug: string;
  domain: string;
  admin: string;
  editor: string;
}

async function team(options: { plan?: "enterprise" | "team" | "none"; seats?: number } = {}) {
  const id = `ws_${hex()}`;
  const slug = `s${hex().slice(0, 20)}`;
  const domain = `corp${hex().slice(0, 10)}.com`;
  const admin = await person(`admin@${domain}`);
  const editor = await person(`editor@${domain}`);
  await global()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Corp", createdBy: admin, updatedAt: NOW });
  await global()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: admin, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: editor, role: "editor", updatedAt: NOW },
    ]);
  await global()
    .insert(schema.workspaceDomains)
    .values({
      id: `wd_${hex()}`,
      workspaceId: id,
      domain,
      token: hex(),
      state: "verified",
      createdAt: NOW,
      expiresAt: NOW,
      verifiedAt: NOW,
    });
  const plan = options.plan ?? "enterprise";
  if (plan !== "none") await grantPlan(id, plan, { seats: options.seats ?? 10 });
  return { id, slug, domain, admin, editor } satisfies Team;
}

/** A team with a SCIM token: its caller and secret. */
async function directory(t: Team) {
  const created = value(
    await createScimToken(global(), {
      userId: t.admin,
      slug: t.slug,
      body: { label: "Okta", expiresInDays: 365 },
      now: NOW,
    }),
  );
  return {
    caller: { tokenId: created.token.id, workspaceId: t.id } satisfies ScimCaller,
    secret: created.secret,
  };
}

const user = (userName: string, extra: Partial<{ active: boolean; externalId: string }> = {}) => ({
  userName,
  externalId: extra.externalId ?? null,
  active: extra.active ?? true,
  names: { givenName: "Ada" },
});

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { detail: string } }): T {
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}

async function role(t: Team, userId: string) {
  const [row] = await global()
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, t.id),
        eq(schema.workspaceMembers.userId, userId),
      ),
    );
  return row?.role ?? null;
}

async function pending(t: Team, email: string) {
  const [row] = await global()
    .select()
    .from(schema.workspaceInvitations)
    .where(
      and(
        eq(schema.workspaceInvitations.workspaceId, t.id),
        eq(schema.workspaceInvitations.email, email),
      ),
    );
  return row ?? null;
}

async function events(t: Team) {
  const rows = await global()
    .select({
      kind: schema.auditEvents.kind,
      actorType: schema.auditEvents.actorType,
      detail: schema.auditEvents.detail,
    })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.ownerId, t.id))
    .orderBy(schema.auditEvents.at);
  return rows.map((row) => [row.kind, row.actorType] as const);
}

const deactivate = { Operations: [{ op: "Replace", path: "active", value: "False" }] };
const reactivate = { Operations: [{ op: "replace", value: { active: true } }] };

describe("the directory's tokens", () => {
  it("creates one for an admin on Enterprise, shows it in the overview and records it", async () => {
    const t = await team();
    const { caller, secret } = await directory(t);
    expect(secret).toMatch(/^pfsc_[A-Za-z0-9_-]{43}$/);
    const [row] = await global()
      .select()
      .from(schema.scimTokens)
      .where(eq(schema.scimTokens.id, caller.tokenId));
    expect(row?.tokenHash).not.toContain(secret);
    const overview = value(
      await getScimOverview(global(), { userId: t.admin, slug: t.slug, now: NOW, baseUrl: BASE }),
    );
    expect(overview).toMatchObject({
      baseUrl: BASE,
      available: true,
      limit: 2,
      invitationEmails: false,
      lastSyncAt: null,
      pending: 0,
    });
    expect(overview.tokens.map((token) => token.label)).toEqual(["Okta"]);
    expect(await events(t)).toEqual([["scim_token.created", "user"]]);
  });

  it("refuses the plan, other roles, outsiders and a third token", async () => {
    const lower = await team({ plan: "team" });
    const create = (t: Team, userId: string) =>
      createScimToken(global(), {
        userId,
        slug: t.slug,
        body: { label: "x", expiresInDays: 1 },
        now: NOW,
      });
    expect(await create(lower, lower.admin)).toMatchObject({ ok: false, code: "plan_required" });
    const t = await team();
    expect(await create(t, t.editor)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await create(t, await person("x@else.com"))).toMatchObject({
      ok: false,
      code: "not_found",
    });
    value(await create(t, t.admin));
    value(await create(t, t.admin));
    expect(await create(t, t.admin)).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("revokes without a plan, with a tombstone, once", async () => {
    const t = await team();
    const { caller, secret } = await directory(t);
    await global().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    const revoke = () =>
      revokeScimToken(global(), {
        userId: t.admin,
        slug: t.slug,
        tokenId: caller.tokenId,
        now: NOW,
      });
    expect(value(await revoke())).toEqual({ tokenId: caller.tokenId });
    expect(await revoke()).toMatchObject({ ok: false, code: "not_found" });
    expect(await authenticateScimToken(global(), secret, NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({ kind: "scim_token", id: caller.tokenId, deletedAt: NOW });
    expect(
      await revokeScimToken(global(), {
        userId: t.editor,
        slug: t.slug,
        tokenId: caller.tokenId,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("authenticates only its own secrets, until expiry or a lapsed plan, writing last use hourly", async () => {
    const t = await team();
    const { caller, secret } = await directory(t);
    expect(await authenticateScimToken(global(), secret, NOW)).toEqual({ ok: true, ...caller });
    // A service token's shape, a made-up secret and garbage never authenticate here.
    for (const other of [`pfst_${"a".repeat(43)}`, `pfsc_${"a".repeat(43)}`, "Bearer x", ""]) {
      expect(await authenticateScimToken(global(), other, NOW)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    const lastUsed = async () =>
      (
        await global()
          .select({ at: schema.scimTokens.lastUsedAt })
          .from(schema.scimTokens)
          .where(eq(schema.scimTokens.id, caller.tokenId))
      )[0]?.at;
    expect(await lastUsed()).toBe(NOW);
    await authenticateScimToken(global(), secret, NOW + 60_000);
    expect(await lastUsed()).toBe(NOW);
    await authenticateScimToken(global(), secret, NOW + 2 * 3_600_000);
    expect(await lastUsed()).toBe(NOW + 2 * 3_600_000);
    expect(await authenticateScimToken(global(), secret, NOW + 366 * DAY)).toEqual({
      ok: false,
      reason: "expired",
    });
    await global()
      .update(schema.ownerPlans)
      .set({ plan: "team" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    expect(await authenticateScimToken(global(), secret, NOW)).toMatchObject({
      ok: false,
      reason: "plan",
    });
  });

  it("lets the operator find a leaked secret and revoke it", async () => {
    const t = await team();
    const { caller, secret } = await directory(t);
    expect(await findScimToken(global(), `${secret}\n`)).toMatchObject({
      id: caller.tokenId,
      workspaceId: t.id,
      label: "Okta",
    });
    expect(await findScimToken(global(), "nope")).toBeNull();
    expect(await operatorRevokeScimToken(global(), caller.tokenId, NOW)).toBe(true);
    expect(await operatorRevokeScimToken(global(), caller.tokenId, NOW)).toBe(false);
    expect(await events(t)).toContainEqual(["scim_token.revoked", "operator"]);
  });

  it("counts requests per token and per workspace", async () => {
    const t = await team();
    const { caller } = await directory(t);
    for (let i = 0; i < 300; i += 1) {
      expect(await hitScimRateLimit(global(), caller, NOW)).toBe(true);
    }
    expect(await hitScimRateLimit(global(), caller, NOW)).toBe(false);
    expect(await hitScimRateLimit(global(), caller, NOW + 61_000)).toBe(true);
  });

  it("changes the invitation email setting for admins, recording only a change", async () => {
    const t = await team();
    const set = (on: boolean, userId = t.admin) =>
      updateScimSettings(global(), {
        userId,
        slug: t.slug,
        body: { invitationEmails: on },
        now: NOW,
      });
    expect(value(await set(true))).toEqual({ invitationEmails: true });
    expect(value(await set(true))).toEqual({ invitationEmails: true });
    expect(value(await set(false))).toEqual({ invitationEmails: false });
    expect(await set(true, t.editor)).toMatchObject({ ok: false, code: "forbidden" });
    expect((await events(t)).filter(([kind]) => kind === "scim.changed")).toHaveLength(2);
  });
});

describe("provisioning", () => {
  it("gives an address without an account a pending membership that holds a seat", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const email = `new@${t.domain}`;
    const written = ok(await createScimUser(global(), NO_EMAIL, caller, user(email), NOW));
    expect(written.ended).toBeNull();
    expect(written.user).toMatchObject({ email, active: true, names: { givenName: "Ada" } });
    expect(written.user.id).toMatch(/^su_[0-9a-f]{32}$/);
    expect(await pending(t, email)).toMatchObject({
      source: "directory",
      role: "member",
      expiresAt: directoryPendingExpiry(NOW),
    });
    expect(await events(t)).toContainEqual(["member.provisioned", "directory"]);
    expect(ok(await getScimUser(global(), caller, written.user.id)).email).toBe(email);
    const overview = value(
      await getScimOverview(global(), { userId: t.admin, slug: t.slug, now: NOW, baseUrl: BASE }),
    );
    expect(overview.pending).toBe(1);
    // A repeated create for the same address is the RFC's uniqueness conflict.
    expect(
      await createScimUser(global(), NO_EMAIL, caller, user(email.toUpperCase()), NOW),
    ).toEqual({
      ok: false,
      error: { status: 409, scimType: "uniqueness", detail: expect.any(String) },
    });
  });

  it("makes an existing account a member at once, looking the same to the directory", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const existing = await person(`known@${t.domain}`);
    const member = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`known@${t.domain}`), NOW),
    );
    const stranger = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`unknown@${t.domain}`), NOW),
    );
    expect(await role(t, existing)).toBe("member");
    expect(await pending(t, `known@${t.domain}`)).toBeNull();
    expect(Object.keys(member.user).sort()).toEqual(Object.keys(stranger.user).sort());
    expect(await events(t)).toContainEqual(["member.joined", "directory"]);
  });

  it("keeps an existing member's role", async () => {
    const t = await team();
    const { caller } = await directory(t);
    ok(await createScimUser(global(), NO_EMAIL, caller, user(`editor@${t.domain}`), NOW));
    expect(await role(t, t.editor)).toBe("editor");
  });

  it("refuses addresses outside the workspace's verified domains, writing nothing", async () => {
    const t = await team();
    const { caller } = await directory(t);
    for (const email of ["a@gmail.com", `a@sub.${t.domain}`]) {
      expect(await createScimUser(global(), NO_EMAIL, caller, user(email), NOW)).toMatchObject({
        ok: false,
        error: { status: 400, scimType: "invalidValue" },
      });
    }
    expect(
      (await listScimUsers(global(), caller, { filter: null, startIndex: 1, count: 10 })).total,
    ).toBe(0);
  });

  it("refuses beyond the seats without writing half of it", async () => {
    const t = await team({ seats: 2 });
    const { caller } = await directory(t);
    expect(
      await createScimUser(global(), NO_EMAIL, caller, user(`third@${t.domain}`), NOW),
    ).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await pending(t, `third@${t.domain}`)).toBeNull();
    expect(
      (await listScimUsers(global(), caller, { filter: null, startIndex: 1, count: 10 })).total,
    ).toBe(0);
  });

  it("answers 401 when the token went between the read and the write", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const raced = raceGlobalBeforeFirstWrite(async () => {
      await global().delete(schema.scimTokens).where(eq(schema.scimTokens.id, caller.tokenId));
    });
    expect(
      await createScimUser(raced, NO_EMAIL, caller, user(`late@${t.domain}`), NOW),
    ).toMatchObject({
      ok: false,
      error: { status: 401 },
    });
    expect(await pending(t, `late@${t.domain}`)).toBeNull();
  });

  it("lists with filters and bounded pages, and hides other workspaces' users", async () => {
    const t = await team();
    const { caller } = await directory(t);
    for (const [i, name] of ["a", "b", "c"].entries()) {
      ok(
        await createScimUser(
          global(),
          NO_EMAIL,
          caller,
          user(`${name}@${t.domain}`, { externalId: `x${i}` }),
          NOW + i,
        ),
      );
    }
    const page = await listScimUsers(global(), caller, { filter: null, startIndex: 2, count: 1 });
    expect(page.total).toBe(3);
    expect(page.users.map((u) => u.email)).toEqual([`b@${t.domain}`]);
    expect(
      (await listScimUsers(global(), caller, { filter: null, startIndex: 1, count: 0 })).users,
    ).toEqual([]);
    const byName = await listScimUsers(global(), caller, {
      filter: { attribute: "userName", value: `c@${t.domain}` },
      startIndex: 1,
      count: 10,
    });
    expect(byName.users.map((u) => u.externalId)).toEqual(["x2"]);
    const byExternal = await listScimUsers(global(), caller, {
      filter: { attribute: "externalId", value: "x0" },
      startIndex: 1,
      count: 10,
    });
    expect(byExternal.users.map((u) => u.email)).toEqual([`a@${t.domain}`]);
    const other = await team();
    const foreign = await directory(other);
    const id = page.users[0]?.id ?? "";
    expect(await getScimUser(global(), foreign.caller, id)).toMatchObject({
      error: { status: 404 },
    });
    expect(
      await patchScimUser(global(), NO_EMAIL, foreign.caller, id, deactivate, NOW),
    ).toMatchObject({ error: { status: 404 } });
    expect(
      await replaceScimUser(global(), NO_EMAIL, foreign.caller, id, user(`b@${t.domain}`), NOW),
    ).toMatchObject({ error: { status: 404 } });
    expect(await deleteScimUser(global(), foreign.caller, id, NOW, END)).toMatchObject({
      error: { status: 404 },
    });
    expect(
      (await listScimUsers(global(), foreign.caller, { filter: null, startIndex: 1, count: 10 }))
        .total,
    ).toBe(0);
  });

  it("moves a pending membership when the directory changes the address", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const created = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`old@${t.domain}`), NOW),
    );
    const patched = ok(
      await patchScimUser(
        global(),
        NO_EMAIL,
        caller,
        created.user.id,
        { Operations: [{ op: "replace", path: "userName", value: `new@${t.domain}` }] },
        NOW + 1,
      ),
    );
    expect(patched.user.email).toBe(`new@${t.domain}`);
    expect(await pending(t, `old@${t.domain}`)).toBeNull();
    expect(await pending(t, `new@${t.domain}`)).toMatchObject({ source: "directory" });
    const second = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`other@${t.domain}`), NOW),
    );
    expect(
      await replaceScimUser(
        global(),
        NO_EMAIL,
        caller,
        second.user.id,
        user(`new@${t.domain}`),
        NOW,
      ),
    ).toMatchObject({ error: { status: 409, scimType: "uniqueness" } });
    expect(
      await patchScimUser(global(), NO_EMAIL, caller, second.user.id, { Operations: [] }, NOW),
    ).toMatchObject({ error: { scimType: "invalidSyntax" } });
  });

  it("emails the invitation only when the workspace turned it on", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const send = vi.fn(async () => {});
    ok(
      await createScimUser(global(), { sender: { send } }, caller, user(`quiet@${t.domain}`), NOW),
    );
    expect(send).not.toHaveBeenCalled();
    value(
      await updateScimSettings(global(), {
        userId: t.admin,
        slug: t.slug,
        body: { invitationEmails: true },
        now: NOW,
      }),
    );
    ok(await createScimUser(global(), { sender: { send } }, caller, user(`told@${t.domain}`), NOW));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: `told@${t.domain}`, workspaceName: "Corp", role: "member" }),
    );
    // A failed send leaves the pending membership standing.
    const failing = { send: vi.fn(async () => Promise.reject(new Error("down"))) };
    ok(await createScimUser(global(), { sender: failing }, caller, user(`lost@${t.domain}`), NOW));
    expect(await pending(t, `lost@${t.domain}`)).not.toBeNull();
  });
});

describe("deactivation and deletion", () => {
  it("removes the member, blocks single sign-on, tombstones the membership and ends sessions", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const ada = await person(`ada@${t.domain}`);
    const created = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`ada@${t.domain}`), NOW),
    );
    const off = ok(
      await patchScimUser(global(), NO_EMAIL, caller, created.user.id, deactivate, NOW + 1),
    );
    expect(off.user.active).toBe(false);
    expect(off.ended).toBe(ada);
    expect(await role(t, ada)).toBeNull();
    expect(await events(t)).toContainEqual(["member.removed", "directory"]);
    expect(await exportTombstones(regionsFromEnv(env))).toContainEqual({
      kind: "workspace_member",
      id: `${t.id}:${ada}`,
      deletedAt: NOW + 1,
    });
    expect(
      await joinWorkspaceThroughSso(global(), {
        workspaceId: t.id,
        userId: ada,
        email: `ada@${t.domain}`,
        now: NOW + 2,
        consumeInvitation: true,
      }),
    ).toMatchObject({ ok: false, message: "sso_removed" });
    // Deactivating again removes nobody, so it ends no session.
    const again = ok(
      await patchScimUser(global(), NO_EMAIL, caller, created.user.id, deactivate, NOW + 3),
    );
    expect(again.ended).toBeNull();
    // Reactivating brings them back and lifts the block.
    ok(await patchScimUser(global(), NO_EMAIL, caller, created.user.id, reactivate, NOW + 4));
    expect(await role(t, ada)).toBe("member");
    const removals = await global()
      .select()
      .from(schema.workspaceRemovals)
      .where(eq(schema.workspaceRemovals.workspaceId, t.id));
    expect(removals).toEqual([]);
  });

  it("deactivates even after the domain lapsed", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const ada = await person(`ada@${t.domain}`);
    const created = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`ada@${t.domain}`), NOW),
    );
    await global()
      .delete(schema.workspaceDomains)
      .where(eq(schema.workspaceDomains.workspaceId, t.id));
    const off = ok(
      await patchScimUser(global(), NO_EMAIL, caller, created.user.id, deactivate, NOW + 2),
    );
    expect(off.ended).toBe(ada);
    expect(await role(t, ada)).toBeNull();
    expect(
      await patchScimUser(global(), NO_EMAIL, caller, created.user.id, reactivate, NOW + 3),
    ).toMatchObject({ ok: false, error: { status: 400, scimType: "invalidValue" } });
  });

  it("refuses to remove the last admin, with a SCIM error that says why", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const created = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`admin@${t.domain}`), NOW),
    );
    expect(
      await patchScimUser(global(), NO_EMAIL, caller, created.user.id, deactivate, NOW),
    ).toMatchObject({ ok: false, error: { status: 400, scimType: "mutability" } });
    expect(await deleteScimUser(global(), caller, created.user.id, NOW, END)).toMatchObject({
      ok: false,
      error: { status: 400, scimType: "mutability" },
    });
    expect(await role(t, t.admin)).toBe("admin");
    expect(ok(await getScimUser(global(), caller, created.user.id)).active).toBe(true);
  });

  it("withdraws a pending membership, so the person does not join at sign-in", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const email = `later@${t.domain}`;
    const created = ok(await createScimUser(global(), NO_EMAIL, caller, user(email), NOW));
    const off = ok(
      await replaceScimUser(
        global(),
        NO_EMAIL,
        caller,
        created.user.id,
        user(email, { active: false }),
        NOW + 1,
      ),
    );
    expect(off.ended).toBeNull();
    expect(await pending(t, email)).toBeNull();
    const later = await person(email);
    expect(await claimDirectoryMemberships(global(), { userId: later, now: NOW + 2 })).toBe(0);
    expect(await role(t, later)).toBeNull();
  });

  it("keeps the directory's copy when sessions could not be ended, so a retry ends them", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const ada = await person(`ada@${t.domain}`);
    const created = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`ada@${t.domain}`), NOW),
    );
    const failing = async () => {
      throw new Error("down");
    };
    expect(await deleteScimUser(global(), caller, created.user.id, NOW, failing)).toMatchObject({
      ok: false,
      error: { status: 503 },
    });
    expect(await role(t, ada)).toBeNull();
    expect(ok(await getScimUser(global(), caller, created.user.id)).active).toBe(false);
    expect(ok(await deleteScimUser(global(), caller, created.user.id, NOW + 1, END))).toEqual({
      ended: ada,
    });
    // A pending person has no sessions to end.
    const later = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`later@${t.domain}`), NOW),
    );
    expect(ok(await deleteScimUser(global(), caller, later.user.id, NOW, failing))).toEqual({
      ended: null,
    });
  });

  it("deletes the directory's copy with a tombstone and the person leaves", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const ada = await person(`ada@${t.domain}`);
    const created = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`ada@${t.domain}`), NOW),
    );
    expect(ok(await deleteScimUser(global(), caller, created.user.id, NOW + 1, END))).toEqual({
      ended: ada,
    });
    expect(ended).toContain(ada);
    expect(await role(t, ada)).toBeNull();
    expect(await getScimUser(global(), caller, created.user.id)).toMatchObject({
      error: { status: 404 },
    });
    expect(await deleteScimUser(global(), caller, created.user.id, NOW + 2, END)).toMatchObject({
      error: { status: 404 },
    });
    expect(await exportTombstones(regionsFromEnv(env))).toContainEqual({
      kind: "scim_user",
      id: created.user.id,
      deletedAt: NOW + 1,
    });
  });
});

describe("removals by hand", () => {
  it("are not undone by a routine sync, only by an explicit reactivation", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const ada = await person(`ada@${t.domain}`);
    const created = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`ada@${t.domain}`), NOW),
    );
    value(
      await removeMember(global(), { userId: t.admin, slug: t.slug, memberId: ada, now: NOW + 1 }),
    );
    ok(
      await replaceScimUser(
        global(),
        NO_EMAIL,
        caller,
        created.user.id,
        user(`ada@${t.domain}`),
        NOW + 2,
      ),
    );
    expect(await role(t, ada)).toBeNull();
    ok(await patchScimUser(global(), NO_EMAIL, caller, created.user.id, deactivate, NOW + 3));
    ok(await patchScimUser(global(), NO_EMAIL, caller, created.user.id, reactivate, NOW + 4));
    expect(await role(t, ada)).toBe("member");
  });

  it("hold for a pending membership an admin withdrew and for a person who left", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const email = `pending@${t.domain}`;
    const created = ok(await createScimUser(global(), NO_EMAIL, caller, user(email), NOW));
    const invitation = await pending(t, email);
    value(
      await revokeInvitation(global(), {
        userId: t.admin,
        slug: t.slug,
        invitationId: invitation?.id ?? "",
        now: NOW + 1,
      }),
    );
    ok(await replaceScimUser(global(), NO_EMAIL, caller, created.user.id, user(email), NOW + 2));
    expect(await pending(t, email)).toBeNull();

    const bob = await person(`bob@${t.domain}`);
    ok(await createScimUser(global(), NO_EMAIL, caller, user(`bob@${t.domain}`), NOW));
    value(await leaveWorkspace(global(), { userId: bob, slug: t.slug, now: NOW + 1 }));
    const [bobRow] = (
      await listScimUsers(global(), caller, {
        filter: { attribute: "userName", value: `bob@${t.domain}` },
        startIndex: 1,
        count: 1,
      })
    ).users;
    ok(
      await patchScimUser(
        global(),
        NO_EMAIL,
        caller,
        bobRow?.id ?? "",
        { Operations: [{ op: "replace", path: "displayName", value: "Bob" }] },
        NOW + 2,
      ),
    );
    expect(await role(t, bob)).toBeNull();
  });
});

describe("signing in", () => {
  it("turns a pending membership into a membership at the first sign-in", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const email = `soon@${t.domain}`;
    const created = ok(await createScimUser(global(), NO_EMAIL, caller, user(email), NOW));
    const soon = await person(email);
    expect(await claimDirectoryMemberships(global(), { userId: soon, now: NOW + 1 })).toBe(1);
    expect(await claimDirectoryMemberships(global(), { userId: soon, now: NOW + 2 })).toBe(0);
    expect(await role(t, soon)).toBe("member");
    expect(await pending(t, email)).toBeNull();
    const [row] = await global()
      .select({ userId: schema.scimUsers.userId })
      .from(schema.scimUsers)
      .where(eq(schema.scimUsers.id, created.user.id));
    expect(row?.userId).toBe(soon);
    expect(await events(t)).toContainEqual(["member.joined", "user"]);
    // An unverified account claims nothing.
    const unverified = await person(`unverified@${t.domain}`);
    await global()
      .update(schema.users)
      .set({ emailVerified: false })
      .where(eq(schema.users.id, unverified));
    expect(await claimDirectoryMemberships(global(), { userId: unverified, now: NOW })).toBe(0);
  });

  it("through single sign-on gives the membership the directory asked for", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const email = `sso@${t.domain}`;
    ok(await createScimUser(global(), NO_EMAIL, caller, user(email), NOW));
    const signedIn = await person(email);
    const joined = await joinWorkspaceThroughSso(global(), {
      workspaceId: t.id,
      userId: signedIn,
      email,
      now: NOW + 1,
      consumeInvitation: true,
    });
    expect(joined).toMatchObject({ ok: true, value: { joined: true, role: "member" } });
    expect(await pending(t, email)).toBeNull();
  });
});

describe("races", () => {
  it("makes one user of two concurrent creates for the same address", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const email = `twice@${t.domain}`;
    const raced = raceGlobalBeforeFirstWrite(async () => {
      ok(await createScimUser(global(), NO_EMAIL, caller, user(email), NOW));
    });
    expect(await createScimUser(raced, NO_EMAIL, caller, user(email), NOW)).toMatchObject({
      ok: false,
      error: { status: 409, scimType: "uniqueness" },
    });
    const listed = await listScimUsers(global(), caller, {
      filter: null,
      startIndex: 1,
      count: 10,
    });
    expect(listed.total).toBe(1);
  });

  it("removes a person who signed in while the directory deactivated them", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const email = `racing@${t.domain}`;
    const created = ok(await createScimUser(global(), NO_EMAIL, caller, user(email), NOW));
    const racer = await person(email);
    const raced = raceGlobalBeforeFirstWrite(async () => {
      expect(await claimDirectoryMemberships(global(), { userId: racer, now: NOW + 1 })).toBe(1);
    });
    const off = ok(
      await patchScimUser(raced, NO_EMAIL, caller, created.user.id, deactivate, NOW + 2),
    );
    expect(off.ended).toBe(racer);
    expect(await role(t, racer)).toBeNull();
  });

  it("lets only one of two concurrent writes to the same user apply", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const created = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`one@${t.domain}`), NOW),
    );
    const raced = raceGlobalBeforeFirstWrite(async () => {
      ok(await patchScimUser(global(), NO_EMAIL, caller, created.user.id, deactivate, NOW + 1));
    });
    expect(
      await patchScimUser(
        raced,
        NO_EMAIL,
        caller,
        created.user.id,
        { Operations: [{ op: "replace", path: "displayName", value: "x" }] },
        NOW + 2,
      ),
    ).toMatchObject({ ok: false, error: { status: 409 } });
  });
});

describe("restores and pruning", () => {
  it("removes again after a restore a membership and a pending row the directory ended", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const ada = await person(`ada@${t.domain}`);
    const member = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`ada@${t.domain}`), NOW),
    );
    const pendingUser = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`p@${t.domain}`), NOW),
    );
    const invitation = await pending(t, `p@${t.domain}`);
    ok(await patchScimUser(global(), NO_EMAIL, caller, member.user.id, deactivate, NOW + 1));
    ok(await patchScimUser(global(), NO_EMAIL, caller, pendingUser.user.id, deactivate, NOW + 1));
    const markers = await exportTombstones(regionsFromEnv(env));
    // A D1 Time Travel restore to before the deactivation brings back both rows and no removal.
    await global().delete(schema.tombstones);
    await global()
      .delete(schema.workspaceRemovals)
      .where(eq(schema.workspaceRemovals.workspaceId, t.id));
    await global()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: ada, role: "member", createdAt: NOW, updatedAt: NOW });
    if (invitation) await global().insert(schema.workspaceInvitations).values(invitation);
    const result = await applyTombstones(global(), markers, NOW + 2);
    expect(result).toMatchObject({ members: 1, invitations: 1 });
    expect(await role(t, ada)).toBeNull();
    expect(await pending(t, `p@${t.domain}`)).toBeNull();
    const removals = await global()
      .select({ userId: schema.workspaceRemovals.userId })
      .from(schema.workspaceRemovals)
      .where(eq(schema.workspaceRemovals.workspaceId, t.id));
    expect(removals).toEqual([{ userId: ada }]);
    // A membership newer than the tombstone survives a second run.
    await global()
      .delete(schema.workspaceRemovals)
      .where(eq(schema.workspaceRemovals.workspaceId, t.id));
    await global()
      .insert(schema.workspaceMembers)
      .values({
        workspaceId: t.id,
        userId: ada,
        role: "member",
        createdAt: NOW + 5,
        updatedAt: NOW + 5,
      });
    expect((await applyTombstones(global(), markers, NOW + 6)).members).toBe(0);
    expect(await role(t, ada)).toBe("member");
  });

  it("deletes a revoked token and a deleted directory user again after a restore", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const created = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`gone@${t.domain}`), NOW),
    );
    const [tokenRow] = await global()
      .select()
      .from(schema.scimTokens)
      .where(eq(schema.scimTokens.id, caller.tokenId));
    const [userRow] = await global()
      .select()
      .from(schema.scimUsers)
      .where(eq(schema.scimUsers.id, created.user.id));
    ok(await deleteScimUser(global(), caller, created.user.id, NOW, END));
    expect(await operatorRevokeScimToken(global(), caller.tokenId, NOW)).toBe(true);
    const markers = await exportTombstones(regionsFromEnv(env));
    if (tokenRow) await global().insert(schema.scimTokens).values(tokenRow);
    if (userRow) await global().insert(schema.scimUsers).values(userRow);
    expect(await applyTombstones(global(), markers, NOW + 1)).toMatchObject({
      scimTokens: 1,
      scimUsers: 1,
    });
  });

  it("forgets people who never signed in once their pending row lapsed", async () => {
    const t = await team();
    const { caller } = await directory(t);
    ok(await createScimUser(global(), NO_EMAIL, caller, user(`stale@${t.domain}`), NOW));
    const linked = await person(`linked@${t.domain}`);
    ok(await createScimUser(global(), NO_EMAIL, caller, user(`linked@${t.domain}`), NOW));
    await pruneDirectoryUsers(global(), NOW + DAY);
    expect(
      (await listScimUsers(global(), caller, { filter: null, startIndex: 1, count: 10 })).total,
    ).toBe(2);
    const later = directoryPendingExpiry(NOW) + DAY;
    expect(await pruneDirectoryUsers(global(), later)).toBeGreaterThanOrEqual(1);
    const left = await listScimUsers(global(), caller, { filter: null, startIndex: 1, count: 10 });
    expect(left.users.map((u) => u.email)).toEqual([`linked@${t.domain}`]);
    expect(await role(t, linked)).toBe("member");
  });

  it("keeps the directory's copy when the account is deleted, without the link", async () => {
    const t = await team();
    const { caller } = await directory(t);
    const ada = await person(`ada@${t.domain}`);
    const created = ok(
      await createScimUser(global(), NO_EMAIL, caller, user(`ada@${t.domain}`), NOW),
    );
    await global().delete(schema.users).where(eq(schema.users.id, ada));
    const [row] = await global()
      .select({ userId: schema.scimUsers.userId })
      .from(schema.scimUsers)
      .where(eq(schema.scimUsers.id, created.user.id));
    expect(row).toEqual({ userId: null });
  });
});
