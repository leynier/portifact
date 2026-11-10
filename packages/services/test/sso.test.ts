// Single sign-on for a workspace (premium plan E1, decision 0016): managing the provider, the
// lookups a sign-in makes, what an identity may assert, joining the workspace, sealing, the
// identity provider's answers and what a removal and a restore do.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { inviteMember } from "../src/invitations.ts";
import {
  checkSsoIdentity,
  clearSsoDiscoveryCache,
  discoverSso,
  fetchSsoJson,
  getSsoSettings,
  joinWorkspaceThroughSso,
  removeSsoProvider,
  SSO_CACHE_ENTRIES,
  type SsoFetch,
  saveSsoProvider,
  ssoAccountProvider,
  ssoDiscoveryCacheSize,
  ssoProviderForCallback,
  ssoProviderForEmail,
  testSsoIssuer,
} from "../src/sso.ts";
import { openSsoSecret, sealSsoSecret, ssoKeys } from "../src/sso-keys.ts";
import {
  advanceWorkspaceDeletion,
  deleteWorkspace,
  leaveWorkspace,
  removeMember,
} from "../src/workspaces.ts";
import { db, grantPlan, NOW, value } from "./fixtures.ts";

const hex = () => crypto.randomUUID().replaceAll("-", "");
const global = () => db().global;
const KEYS = await ssoKeys({ current: "test-only single sign-on sealing key, 32+ chars" });

function discovery(issuer: string, overrides: Record<string, unknown> = {}) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/keys`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    id_token_signing_alg_values_supported: ["RS256"],
    ...overrides,
  };
}

/** A fake identity provider's discovery: the document for every issuer it was told about. */
function idp(docs: Record<string, unknown> = {}): SsoFetch & { calls: string[] } {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const issuer = url.replace("/.well-known/openid-configuration", "");
    const doc = docs[issuer] ?? discovery(issuer);
    return Response.json(doc);
  };
  return Object.assign(fetch, { calls });
}

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
  issuer: string;
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
  return { id, slug, domain, issuer: `https://login.${domain}`, admin, editor } satisfies Team;
}

async function setUp(t: Team, fetch: SsoFetch = idp()) {
  return value(
    await saveSsoProvider(
      global(),
      { keys: KEYS, fetch },
      {
        userId: t.admin,
        slug: t.slug,
        issuer: t.issuer,
        clientId: "client-1",
        clientSecret: "secret-1",
        domains: [t.domain],
        now: NOW,
      },
    ),
  );
}

/** The workspace's audit events as written, oldest first. */
async function kinds(t: Team) {
  const rows = await global()
    .select({ kind: schema.auditEvents.kind, detail: schema.auditEvents.detail })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.ownerId, t.id))
    .orderBy(schema.auditEvents.at);
  return rows.map(
    (row) =>
      [row.kind, typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail] as const,
  );
}

beforeEach(() => clearSsoDiscoveryCache());

