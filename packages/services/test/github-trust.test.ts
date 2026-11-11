// GitHub Actions OIDC federation (decision 0024): who manages trust rules, what an exchange
// issues and refuses, what the credential reaches, and that removing a rule ends its
// credentials and stays removed through a restore. Signature and time checks are the app's
// (apps/app/test/github-oidc.test.ts); these tests start from verified claims.
import { env } from "cloudflare:test";
import {
  type AnnotationTarget,
  type GitHubTrustRuleCreate,
  githubKeyPrefix,
} from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import type { GitHubClaims } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAnnotationThread } from "../src/annotations.ts";
import { getArtifact, listArtifacts } from "../src/artifacts.ts";
import { getAuditLog } from "../src/audit.ts";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import {
  createGitHubTrustRule,
  exchangeGitHubToken,
  listGitHubTrustRules,
  pruneFederatedCredentials,
  pruneUsedGitHubTokens,
  removeGitHubTrustRule,
  updateGitHubTrustRule,
  usedTokenKey,
} from "../src/github-trust.ts";
import { deleteArtifact } from "../src/lifecycle.ts";
import { commitPublish, type ManifestEntry, preparePublish } from "../src/publish.ts";
import {
  authenticateServiceToken,
  createServiceToken,
  listServiceTokens,
} from "../src/service-tokens.ts";
import { resolveOwnerScope } from "../src/workspaces.ts";
import { db, grantPlan, MINUTE, NOW, sha256, user, value } from "./fixtures.ts";

const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };

interface Team {
  id: string;
  slug: string;
  admin: { id: string };
  editor: { id: string };
}

async function team(plan: "team" | "pro" | null = "team"): Promise<Team> {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const slug = `t${id.slice(3, 22)}`;
  const [admin, editor] = [await user("Admin"), await user("Editor")];
  await db()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: editor.id, role: "editor", updatedAt: NOW },
    ]);
  if (plan) await grantPlan(id, plan, { seats: 3 });
  return { id, slug, admin, editor };
}

const REPO_ID = "123456";
const OWNER_ID = "777";

const BODY: GitHubTrustRuleCreate = {
  repository: "acme/site",
  repositoryId: REPO_ID,
  repositoryOwnerId: OWNER_ID,
  events: ["pull_request", "push"],
  ref: null,
  environment: null,
  scopes: ["artifacts:read", "artifacts:write", "artifacts:delete"],
  privilegedConfirmed: false,
};

const rule = async (t: Team, body: Partial<GitHubTrustRuleCreate> = {}) =>
  value(
    await createGitHubTrustRule(db().global, {
      userId: t.admin.id,
      slug: t.slug,
      body: { ...BODY, ...body },
      now: NOW,
    }),
  );

function claims(over: Partial<GitHubClaims> = {}): GitHubClaims {
  return {
    jti: crypto.randomUUID(),
    repositoryId: REPO_ID,
    repositoryOwnerId: OWNER_ID,
    repository: "acme/site",
    eventName: "pull_request",
    ref: "refs/pull/7/merge",
    environment: null,
    runId: "9001",
    runAttempt: 1,
    issuedAt: NOW,
    expiresAt: NOW + 5 * MINUTE,
    ...over,
  };
}

async function issued(t: Team, over: Partial<GitHubClaims> = {}, now = NOW) {
  const result = await exchangeGitHubToken(db().global, {
    slug: t.slug,
    claims: claims(over),
    now,
  });
  if (!result.ok) throw new Error(`exchange refused: ${result.reason}`);
  return result;
}

async function manifest(text: string): Promise<ManifestEntry[]> {
  return [
    {
      path: "index.html",
      kind: "published",
      sha256: await sha256(text),
      size: text.length,
      contentType: "text/html",
    },
  ];
}

async function publish(userId: string, ownerId: string, key?: string, now = NOW) {
  const text = `<p>${crypto.randomUUID()}</p>`;
  const prepared = await preparePublish(db(), {
    userId,
    targetOwnerId: ownerId,
    type: "site",
    name: "Preview",
    entrypoint: "index.html",
    baseVersionId: null,
    files: await manifest(text),
    ...(key !== undefined ? { key } : {}),
    now,
  });
  if (!prepared.ok) return prepared;
  await env.ARTIFACTS.put(`objects/${ownerId}/${await sha256(text)}`, text);
  return commitPublish(db(), env.ARTIFACTS, { userId, sessionId: prepared.value.sessionId, now });
}

describe("trust rules", () => {
  it("lets an admin trust a repository by its IDs, gated on the plan", async () => {
    const t = await team();
    const created = await rule(t);
    expect(created).toMatchObject({
      repository: "acme/site",
      repositoryId: REPO_ID,
      repositoryOwnerId: OWNER_ID,
      events: ["push", "pull_request"],
      scopes: ["artifacts:read", "artifacts:write", "artifacts:delete"],
      keyPrefix: "gh-123456/",
      liveCredentials: 0,
      createdBy: { name: "Admin" },
      revision: 0,
    });
    const listing = value(
      await listGitHubTrustRules(db().global, { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(listing).toMatchObject({ available: true, limit: 20 });
    expect(listing.items.map((item) => item.id)).toEqual([created.id]);
  });

  it("refuses editors, other workspaces' admins and a plan without service tokens", async () => {
    const t = await team();
    const other = await team();
    const asEditor = await createGitHubTrustRule(db().global, {
      userId: t.editor.id,
      slug: t.slug,
      body: BODY,
      now: NOW,
    });
    expect(asEditor).toMatchObject({ ok: false, code: "forbidden" });
    const outsider = await createGitHubTrustRule(db().global, {
      userId: other.admin.id,
      slug: t.slug,
      body: BODY,
      now: NOW,
    });
    expect(outsider).toMatchObject({ ok: false, code: "not_found" });
    const pro = await team("pro");
    const gated = await createGitHubTrustRule(db().global, {
      userId: pro.admin.id,
      slug: pro.slug,
      body: BODY,
      now: NOW,
    });
    expect(gated).toMatchObject({ ok: false, code: "plan_required" });
  });

  it("refuses a second rule for the same repository and more than the cap", async () => {
    const t = await team();
    await rule(t);
    const again = await createGitHubTrustRule(db().global, {
      userId: t.admin.id,
      slug: t.slug,
      body: { ...BODY, repository: "acme/renamed" },
      now: NOW,
    });
    expect(again).toMatchObject({ ok: false, code: "invalid_input" });
    for (let i = 1; i < 20; i += 1) await rule(t, { repositoryId: String(1000 + i) });
    const over = await createGitHubTrustRule(db().global, {
      userId: t.admin.id,
      slug: t.slug,
      body: { ...BODY, repositoryId: "5000" },
      now: NOW,
    });
    expect(over).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("needs a confirmation to trust events a fork's pull request can start", async () => {
    const t = await team();
    const unconfirmed = await createGitHubTrustRule(db().global, {
      userId: t.admin.id,
      slug: t.slug,
      body: { ...BODY, events: ["pull_request_target"] },
      now: NOW,
    });
    expect(unconfirmed).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      (await rule(t, { events: ["pull_request_target"], privilegedConfirmed: true })).events,
    ).toEqual(["pull_request_target"]);
  });

  it("records creating, changing and removing in the audit log", async () => {
    const t = await team();
    const created = await rule(t, { environment: "preview" });
    const changed = value(
      await updateGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: created.id,
        body: { ...BODY, events: ["push"], revision: 0 },
        now: NOW,
      }),
    );
    value(
      await removeGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: changed.id,
        now: NOW,
      }),
    );
    const rows = await db()
      .select({ kind: schema.auditEvents.kind, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, t.id));
    expect(rows.map((row) => row.kind).sort()).toEqual([
      "github_trust.changed",
      "github_trust.created",
      "github_trust.removed",
    ]);
    const createdEvent = rows.find((row) => row.kind === "github_trust.created");
    expect(createdEvent?.detail).toEqual({
      repositoryId: REPO_ID,
      repository: "acme/site",
      events: ["push", "pull_request"],
      scopes: ["artifacts:read", "artifacts:write", "artifacts:delete"],
      ref: false,
      environment: true,
    });
    // The environment's name never reaches the log.
    expect(JSON.stringify(rows)).not.toContain("preview");
  });

  it("changes nothing for an identical rule and refuses a stale revision", async () => {
    const t = await team();
    const created = await rule(t);
    const same = value(
      await updateGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: created.id,
        body: { ...BODY, revision: 0 },
        now: NOW + MINUTE,
      }),
    );
    expect(same.revision).toBe(0);
    const changed = value(
      await updateGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: created.id,
        body: { ...BODY, events: ["push"], revision: 0 },
        now: NOW,
      }),
    );
    // A change saves a new rule: the old ID is gone, the new one is at the next revision.
    expect(changed.id).not.toBe(created.id);
    expect(changed).toMatchObject({
      revision: 1,
      createdAt: created.createdAt,
      createdBy: { name: "Admin" },
    });
    const gone = await updateGitHubTrustRule(db().global, {
      userId: t.admin.id,
      slug: t.slug,
      ruleId: created.id,
      body: { ...BODY, revision: 1 },
      now: NOW,
    });
    expect(gone).toMatchObject({ ok: false, code: "not_found" });
    const stale = await updateGitHubTrustRule(db().global, {
      userId: t.admin.id,
      slug: t.slug,
      ruleId: changed.id,
      body: { ...BODY, revision: 0 },
      now: NOW,
    });
    expect(stale).toMatchObject({ ok: false, code: "version_conflict" });
  });

  it("removes a rule without the plan, and a restore cannot bring it back", async () => {
    const t = await team();
    const created = await rule(t);
    const [stored] = await db()
      .select()
      .from(schema.githubTrustRules)
      .where(eq(schema.githubTrustRules.id, created.id));
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    value(
      await removeGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: created.id,
        now: NOW,
      }),
    );
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({ kind: "github_trust_rule", id: created.id, deletedAt: NOW });
    // A restore rewinds the table: the row is back, the tombstone too.
    if (!stored) throw new Error("no rule");
    await db().insert(schema.githubTrustRules).values(stored);
    const applied = await applyTombstones(db(), markers, NOW);
    expect(applied.githubTrustRules).toBe(1);
    const left = await db()
      .select()
      .from(schema.githubTrustRules)
      .where(eq(schema.githubTrustRules.id, created.id));
    expect(left).toEqual([]);
  });
});