describe("setting up the provider", () => {
  it("creates it for an admin on Enterprise, sealing the secret, and records it without secrets", async () => {
    const t = await team();
    const fetch = idp();
    const provider = await setUp(t, fetch);
    expect(provider).toMatchObject({ issuer: t.issuer, clientId: "client-1", domains: [t.domain] });
    expect(provider.id).toMatch(/^sso_[0-9a-f]{32}$/);
    expect(fetch.calls).toEqual([`${t.issuer}/.well-known/openid-configuration`]);
    const [row] = await global()
      .select()
      .from(schema.workspaceSso)
      .where(eq(schema.workspaceSso.id, provider.id));
    expect(row?.clientSecretSealed).not.toContain("secret-1");
    expect(
      await openSsoSecret(KEYS, row?.secretKeyId ?? "", t.id, row?.clientSecretSealed ?? ""),
    ).toBe("secret-1");
    // Sealed for this workspace: the same box does not open for another.
    expect(
      await openSsoSecret(
        KEYS,
        row?.secretKeyId ?? "",
        `ws_${hex()}`,
        row?.clientSecretSealed ?? "",
      ),
    ).toBeNull();
    const settings = value(
      await getSsoSettings(global(), { userId: t.admin, slug: t.slug, now: NOW }),
    );
    expect(settings).toMatchObject({ state: "on", available: true, verifiedDomains: [t.domain] });
    expect(JSON.stringify(settings)).not.toContain("secret-1");
    expect(await kinds(t)).toContainEqual([
      "sso.created",
      { issuerHost: `login.${t.domain}`, domains: 1 },
    ]);
  });

  it("changes the client and domains, keeps the secret when omitted, and refuses a new issuer", async () => {
    const t = await team();
    const created = await setUp(t);
    const changed = value(
      await saveSsoProvider(
        global(),
        { keys: KEYS, fetch: idp() },
        {
          userId: t.admin,
          slug: t.slug,
          issuer: t.issuer,
          clientId: "client-2",
          domains: [t.domain],
          now: NOW + 1,
        },
      ),
    );
    expect(changed).toMatchObject({ id: created.id, clientId: "client-2", revision: 2 });
    expect(await kinds(t)).toContainEqual(["sso.changed", { fields: ["clientId"] }]);
    const same = value(
      await saveSsoProvider(
        global(),
        { keys: KEYS, fetch: idp() },
        {
          userId: t.admin,
          slug: t.slug,
          issuer: t.issuer,
          clientId: "client-2",
          domains: [t.domain],
          now: NOW + 2,
        },
      ),
    );
    expect(same.revision).toBe(2);
    const moved = await saveSsoProvider(
      global(),
      { keys: KEYS, fetch: idp() },
      {
        userId: t.admin,
        slug: t.slug,
        issuer: "https://other-idp.example.org",
        clientId: "client-2",
        domains: [t.domain],
        now: NOW + 3,
      },
    );
    expect(moved).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("refuses editors, members of other workspaces, a free plan, an unverified domain and no key", async () => {
    const t = await team();
    const input = {
      slug: t.slug,
      issuer: t.issuer,
      clientId: "c",
      clientSecret: "s",
      domains: [t.domain],
      now: NOW,
    };
    const deps = { keys: KEYS, fetch: idp() };
    expect(await saveSsoProvider(global(), deps, { ...input, userId: t.editor })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    const stranger = await person(`x@${hex().slice(0, 8)}.org`);
    expect(await saveSsoProvider(global(), deps, { ...input, userId: stranger })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      await saveSsoProvider(global(), deps, { ...input, userId: t.admin, domains: ["gmail.com"] }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await saveSsoProvider(global(), { ...deps, keys: [] }, { ...input, userId: t.admin }),
    ).toMatchObject({
      ok: false,
      code: "capacity_unavailable",
    });
    expect(
      await saveSsoProvider(global(), deps, { ...input, userId: t.admin, clientSecret: undefined }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const onTeam = await team({ plan: "team" });
    expect(
      await saveSsoProvider(global(), deps, {
        ...input,
        slug: onTeam.slug,
        domains: [onTeam.domain],
        userId: onTeam.admin,
      }),
    ).toMatchObject({ ok: false, code: "plan_required" });
    expect(
      await testSsoIssuer(global(), idp(), {
        userId: onTeam.admin,
        slug: onTeam.slug,
        issuer: onTeam.issuer,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "plan_required" });
  });

  it("refuses an issuer whose discovery fails, in plain words", async () => {
    const t = await team();
    const fetch = idp({ [t.issuer]: discovery("https://somewhere-else.example.org") });
    const result = await saveSsoProvider(
      global(),
      { keys: KEYS, fetch },
      {
        userId: t.admin,
        slug: t.slug,
        issuer: t.issuer,
        clientId: "c",
        clientSecret: "s",
        domains: [t.domain],
        now: NOW,
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "invalid_input",
      message: "The discovery document names a different issuer.",
    });
    expect(
      await saveSsoProvider(
        global(),
        { keys: KEYS, fetch },
        {
          userId: t.admin,
          slug: t.slug,
          issuer: "https://10.0.0.1",
          clientId: "c",
          clientSecret: "s",
          domains: [t.domain],
          now: NOW,
        },
      ),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("tests discovery without storing anything, and reports what failed", async () => {
    const t = await team();
    const ok = value(
      await testSsoIssuer(global(), idp(), {
        userId: t.admin,
        slug: t.slug,
        issuer: t.issuer,
        now: NOW,
      }),
    );
    expect(ok).toEqual({
      ok: true,
      hosts: {
        authorization: `login.${t.domain}`,
        token: `login.${t.domain}`,
        keys: `login.${t.domain}`,
      },
    });
    const bad = value(
      await testSsoIssuer(
        global(),
        idp({ [t.issuer]: discovery(t.issuer, { jwks_uri: "https://169.254.169.254/keys" }) }),
        { userId: t.admin, slug: t.slug, issuer: t.issuer, now: NOW },
      ),
    );
    expect(bad).toEqual({ ok: false, problem: "invalid_endpoint" });
    expect(
      value(
        await testSsoIssuer(global(), idp(), {
          userId: t.admin,
          slug: t.slug,
          issuer: "http://x.com",
          now: NOW,
        }),
      ),
    ).toEqual({ ok: false, problem: "invalid_issuer" });
    expect(
      await testSsoIssuer(global(), idp(), {
        userId: t.editor,
        slug: t.slug,
        issuer: t.issuer,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    const settings = value(
      await getSsoSettings(global(), { userId: t.admin, slug: t.slug, now: NOW }),
    );
    expect(settings.state).toBe("off");
    expect(settings.provider).toBeNull();
  });

  it("rate limits discovery calls per workspace", async () => {
    const t = await team();
    const input = { userId: t.admin, slug: t.slug, issuer: t.issuer, now: NOW };
    for (let i = 0; i < 30; i += 1)
      expect((await testSsoIssuer(global(), idp(), input)).ok).toBe(true);
    expect(await testSsoIssuer(global(), idp(), input)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
  });
});

describe("removing the provider", () => {
  it("removes it whatever the plan, with its linked identities and a tombstone a restore honors", async () => {
    const t = await team();
    const provider = await setUp(t);
    const linked = await person(`ada@${t.domain}`);
    await global()
      .insert(schema.accounts)
      .values({
        id: `acc_${hex()}`,
        accountId: "subject-ada",
        providerId: ssoAccountProvider(provider.id),
        userId: linked,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      });
    const exported = await exportTombstones(regionsFromEnv(env));
    // The plan lapses: removing still works.
    await global().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    expect(
      await removeSsoProvider(global(), { userId: t.editor, slug: t.slug, now: NOW }),
    ).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    value(await removeSsoProvider(global(), { userId: t.admin, slug: t.slug, now: NOW }));
    expect(
      await global()
        .select()
        .from(schema.workspaceSso)
        .where(eq(schema.workspaceSso.workspaceId, t.id)),
    ).toEqual([]);
    expect(
      await global()
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.providerId, ssoAccountProvider(provider.id))),
    ).toEqual([]);
    // The person keeps their account and membership is untouched.
    expect(
      await global().select().from(schema.users).where(eq(schema.users.id, linked)),
    ).toHaveLength(1);
    expect(
      await removeSsoProvider(global(), { userId: t.admin, slug: t.slug, now: NOW }),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({ kind: "workspace_sso", id: provider.id, deletedAt: NOW });
    expect(exported.some((marker) => marker.id === provider.id)).toBe(false);

    // A restore brings the row and the identity back; the tombstones remove them again.
    await grantPlan(t.id, "enterprise", { seats: 10 });
    await setUp(t);
    await global().delete(schema.workspaceSso).where(eq(schema.workspaceSso.workspaceId, t.id));
    const [restored] = await global()
      .insert(schema.workspaceSso)
      .values({
        id: provider.id,
        workspaceId: t.id,
        issuer: t.issuer,
        clientId: "client-1",
        clientSecretSealed: "x",
        secretKeyId: "y",
        domains: t.domain,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning();
    await global()
      .insert(schema.accounts)
      .values({
        id: `acc_${hex()}`,
        accountId: "subject-ada",
        providerId: ssoAccountProvider(provider.id),
        userId: linked,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      });
    expect(restored?.id).toBe(provider.id);
    const applied = await applyTombstones(global(), markers, NOW);
    expect(applied.ssoProviders).toBeGreaterThanOrEqual(1);
    expect(
      await global()
        .select()
        .from(schema.workspaceSso)
        .where(eq(schema.workspaceSso.id, provider.id)),
    ).toEqual([]);
    expect(
      await global()
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.providerId, ssoAccountProvider(provider.id))),
    ).toEqual([]);
    expect((await kinds(t)).map(([kind]) => kind)).toContain("sso.removed");
  });

  it("goes with its workspace", async () => {
    const t = await team();
    await setUp(t);
    // As the deletion does: its row first, so the last admin's membership can go.
    await global()
      .insert(schema.workspaceDeletions)
      .values({ workspaceId: t.id, requestedAt: NOW });
    await global().delete(schema.workspaces).where(eq(schema.workspaces.id, t.id));
    expect(
      await global()
        .select()
        .from(schema.workspaceSso)
        .where(eq(schema.workspaceSso.workspaceId, t.id)),
    ).toEqual([]);
  });
});

describe("which provider signs an address in", () => {
  it("finds the provider of the workspace that verified the address's exact domain", async () => {
    const t = await team();
    const provider = await setUp(t);
    expect((await ssoProviderForEmail(global(), `Grace@${t.domain.toUpperCase()}`, NOW))?.id).toBe(
      provider.id,
    );
    expect(await ssoProviderForEmail(global(), `grace@eng.${t.domain}`, NOW)).toBeNull();
    expect(await ssoProviderForEmail(global(), "grace@gmail.com", NOW)).toBeNull();
    expect(await ssoProviderForEmail(global(), "not an address", NOW)).toBeNull();
  });

  it("stops at once when the domain lapses, the plan lapses or the provider is removed", async () => {
    const t = await team();
    const provider = await setUp(t);
    const email = `grace@${t.domain}`;
    await global()
      .delete(schema.workspaceDomains)
      .where(eq(schema.workspaceDomains.workspaceId, t.id));
    expect(await ssoProviderForEmail(global(), email, NOW)).toBeNull();
    expect(await ssoProviderForCallback(global(), KEYS, provider.id, 1, NOW)).toBeNull();
    const settings = value(
      await getSsoSettings(global(), { userId: t.admin, slug: t.slug, now: NOW }),
    );
    expect(settings.state).toBe("domains");

    const u = await team();
    const other = await setUp(u);
    await global().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, u.id));
    expect(await ssoProviderForEmail(global(), `grace@${u.domain}`, NOW)).toBeNull();
    expect(await ssoProviderForCallback(global(), KEYS, other.id, 1, NOW)).toBeNull();
    expect(
      value(await getSsoSettings(global(), { userId: u.admin, slug: u.slug, now: NOW })).state,
    ).toBe("plan");
  });

  it("gives the callback the secret only for the revision the sign-in started with and a held key", async () => {
    const t = await team();
    const provider = await setUp(t);
    expect(await ssoProviderForCallback(global(), KEYS, provider.id, 1, NOW)).toMatchObject({
      id: provider.id,
      clientSecret: "secret-1",
      liveDomains: [t.domain],
    });
    expect(await ssoProviderForCallback(global(), KEYS, provider.id, 2, NOW)).toBeNull();
    const rotated = await ssoKeys({ current: "another single sign-on key, long enough to use" });
    expect(await ssoProviderForCallback(global(), rotated, provider.id, 1, NOW)).toBeNull();
    const both = await ssoKeys({
      current: "another single sign-on key, long enough to use",
      previous: "test-only single sign-on sealing key, 32+ chars",
    });
    expect((await ssoProviderForCallback(global(), both, provider.id, 1, NOW))?.clientSecret).toBe(
      "secret-1",
    );
    expect(await ssoProviderForCallback(global(), KEYS, `sso_${hex()}`, 1, NOW)).toBeNull();
  });
});

describe("what an identity may assert", () => {
  it("allows any address in a live domain and refuses one outside", async () => {
    const t = await team();
    await setUp(t);
    const provider = await ssoProviderForEmail(global(), `a@${t.domain}`, NOW);
    if (!provider) throw new Error("no provider");
    const facts = { emailVerified: undefined, sessionUserId: null };
    expect(
      await checkSsoIdentity(global(), {
        provider,
        email: `someone@${t.domain}`,
        subject: "s1",
        ...facts,
      }),
    ).toEqual({ ok: true, value: { mode: "create", userId: null, consumeInvitation: true } });
    expect(
      await checkSsoIdentity(global(), {
        provider,
        email: "victim@gmail.com",
        subject: "s1",
        ...facts,
      }),
    ).toMatchObject({
      ok: false,
      message: "sso_email_outside_domain",
    });
  });

  it("refuses an identity linked to an account whose address left the domains", async () => {
    const t = await team();
    await setUp(t);
    const provider = await ssoProviderForEmail(global(), `a@${t.domain}`, NOW);
    if (!provider) throw new Error("no provider");
    const elsewhere = await person(`moved@${hex().slice(0, 8)}.org`);
    await global()
      .insert(schema.accounts)
      .values({
        id: `acc_${hex()}`,
        accountId: "subject-moved",
        providerId: ssoAccountProvider(provider.id),
        userId: elsewhere,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      });
    expect(
      await checkSsoIdentity(global(), {
        provider,
        email: `moved@${t.domain}`,
        subject: "subject-moved",
        emailVerified: true,
        sessionUserId: null,
      }),
    ).toMatchObject({ ok: false, message: "sso_email_outside_domain" });
  });
});

describe("joining through single sign-on", () => {
  it("adds a member once, records how, and keeps an existing member's role", async () => {
    const t = await team();
    const ada = await person(`ada@${t.domain}`);
    const input = {
      workspaceId: t.id,
      userId: ada,
      email: `ada@${t.domain}`,
      now: NOW,
      consumeInvitation: true,
    };
    expect(value(await joinWorkspaceThroughSso(global(), input))).toEqual({
      joined: true,
      role: "member",
      pendingInvitation: false,
    });
    expect(value(await joinWorkspaceThroughSso(global(), input))).toEqual({
      joined: false,
      role: "member",
      pendingInvitation: false,
    });
    expect(value(await joinWorkspaceThroughSso(global(), { ...input, userId: t.editor }))).toEqual({
      joined: false,
      role: "editor",
      pendingInvitation: false,
    });
    const joined = (await kinds(t)).filter(([kind]) => kind === "member.joined");
    expect(joined).toEqual([["member.joined", { role: "member", via: "sso" }]]);
  });

  it("consumes a pending invitation with its role, its seat being the one taken", async () => {
    const t = await team({ seats: 3 });
    const ada = await person(`ada@${t.domain}`);
    await global()
      .insert(schema.workspaceInvitations)
      .values({
        id: `inv_${hex()}`,
        workspaceId: t.id,
        email: `ada@${t.domain}`,
        role: "editor",
        tokenHash: hex(),
        invitedBy: t.admin,
        createdAt: NOW,
        expiresAt: NOW + 86_400_000,
      });
    // Two members and one invitation fill the three seats; the invited person still joins.
    expect(
      value(
        await joinWorkspaceThroughSso(global(), {
          workspaceId: t.id,
          userId: ada,
          email: `Ada@${t.domain}`,
          now: NOW,
          consumeInvitation: true,
        }),
      ),
    ).toEqual({ joined: true, role: "editor", pendingInvitation: false });
    expect(
      await global()
        .select()
        .from(schema.workspaceInvitations)
        .where(eq(schema.workspaceInvitations.workspaceId, t.id)),
    ).toEqual([]);
  });

  it("refuses the join when the workspace is full, counting pending invitations", async () => {
    const t = await team({ seats: 3 });
    await global()
      .insert(schema.workspaceInvitations)
      .values({
        id: `inv_${hex()}`,
        workspaceId: t.id,
        email: `someone-else@${t.domain}`,
        role: "member",
        tokenHash: hex(),
        invitedBy: t.admin,
        createdAt: NOW,
        expiresAt: NOW + 86_400_000,
      });
    const ada = await person(`ada@${t.domain}`);
    expect(
      await joinWorkspaceThroughSso(global(), {
        workspaceId: t.id,
        userId: ada,
        email: `ada@${t.domain}`,
        now: NOW,
        consumeInvitation: true,
      }),
    ).toMatchObject({ ok: false, code: "seats_exhausted" });
    expect(
      await global()
        .select()
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, t.id),
            eq(schema.workspaceMembers.userId, ada),
          ),
        ),
    ).toEqual([]);
  });
});

describe("the identity provider's answers", () => {
  const respond =
    (response: Response | Error): SsoFetch =>
    async () => {
      if (response instanceof Error) throw response;
      return response;
    };

  it("parses JSON and refuses redirects, errors, oversized, non-JSON and failed answers", async () => {
    expect(await fetchSsoJson(respond(Response.json({ a: 1 })), "https://x.example.com")).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(
      await fetchSsoJson(
        respond(new Response(null, { status: 302, headers: { location: "https://10.0.0.1" } })),
        "https://x.example.com",
      ),
    ).toMatchObject({ ok: false, problem: "redirect" });
    expect(
      await fetchSsoJson(respond(new Response("{}", { status: 500 })), "https://x.example.com"),
    ).toMatchObject({
      ok: false,
      problem: "http_error",
      status: 500,
    });
    expect(
      await fetchSsoJson(respond(new Response("x".repeat(64 * 1024 + 1))), "https://x.example.com"),
    ).toMatchObject({ ok: false, problem: "too_large" });
    expect(
      await fetchSsoJson(respond(new Response("<html>")), "https://x.example.com"),
    ).toMatchObject({
      ok: false,
      problem: "not_json",
    });
    expect(
      await fetchSsoJson(respond(new TypeError("network")), "https://x.example.com"),
    ).toMatchObject({
      ok: false,
      problem: "unreachable",
    });
    expect(await fetchSsoJson(respond(new Response(null)), "https://x.example.com")).toMatchObject({
      ok: false,
      problem: "not_json",
    });
  });

  it("gives up on an answer that never ends", async () => {
    const slow: SsoFetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
      );
    const started = Date.now();
    expect(await fetchSsoJson(slow, "https://x.example.com")).toMatchObject({
      ok: false,
      problem: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("seals with the current key and opens with a previous one during a rotation", async () => {
    const [key] = KEYS;
    if (!key) throw new Error("no key");
    const box = await sealSsoSecret(key, "ws_a", "s3cret");
    expect(await openSsoSecret(KEYS, key.id, "ws_a", box)).toBe("s3cret");
    expect(await openSsoSecret(KEYS, "unknown", "ws_a", box)).toBeNull();
    expect(await openSsoSecret(KEYS, key.id, "ws_a", `${box.slice(0, -4)}AAAA`)).toBeNull();
    expect(await ssoKeys({ current: "short" })).toEqual([]);
    expect(await ssoKeys({ current: undefined })).toEqual([]);
  });
});

async function addAccount(userId: string, providerId: string, accountId: string) {
  await global()
    .insert(schema.accounts)
    .values({
      id: `acc_${hex()}`,
      accountId,
      providerId,
      userId,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
}

async function ssoAccounts(providerId: string) {
  return global()
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.providerId, ssoAccountProvider(providerId)));
}

describe("which account an identity signs in to (review finding 1)", () => {
  it("links an existing account only on a verified claim or from its own session", async () => {
    const t = await team();
    await setUp(t);
    const provider = await ssoProviderForEmail(global(), `a@${t.domain}`, NOW);
    if (!provider) throw new Error("no provider");
    const base = { provider, email: `admin@${t.domain}`, subject: "new-subject" };
    expect(
      await checkSsoIdentity(global(), { ...base, emailVerified: undefined, sessionUserId: null }),
    ).toMatchObject({ ok: false, message: "sso_link_required" });
    expect(
      value(
        await checkSsoIdentity(global(), { ...base, emailVerified: true, sessionUserId: null }),
      ),
    ).toEqual({ mode: "link", userId: t.admin, consumeInvitation: true });
    expect(
      value(
        await checkSsoIdentity(global(), {
          ...base,
          emailVerified: undefined,
          sessionUserId: t.admin,
        }),
      ),
    ).toEqual({ mode: "session", userId: t.admin, consumeInvitation: false });
    expect(
      await checkSsoIdentity(global(), {
        ...base,
        emailVerified: undefined,
        sessionUserId: t.editor,
      }),
    ).toMatchObject({ ok: false, message: "sso_link_required" });
  });
});

describe("a removal holds against single sign-on (review finding 2)", () => {
  const join = (t: Team, userId: string, email: string, now = NOW) =>
    joinWorkspaceThroughSso(global(), {
      workspaceId: t.id,
      userId,
      email,
      now,
      consumeInvitation: true,
    });

  it("refuses the join of someone an admin removed until an admin invites them again", async () => {
    const t = await team();
    value(
      await removeMember(global(), { userId: t.admin, slug: t.slug, memberId: t.editor, now: NOW }),
    );
    expect(await join(t, t.editor, `editor@${t.domain}`)).toMatchObject({
      ok: false,
      code: "forbidden",
      message: "sso_removed",
    });
    value(
      await inviteMember(
        global(),
        {
          userId: t.admin,
          slug: t.slug,
          email: `editor@${t.domain}`,
          role: "member",
          now: NOW + 1,
        },
        { send: async () => {} },
      ),
    );
    expect(value(await join(t, t.editor, `editor@${t.domain}`, NOW + 2))).toEqual({
      joined: true,
      role: "member",
      pendingInvitation: false,
    });
  });

  it("lets someone who left by themselves rejoin", async () => {
    const t = await team();
    value(await leaveWorkspace(global(), { userId: t.editor, slug: t.slug, now: NOW }));
    expect(value(await join(t, t.editor, `editor@${t.domain}`)).joined).toBe(true);
  });

  it("goes with the workspace and with the account", async () => {
    const t = await team();
    value(
      await removeMember(global(), { userId: t.admin, slug: t.slug, memberId: t.editor, now: NOW }),
    );
    const removals = () =>
      global()
        .select()
        .from(schema.workspaceRemovals)
        .where(eq(schema.workspaceRemovals.workspaceId, t.id));
    expect(await removals()).toHaveLength(1);
    await global().delete(schema.users).where(eq(schema.users.id, t.editor));
    expect(await removals()).toEqual([]);

    const u = await team();
    value(
      await removeMember(global(), { userId: u.admin, slug: u.slug, memberId: u.editor, now: NOW }),
    );
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: u.id, now: NOW }));
    expect(
      await global()
        .select()
        .from(schema.workspaceRemovals)
        .where(eq(schema.workspaceRemovals.workspaceId, u.id)),
    ).toEqual([]);
  });
});

describe("pending invitations and single sign-on (review finding 3)", () => {
  it("leaves an invitation for the accept step when the address is not vouched for", async () => {
    const t = await team();
    const ada = await person(`ada@${t.domain}`);
    await global()
      .insert(schema.workspaceInvitations)
      .values({
        id: `inv_${hex()}`,
        workspaceId: t.id,
        email: `ada@${t.domain}`,
        role: "admin",
        tokenHash: hex(),
        invitedBy: t.admin,
        createdAt: NOW,
        expiresAt: NOW + 86_400_000,
      });
    expect(
      value(
        await joinWorkspaceThroughSso(global(), {
          workspaceId: t.id,
          userId: ada,
          email: `ada@${t.domain}`,
          now: NOW,
          consumeInvitation: false,
        }),
      ),
    ).toEqual({ joined: false, role: null, pendingInvitation: true });
    expect(
      await global()
        .select()
        .from(schema.workspaceInvitations)
        .where(eq(schema.workspaceInvitations.workspaceId, t.id)),
    ).toHaveLength(1);
  });
});

describe("a deleted workspace's identities (review finding 5)", () => {
  it("are deleted with the workspace", async () => {
    const t = await team();
    const provider = await setUp(t);
    await addAccount(t.editor, ssoAccountProvider(provider.id), "sub-e");
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: t.id, now: NOW }));
    expect(await ssoAccounts(provider.id)).toEqual([]);
  });

  it("are deleted again when a race or a restore brings them back during the deletion", async () => {
    const t = await team();
    const provider = await setUp(t);
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: t.id, now: NOW }));
    await addAccount(t.editor, ssoAccountProvider(provider.id), "sub-e");
    await advanceWorkspaceDeletion(regionsFromEnv(env), t.id, NOW);
    expect(await ssoAccounts(provider.id)).toEqual([]);
  });

  it("are deleted by applyTombstones for a deleted workspace", async () => {
    const t = await team();
    const provider = await setUp(t);
    await addAccount(t.editor, ssoAccountProvider(provider.id), "sub-e");
    await applyTombstones(global(), [{ kind: "workspace", id: t.id, deletedAt: NOW }], NOW);
    expect(await ssoAccounts(provider.id)).toEqual([]);
  });
});

describe("the isolate's discovery cache (review finding 4)", () => {
  it("keeps at most SSO_CACHE_ENTRIES issuers", async () => {
    for (let i = 0; i < SSO_CACHE_ENTRIES + 10; i += 1) {
      await discoverSso(idp(), `https://login${i}.cache.example.com`, { now: NOW });
    }
    expect(ssoDiscoveryCacheSize()).toBe(SSO_CACHE_ENTRIES);
  });
});