describe("each ID token is exchanged once (review of the first version)", () => {
  it("stays used after its rule is changed, or removed and trusted again", async () => {
    const t = await team();
    const created = await rule(t);
    const once = claims();
    expect(
      (await exchangeGitHubToken(db().global, { slug: t.slug, claims: once, now: NOW })).ok,
    ).toBe(true);
    const changed = value(
      await updateGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: created.id,
        body: { ...BODY, scopes: ["artifacts:read"], revision: 0 },
        now: NOW,
      }),
    );
    expect(
      await exchangeGitHubToken(db().global, { slug: t.slug, claims: once, now: NOW }),
    ).toEqual({ ok: false, reason: "replayed" });
    value(
      await removeGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: changed.id,
        now: NOW,
      }),
    );
    await rule(t);
    expect(
      await exchangeGitHubToken(db().global, { slug: t.slug, claims: once, now: NOW }),
    ).toEqual({ ok: false, reason: "replayed" });
    // Only a hash of the issuer and the `jti` is kept, never the raw value.
    const used = await db().select().from(schema.githubUsedTokens);
    expect(JSON.stringify(used)).not.toContain(once.jti);
  });

  it("lets only one of two concurrent exchanges of the same token win", async () => {
    const t = await team();
    await rule(t);
    const once = claims();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        exchangeGitHubToken(db().global, { slug: t.slug, claims: once, now: NOW }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const credentials = await db()
      .select({ id: schema.serviceTokens.id })
      .from(schema.serviceTokens)
      .where(eq(schema.serviceTokens.workspaceId, t.id));
    expect(credentials).toHaveLength(1);
  });

  it("refuses a token GitHub issued before the rule's current version was saved", async () => {
    const t = await team();
    const created = await rule(t);
    const minted = claims({ issuedAt: NOW + MINUTE });
    value(
      await updateGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: created.id,
        body: {
          ...BODY,
          events: ["push", "pull_request"],
          scopes: ["artifacts:read"],
          revision: 0,
        },
        now: NOW + 2 * MINUTE,
      }),
    );
    expect(
      await exchangeGitHubToken(db().global, {
        slug: t.slug,
        claims: minted,
        now: NOW + 2 * MINUTE,
      }),
    ).toEqual({ ok: false, reason: "stale" });
    const fresh = claims({ issuedAt: NOW + 2 * MINUTE });
    expect(
      (
        await exchangeGitHubToken(db().global, {
          slug: t.slug,
          claims: fresh,
          now: NOW + 2 * MINUTE,
        })
      ).ok,
    ).toBe(true);
  });

  it("forgets a used token only once it could no longer pass the time checks", async () => {
    const t = await team();
    await rule(t);
    const once = claims({ expiresAt: NOW + 5 * MINUTE });
    expect(
      (await exchangeGitHubToken(db().global, { slug: t.slug, claims: once, now: NOW })).ok,
    ).toBe(true);
    const key = await usedTokenKey(once.jti);
    const held = async () =>
      (
        await db()
          .select()
          .from(schema.githubUsedTokens)
          .where(eq(schema.githubUsedTokens.jtiHash, key))
      ).length;
    // Its credential is pruned an hour after it expires; the used token is kept regardless.
    await pruneFederatedCredentials(db().global, NOW + 2 * 60 * MINUTE);
    // Kept through `exp` plus the 60 seconds of skew the exchange accepts.
    await pruneUsedGitHubTokens(db().global, NOW + 6 * MINUTE - 1);
    expect(await held()).toBe(1);
    await pruneUsedGitHubTokens(db().global, NOW + 6 * MINUTE + 1);
    expect(await held()).toBe(0);
  });
});

describe("a restore and a narrowed rule (review of the first version)", () => {
  it("removes the wider rule a restore brings back, and refuses its exchanges", async () => {
    const t = await team();
    const wide = await rule(t, {
      events: ["pull_request", "pull_request_target"],
      privilegedConfirmed: true,
    });
    const [stored] = await db()
      .select()
      .from(schema.githubTrustRules)
      .where(eq(schema.githubTrustRules.id, wide.id));
    const narrow = value(
      await updateGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: wide.id,
        body: { ...BODY, events: ["pull_request"], environment: "preview", revision: 0 },
        now: NOW,
      }),
    );
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({ kind: "github_trust_rule", id: wide.id, deletedAt: NOW });
    // A restore to before the change: the narrowed rule is gone, the wider one is back.
    if (!stored) throw new Error("no rule");
    await db().delete(schema.githubTrustRules).where(eq(schema.githubTrustRules.id, narrow.id));
    await db().insert(schema.githubTrustRules).values(stored);
    const target = claims({ eventName: "pull_request_target" });
    expect(
      (await exchangeGitHubToken(db().global, { slug: t.slug, claims: target, now: NOW })).ok,
    ).toBe(true);
    const applied = await applyTombstones(db(), markers, NOW);
    expect(applied.githubTrustRules).toBe(1);
    expect(
      await exchangeGitHubToken(db().global, {
        slug: t.slug,
        claims: claims({ eventName: "pull_request_target" }),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "no_rule" });
  });
});

describe("refusals of rule changes", () => {
  it("lets one of two concurrent changes win and answers the other version_conflict", async () => {
    const t = await team();
    const created = await rule(t);
    const change = (scopes: GitHubTrustRuleCreate["scopes"]) =>
      updateGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: created.id,
        body: { ...BODY, scopes, revision: 0 },
        now: NOW,
      });
    const results = await Promise.all([change(["artifacts:read"]), change(["artifacts:write"])]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    const rules = await db()
      .select({ id: schema.githubTrustRules.id })
      .from(schema.githubTrustRules)
      .where(eq(schema.githubTrustRules.workspaceId, t.id));
    expect(rules).toHaveLength(1);
  });

  it("names the replaced rule in the change's audit event", async () => {
    const t = await team();
    const created = await rule(t);
    const changed = value(
      await updateGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: created.id,
        body: { ...BODY, events: ["push"], revision: 0 },
        now: NOW,
      }),
    );
    const [event] = await db()
      .select({ targetId: schema.auditEvents.targetId, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.ownerId, t.id),
          eq(schema.auditEvents.kind, "github_trust.changed"),
        ),
      );
    expect(event?.targetId).toBe(changed.id);
    expect(event?.detail).toMatchObject({ replaces: created.id });
  });

  it("refuses editors, unknown rules, a second rule's repository and unconfirmed privileged events", async () => {
    const t = await team();
    const created = await rule(t);
    await rule(t, { repositoryId: "654321", repository: "acme/docs" });
    const update = (userId: string, ruleId: string, body: Partial<GitHubTrustRuleCreate> = {}) =>
      updateGitHubTrustRule(db().global, {
        userId,
        slug: t.slug,
        ruleId,
        body: { ...BODY, ...body, revision: 0 },
        now: NOW,
      });
    expect(await update(t.editor.id, created.id, { events: ["push"] })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await update(t.admin.id, `gtr_${"0".repeat(32)}`)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await update(t.admin.id, created.id, { repositoryId: "654321" })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(await update(t.admin.id, created.id, { events: ["workflow_run"] })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(
      await removeGitHubTrustRule(db().global, {
        userId: t.editor.id,
        slug: t.slug,
        ruleId: created.id,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await removeGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: `gtr_${"0".repeat(32)}`,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await listGitHubTrustRules(db().global, { userId: t.editor.id, slug: t.slug, now: NOW }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("gates changing on the plan but never removing", async () => {
    const t = await team();
    const created = await rule(t);
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    expect(
      await updateGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: created.id,
        body: { ...BODY, events: ["push"], revision: 0 },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "plan_required" });
    expect(
      value(await listGitHubTrustRules(db().global, { userId: t.admin.id, slug: t.slug, now: NOW }))
        .available,
    ).toBe(false);
  });

  it("issues nothing for a rule whose stored scopes give nothing", async () => {
    const t = await team();
    const created = await rule(t);
    await db()
      .update(schema.githubTrustRules)
      .set({ scopes: "artifacts:share" })
      .where(eq(schema.githubTrustRules.id, created.id));
    expect(
      await exchangeGitHubToken(db().global, { slug: t.slug, claims: claims(), now: NOW }),
    ).toEqual({ ok: false, reason: "no_rule" });
  });

  it("checks the rule's ref and environment", async () => {
    const t = await team();
    await rule(t, { ref: "refs/heads/main", environment: "preview", events: ["push"] });
    const at = (over: Partial<GitHubClaims>) =>
      exchangeGitHubToken(db().global, {
        slug: t.slug,
        claims: claims({ eventName: "push", ...over }),
        now: NOW,
      });
    expect(await at({ ref: "refs/heads/dev", environment: "preview" })).toEqual({
      ok: false,
      reason: "ref",
    });
    expect(await at({ ref: "refs/heads/main" })).toEqual({ ok: false, reason: "environment" });
    expect((await at({ ref: "refs/heads/main", environment: "preview" })).ok).toBe(true);
  });
});

describe("the exchange", () => {
  it("issues a short-lived credential restricted to the repository's key namespace", async () => {
    const t = await team();
    const created = await rule(t);
    const credential = await issued(t);
    expect(credential).toMatchObject({
      workspace: t.slug,
      keyPrefix: "gh-123456/",
      scopes: ["artifacts:read", "artifacts:write", "artifacts:delete"],
      expiresAt: NOW + 15 * MINUTE,
    });
    expect(credential.secret).toMatch(/^pfst_[A-Za-z0-9_-]{43}$/);
    const [row] = await db()
      .select()
      .from(schema.serviceTokens)
      .where(eq(schema.serviceTokens.id, credential.tokenId));
    expect(row).toMatchObject({
      workspaceId: t.id,
      label: "GitHub acme/site run 9001",
      role: "editor",
      restriction: "key",
      keyPrefix: "gh-123456/",
      trustRuleId: created.id,
      lastUsedAt: NOW,
      tokenHash: await sha256(credential.secret),
    });
    // An admin's token list and its cap leave the run's credential out; the rule counts it.
    const tokens = value(
      await listServiceTokens(db().global, { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(tokens.items).toEqual([]);
    const listing = value(
      await listGitHubTrustRules(db().global, { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(listing.items[0]?.liveCredentials).toBe(1);
    // The exchange is in the audit log with the run, the credential as the actor.
    const log = value(
      await getAuditLog(db(), {
        actor: { userId: t.admin.id, ownerId: t.id, role: "admin", region: "default" },
        filters: {},
        limit: 50,
        now: NOW,
      }),
    );
    const event = log.events.find((e) => e.kind === "github_trust.exchanged");
    expect(event?.actor).toEqual({
      type: "service_token",
      id: credential.tokenId,
      label: "GitHub acme/site run 9001",
    });
    expect(event?.detail).toEqual({
      repositoryId: REPO_ID,
      repository: "acme/site",
      event: "pull_request",
      runId: "9001",
      runAttempt: 1,
    });
  });

  it("issues once per ID token", async () => {
    const t = await team();
    await rule(t);
    const once = claims();
    const first = await exchangeGitHubToken(db().global, { slug: t.slug, claims: once, now: NOW });
    expect(first.ok).toBe(true);
    const replay = await exchangeGitHubToken(db().global, { slug: t.slug, claims: once, now: NOW });
    expect(replay).toEqual({ ok: false, reason: "replayed" });
  });

  it.each<[string, Partial<GitHubClaims>, string]>([
    ["a repository the workspace does not trust", { repositoryId: "999" }, "no_rule"],
    [
      "the trusted name with another ID",
      { repositoryId: "998", repository: "acme/site" },
      "no_rule",
    ],
    ["another owner", { repositoryOwnerId: "778" }, "owner"],
    ["an untrusted event", { eventName: "workflow_dispatch" }, "event"],
    ["a privileged event", { eventName: "pull_request_target" }, "event"],
  ])("refuses %s", async (_name, over, reason) => {
    const t = await team();
    await rule(t);
    const result = await exchangeGitHubToken(db().global, {
      slug: t.slug,
      claims: claims(over),
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason });
  });

  it("refuses a workspace that does not exist, or trusts the repository elsewhere", async () => {
    const t = await team();
    const other = await team();
    await rule(other);
    expect(
      await exchangeGitHubToken(db().global, { slug: "nope", claims: claims(), now: NOW }),
    ).toEqual({ ok: false, reason: "no_workspace" });
    expect(
      await exchangeGitHubToken(db().global, { slug: t.slug, claims: claims(), now: NOW }),
    ).toEqual({ ok: false, reason: "no_rule" });
  });

  it("refuses once the plan no longer includes service tokens", async () => {
    const t = await team();
    await rule(t);
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    expect(
      await exchangeGitHubToken(db().global, { slug: t.slug, claims: claims(), now: NOW }),
    ).toEqual({ ok: false, reason: "plan" });
  });
});

describe("the credential", () => {
  it("publishes, reads and deletes only within its repository's namespace", async () => {
    const t = await team();
    await rule(t);
    await rule(t, { repositoryId: "654321", repository: "acme/docs" });
    const site = await issued(t);
    const docs = await issued(t, { repositoryId: "654321", repository: "acme/docs" });
    const own = value(await publish(site.tokenId, t.id, `${githubKeyPrefix(REPO_ID)}pr-7`));
    // No key, another repository's namespace, or a key that only looks alike: refused.
    expect(await publish(site.tokenId, t.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await publish(site.tokenId, t.id, "gh-654321/pr-7")).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await publish(site.tokenId, t.id, "gh-1234567/pr-7")).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    // Another repository's credential and a person's hand-published artifact are out of reach.
    const theirs = value(await publish(docs.tokenId, t.id, "gh-654321/pr-7"));
    const manual = value(await publish(t.editor.id, t.id));
    for (const artifactId of [theirs.artifactId, manual.artifactId]) {
      expect(await getArtifact(db(), { userId: site.tokenId, artifactId })).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(
        await deleteArtifact(db(), env.ARTIFACTS, { userId: site.tokenId, artifactId, now: NOW }),
      ).toMatchObject({ ok: false, code: "not_found" });
    }
    const actor = value(await resolveOwnerScope(db().global, site.tokenId, undefined));
    const listed = value(await listArtifacts(db(), { actor, limit: 50, now: NOW }));
    expect(listed.items.map((item) => item.id)).toEqual([own.artifactId]);
    expect(
      await deleteArtifact(db(), env.ARTIFACTS, {
        userId: site.tokenId,
        artifactId: own.artifactId,
        now: NOW,
      }),
    ).toMatchObject({ ok: true });
  });

  it("acts on no other workspace and never as a person", async () => {
    const t = await team();
    const other = await team();
    await rule(t);
    const credential = await issued(t);
    expect(await publish(credential.tokenId, other.id, "gh-123456/pr-7")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const own = value(await publish(credential.tokenId, t.id, "gh-123456/pr-8"));
    expect(
      await createAnnotationThread(db(), {
        userId: credential.tokenId,
        artifactId: own.artifactId,
        versionId: own.versionId,
        target: DOC,
        body: "From CI",
        humanCheck: { token: "solved", verify: async () => "passed" },
        now: NOW,
      }),
    ).toMatchObject({ ok: false });
  });

  it("expires after 15 minutes", async () => {
    const t = await team();
    await rule(t);
    const credential = await issued(t);
    expect(
      await authenticateServiceToken(db().global, credential.secret, NOW + 14 * MINUTE),
    ).toMatchObject({
      ok: true,
      scopes: ["artifacts:read", "artifacts:write", "artifacts:delete"],
    });
    expect(
      await authenticateServiceToken(db().global, credential.secret, NOW + 15 * MINUTE),
    ).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("ends at once when its rule is removed or changed", async () => {
    const t = await team();
    const created = await rule(t);
    const before = await issued(t);
    const changed = value(
      await updateGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: created.id,
        body: { ...BODY, scopes: ["artifacts:read"], revision: 0 },
        now: NOW,
      }),
    );
    expect(await authenticateServiceToken(db().global, before.secret, NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
    const after = await issued(t);
    expect(after.scopes).toEqual(["artifacts:read"]);
    value(
      await removeGitHubTrustRule(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        ruleId: changed.id,
        now: NOW,
      }),
    );
    expect(await authenticateServiceToken(db().global, after.secret, NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("is pruned an hour after it expires, a bounded batch at a time, and admins' tokens never", async () => {
    const t = await team();
    await rule(t);
    const credential = await issued(t);
    const manual = value(
      await createServiceToken(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        body: {
          label: "CI",
          role: "editor",
          scopes: ["artifacts:read"],
          expiresInDays: 1,
          restriction: { kind: "none" },
        },
        now: NOW - 3 * 24 * 60 * MINUTE,
      }),
    );
    const ids = async () =>
      (await db().select({ id: schema.serviceTokens.id }).from(schema.serviceTokens)).map(
        (row) => row.id,
      );
    // Other tests' credentials share the database: only this one is followed.
    await pruneFederatedCredentials(db().global, NOW + 70 * MINUTE);
    expect(await ids()).toContain(credential.tokenId);
    expect(await pruneFederatedCredentials(db().global, NOW + 76 * MINUTE)).toBeGreaterThan(0);
    const left = await ids();
    expect(left).toContain(manual.token.id);
    expect(left).not.toContain(credential.tokenId);
  });
});
