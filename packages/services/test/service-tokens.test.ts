// Service tokens and publish keys (premium plan T4 and T5, decision 0011): who manages tokens,
// how a secret authenticates, what a token's actor reaches, what records it as the actor, what
// refuses it, and keyed publishes.
import { env } from "cloudflare:test";
import {
  type AnnotationTarget,
  DEFAULT_POLICY,
  type ServiceTokenCreate,
} from "@portifact/contracts";
import { type AccessDb, regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAccess, updateAccess } from "../src/access.ts";
import { getAccessLog } from "../src/access-log.ts";
import { exportAccount, requestAccountDeletion } from "../src/account-data.ts";
import { actorOn, resolveActor } from "../src/actors.ts";
import { createAnnotationThread } from "../src/annotations.ts";
import { getArtifact, listArtifacts } from "../src/artifacts.ts";
import { getAuditLog } from "../src/audit.ts";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { addCustomDomain } from "../src/custom-domains.ts";
import { deleteArtifact, renewArtifact } from "../src/lifecycle.ts";
import { commitPublish, type ManifestEntry, preparePublish } from "../src/publish.ts";
import { checkReadAccess } from "../src/read-access.ts";
import {
  authenticateServiceToken,
  createServiceToken,
  exportServiceTokens,
  findServiceToken,
  listServiceTokens,
  newServiceTokenSecret,
  operatorRevokeServiceToken,
  revokeServiceToken,
} from "../src/service-tokens.ts";
import { transferArtifact } from "../src/transfer.ts";
import { getAccountUsage } from "../src/usage.ts";
import { listVersions } from "../src/versions.ts";
import { deleteWorkspace, listUserWorkspaces, resolveOwnerScope } from "../src/workspaces.ts";
import {
  DAY,
  db,
  grantPlan,
  MINUTE,
  NOW,
  racing,
  session,
  sha256,
  user,
  value,
} from "./fixtures.ts";

const HOUR = 60 * MINUTE;
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };
const MISSING_ID = "zzzzzzzzzz";

interface Team {
  id: string;
  slug: string;
  admin: { id: string; email: string };
  editor: { id: string; email: string };
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

const BODY: ServiceTokenCreate = {
  label: "CI previews",
  role: "editor",
  scopes: ["artifacts:read", "artifacts:write"],
  expiresInDays: 30,
  restriction: { kind: "none" },
};

async function token(t: Team, body: Partial<ServiceTokenCreate> = {}, now = NOW) {
  return value(
    await createServiceToken(db().global, {
      userId: t.admin.id,
      slug: t.slug,
      body: { ...BODY, ...body },
      now,
    }),
  );
}

const create = (userId: string, slug: string) =>
  createServiceToken(db().global, { userId, slug, body: BODY, now: NOW });

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

/** Publishes as `userId` (a person or a token ID) into `ownerId`, optionally with a key. */
async function publish(
  userId: string,
  ownerId: string,
  options: { key?: string; artifactId?: string; baseVersionId?: string | null; now?: number } = {},
) {
  const text = `<p>${crypto.randomUUID()}</p>`;
  const now = options.now ?? NOW;
  const prepared = await preparePublish(db(), {
    userId,
    targetOwnerId: ownerId,
    ...(options.artifactId ? { artifactId: options.artifactId } : {}),
    type: "site",
    name: "Preview",
    entrypoint: "index.html",
    baseVersionId: options.baseVersionId ?? null,
    files: await manifest(text),
    ...(options.key !== undefined ? { key: options.key } : {}),
    now,
  });
  if (!prepared.ok) return prepared;
  await env.ARTIFACTS.put(`objects/${ownerId}/${await sha256(text)}`, text);
  return commitPublish(db(), env.ARTIFACTS, {
    userId,
    sessionId: prepared.value.sessionId,
    now,
  });
}

async function row(artifactId: string) {
  const [found] = await db()
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  return found;
}

describe("managing tokens", () => {
  it("lets admins create one, shows the secret once and stores only its hash", async () => {
    const t = await team();
    const created = await token(t);
    expect(created.secret).toMatch(/^pfst_[A-Za-z0-9_-]{43}$/);
    expect(created.token).toMatchObject({
      label: "CI previews",
      role: "editor",
      scopes: ["artifacts:read", "artifacts:write"],
      restriction: { kind: "none" },
      lastUsedAt: null,
      createdBy: { name: "Admin" },
      expired: false,
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 30 * DAY).toISOString(),
    });
    const [stored] = await db()
      .select()
      .from(schema.serviceTokens)
      .where(eq(schema.serviceTokens.id, created.token.id));
    expect(stored?.tokenHash).toBe(await sha256(created.secret));
    expect(JSON.stringify(stored)).not.toContain(created.secret);
    const listing = value(
      await listServiceTokens(db().global, { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(listing).toEqual({ items: [created.token], available: true, limit: 20 });
    expect(JSON.stringify(listing)).not.toContain(created.secret);
    // Two secrets never repeat.
    expect((await token(t)).secret).not.toBe(created.secret);
  });

  it("refuses editors, answers outsiders like a missing workspace and needs the plan to create", async () => {
    const t = await team();
    const outsider = await user();
    expect(await create(t.editor.id, t.slug)).toEqual({
      ok: false,
      code: "forbidden",
      message: "Your role on this workspace does not allow this.",
    });
    expect(
      await listServiceTokens(db().global, { userId: t.editor.id, slug: t.slug, now: NOW }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(await create(outsider.id, t.slug)).toEqual({
      ok: false,
      code: "not_found",
      message: "Workspace not found.",
    });
    expect(await create(outsider.id, "no-such-workspace")).toEqual(
      await create(outsider.id, t.slug),
    );

    const pro = await team("pro");
    expect(await create(pro.admin.id, pro.slug)).toEqual({
      ok: false,
      code: "plan_required",
      message: "Using service tokens is part of the Team plan.",
    });
    // Listing never needs the plan.
    expect(
      value(
        await listServiceTokens(db().global, { userId: pro.admin.id, slug: pro.slug, now: NOW }),
      ),
    ).toEqual({ items: [], available: false, limit: 20 });
  });

  it("keeps a workspace at 20 tokens", async () => {
    const t = await team();
    for (let i = 0; i < 20; i++) await token(t, { label: `CI ${i}` });
    expect(await create(t.admin.id, t.slug)).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "A workspace can have at most 20 service tokens. Revoke one first.",
    });
  });

  it("revokes with a tombstone, and the next request is refused", async () => {
    const t = await team();
    const created = await token(t);
    const revoke = (userId: string) =>
      revokeServiceToken(db().global, {
        userId,
        slug: t.slug,
        tokenId: created.token.id,
        now: NOW,
      });
    expect((await authenticateServiceToken(db().global, created.secret, NOW)).ok).toBe(true);
    expect(await revoke(t.editor.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(value(await revoke(t.admin.id))).toEqual({ tokenId: created.token.id });
    expect(await authenticateServiceToken(db().global, created.secret, NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await revoke(t.admin.id)).toEqual({
      ok: false,
      code: "not_found",
      message: "Service token not found.",
    });
    expect(await exportTombstones(db())).toContainEqual({
      kind: "service_token",
      id: created.token.id,
      deletedAt: NOW,
    });
  });

  it("never revokes another workspace's token", async () => {
    const [a, b] = [await team(), await team()];
    const created = await token(b);
    expect(
      await revokeServiceToken(db().global, {
        userId: a.admin.id,
        slug: a.slug,
        tokenId: created.token.id,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "not_found", message: "Service token not found." });
    expect((await authenticateServiceToken(db().global, created.secret, NOW)).ok).toBe(true);
    const markers = await exportTombstones(db());
    expect(markers.some((marker) => marker.id === created.token.id)).toBe(false);
  });
});

describe("authentication", () => {
  it("answers a table of secrets", async () => {
    const t = await team();
    const valid = await token(t);
    const expired = await token(t, { expiresInDays: 1 }, NOW - 2 * DAY);
    const cases: [string, string, unknown][] = [
      [
        "valid",
        valid.secret,
        {
          ok: true,
          tokenId: valid.token.id,
          workspaceId: t.id,
          scopes: ["artifacts:read", "artifacts:write"],
        },
      ],
      ["expired", expired.secret, { ok: false, reason: "expired", expiresAt: NOW - DAY }],
      ["unknown", newServiceTokenSecret(), { ok: false, reason: "invalid" }],
      ["truncated", valid.secret.slice(0, -1), { ok: false, reason: "invalid" }],
      ["wrong prefix", `pfsx_${valid.secret.slice(5)}`, { ok: false, reason: "invalid" }],
      ["padded", ` ${valid.secret}`, { ok: false, reason: "invalid" }],
    ];
    for (const [name, secret, expected] of cases) {
      expect(await authenticateServiceToken(db().global, secret, NOW), name).toEqual(expected);
    }
    // At the expiry itself it no longer works.
    expect((await authenticateServiceToken(db().global, valid.secret, NOW + 30 * DAY)).ok).toBe(
      false,
    );
    expect((await authenticateServiceToken(db().global, valid.secret, NOW + 30 * DAY - 1)).ok).toBe(
      true,
    );
  });

  it("refuses a token of a workspace whose plan lapsed, and of a deleted workspace", async () => {
    const t = await team();
    const created = await token(t);
    await grantPlan(t.id, "team", { seats: 3, validUntil: NOW + HOUR });
    expect((await authenticateServiceToken(db().global, created.secret, NOW)).ok).toBe(true);
    expect(await authenticateServiceToken(db().global, created.secret, NOW + 2 * HOUR)).toEqual({
      ok: false,
      reason: "plan",
      message: "Using service tokens is part of the Team plan.",
    });
    await grantPlan(t.id, "pro");
    expect(await authenticateServiceToken(db().global, created.secret, NOW)).toMatchObject({
      reason: "plan",
    });

    const gone = await team();
    const goneToken = await token(gone);
    value(await deleteWorkspace(db(), { workspaceId: gone.id, now: NOW }));
    expect(await authenticateServiceToken(db().global, goneToken.secret, NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("records last use at most once an hour, with no write in between", async () => {
    const t = await team();
    const created = await token(t);
    const lastUsed = async () =>
      (
        await db()
          .select({ at: schema.serviceTokens.lastUsedAt })
          .from(schema.serviceTokens)
          .where(eq(schema.serviceTokens.id, created.token.id))
      )[0]?.at;
    let writes = 0;
    const global = db().global;
    const counting = new Proxy(global, {
      get(target, property, receiver) {
        if (property === "update" || property === "insert" || property === "delete") writes++;
        return Reflect.get(target, property, receiver);
      },
    });
    const start = Date.UTC(2026, 10, 8, 12, 10);
    await authenticateServiceToken(counting, created.secret, start);
    expect(await lastUsed()).toBe(start);
    for (let i = 1; i <= 5; i++) {
      await authenticateServiceToken(counting, created.secret, start + i * 9 * MINUTE);
    }
    expect(writes).toBe(1);
    expect(await lastUsed()).toBe(start);
    await authenticateServiceToken(counting, created.secret, start + HOUR);
    expect(writes).toBe(2);
    expect(await lastUsed()).toBe(start + HOUR);
    const listed = value(
      await listServiceTokens(db().global, { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(listed.items[0]?.lastUsedAt).toBe(new Date(start + HOUR).toISOString());
  });
});

describe("the token's actor", () => {
  it("has its role on its own workspace only, and no personal space", async () => {
    const [t, other] = [await team(), await team()];
    const created = await token(t);
    const id = created.token.id;
    expect(await actorOn(db().global, id, t.id)).toEqual({
      userId: id,
      ownerId: t.id,
      role: "editor",
      region: "default",
      policy: DEFAULT_POLICY,
      domainVerified: true,
      token: {
        restriction: { kind: "none" },
        scopes: ["artifacts:read", "artifacts:write"],
        createdAt: NOW,
        label: "CI previews",
      },
    });
    expect(await actorOn(db().global, id, other.id)).toBeNull();
    expect(await actorOn(db().global, id, id)).toBeNull();
    expect(await actorOn(db().global, id, t.admin.id)).toBeNull();
    expect(await resolveActor(db().global, id, t.admin.id)).toMatchObject({ code: "not_found" });
  });

  it("acts on its workspace without a slug, and a slug naming another answers like a missing one", async () => {
    const [t, other] = [await team(), await team()];
    const id = (await token(t)).token.id;
    expect(value(await resolveOwnerScope(db().global, id, undefined)).ownerId).toBe(t.id);
    expect(value(await resolveOwnerScope(db().global, id, t.slug)).ownerId).toBe(t.id);
    expect(await resolveOwnerScope(db().global, id, other.slug)).toEqual({
      ok: false,
      code: "not_found",
      message: "Workspace not found.",
    });
    expect(await resolveOwnerScope(db().global, id, "missing-slug")).toEqual(
      await resolveOwnerScope(db().global, id, other.slug),
    );
    const listed = await listUserWorkspaces(db().global, id);
    expect(listed.map((w) => [w.slug, w.role])).toEqual([[t.slug, "editor"]]);
  });

  it("publishes, lists, renews and deletes on its workspace, recorded as the token", async () => {
    const t = await team();
    const id = (
      await token(t, { scopes: ["artifacts:read", "artifacts:write", "artifacts:delete"] })
    ).token.id;
    const published = value(await publish(id, t.id));
    const artifact = await row(published.artifactId);
    expect(artifact?.ownerId).toBe(t.id);
    expect(artifact?.createdBy).toBe(id);
    const [version] = await db()
      .select({ authorId: schema.versions.authorId })
      .from(schema.versions)
      .where(eq(schema.versions.id, published.versionId));
    expect(version?.authorId).toBe(id);
    const actor = value(await resolveOwnerScope(db().global, id, undefined));
    const page = value(await listArtifacts(db(), { actor, limit: 50, now: NOW }));
    expect(page.items.map((item) => item.id)).toEqual([published.artifactId]);
    const usage = value(await getAccountUsage(db(), { actor, now: NOW }));
    expect(usage.plan.plan).toBe("team");
    expect(usage.publicAccessFrom).toBe(NOW + 15 * MINUTE);
    value(await renewArtifact(db(), { userId: id, artifactId: published.artifactId, now: NOW }));
    const versions = value(
      await listVersions(db(), {
        userId: id,
        artifactId: published.artifactId,
        now: NOW,
        limit: 10,
      }),
    );
    expect(versions.items).toHaveLength(1);
    const events = await db()
      .select({ actorId: schema.lifecycleEvents.actorId })
      .from(schema.lifecycleEvents)
      .where(eq(schema.lifecycleEvents.artifactId, published.artifactId));
    expect(events.map((event) => event.actorId)).toContain(id);
    expect(
      value(
        await deleteArtifact(db(), env.ARTIFACTS, {
          userId: id,
          artifactId: published.artifactId,
          now: NOW,
        }),
      ).state,
    ).toBe("deleted");
  });

  it("gets exactly the missing answer on another workspace's artifact", async () => {
    const [a, b] = [await team(), await team()];
    const id = (await token(a)).token.id;
    const theirs = value(await publish(b.admin.id, b.id));
    const missing = await getArtifact(db(), { userId: id, artifactId: MISSING_ID });
    expect(await getArtifact(db(), { userId: id, artifactId: theirs.artifactId })).toEqual(missing);
    expect(
      await publish(id, b.id, { artifactId: theirs.artifactId, baseVersionId: theirs.versionId }),
    ).toEqual({ ok: false, code: "not_found", message: "Artifact not found." });
    expect(await publish(id, b.id)).toMatchObject({ ok: false, code: "not_found" });
    // Its creator's personal space is another owner too.
    expect(await publish(id, a.admin.id)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("is refused what needs a person or more than its allowlist", async () => {
    const t = await team();
    const created = await token(t, {
      scopes: ["artifacts:read", "artifacts:write", "artifacts:share"],
    });
    const id = created.token.id;
    const published = value(await publish(t.admin.id, t.id));
    const forbidden = { ok: false, code: "forbidden" };
    // Comments: no part at all, like a missing artifact.
    expect(
      await createAnnotationThread(db(), {
        userId: id,
        artifactId: published.artifactId,
        versionId: published.versionId,
        target: DOC,
        body: "From CI",
        humanCheck: { token: "solved", verify: async () => "passed" },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    // Reading as a signed-in person.
    expect(
      await checkReadAccess(db(), { artifactId: published.artifactId, userId: id, now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
    // Transfers, the access log and custom domains.
    expect(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: id,
        artifactId: published.artifactId,
        workspace: null,
        now: NOW,
      }),
    ).toMatchObject(forbidden);
    const regions = regionsFromEnv(env);
    expect(
      await getAccessLog(db(), regions.get("default").accessDb as AccessDb, {
        userId: id,
        artifactId: published.artifactId,
        limit: 10,
        now: NOW,
      }),
    ).toMatchObject(forbidden);
    expect(
      await addCustomDomain(regions, null, {
        userId: id,
        artifactId: published.artifactId,
        hostname: "docs.example.com",
        contentDomain: "portifact.dev",
        now: NOW,
      }),
    ).toMatchObject(forbidden);
  });

  it("shows the readers' addresses only to a token that may manage them", async () => {
    const t = await team();
    const published = value(await publish(t.admin.id, t.id));
    value(
      await updateAccess(db(), {
        userId: t.admin.id,
        artifactId: published.artifactId,
        change: {
          addReaders: ["reader@example.test"],
          readerCommentVisibility: [{ email: "reader@example.test", commentVisibility: "own" }],
        },
        now: NOW,
      }),
    );
    const read = (userId: string) =>
      getAccess(db(), { userId, artifactId: published.artifactId }).then(value);
    const readOnly = await token(t, { scopes: ["artifacts:read"] });
    expect(await read(readOnly.token.id)).toMatchObject({
      mode: "restricted",
      readers: [],
      readerCommentVisibility: [],
    });
    const sharing = await token(t, { scopes: ["artifacts:read", "artifacts:share"] });
    const full = {
      readers: ["reader@example.test"],
      readerCommentVisibility: [{ email: "reader@example.test", commentVisibility: "own" }],
    };
    expect(await read(sharing.token.id)).toMatchObject(full);
    expect(await read(t.editor.id)).toMatchObject(full);
  });

  it("never changes who sees comments, and still manages readers", async () => {
    const t = await team();
    const created = await token(t, { scopes: ["artifacts:read", "artifacts:share"] });
    const published = value(await publish(t.admin.id, t.id));
    const change = (change: Parameters<typeof updateAccess>[1]["change"]) =>
      updateAccess(db(), {
        userId: created.token.id,
        artifactId: published.artifactId,
        change,
        now: NOW,
      });
    expect(value(await change({ addReaders: ["reader@example.test"] })).readers).toEqual([
      "reader@example.test",
    ]);
    const forbidden = { ok: false, code: "forbidden" };
    expect(await change({ commentVisibility: "everyone" })).toMatchObject(forbidden);
    expect(
      await change({
        readerCommentVisibility: [{ email: "reader@example.test", commentVisibility: "all" }],
      }),
    ).toMatchObject(forbidden);
    expect((await row(published.artifactId))?.commentVisibility).toBe("owner");
    const [reader] = await db()
      .select()
      .from(schema.artifactReaders)
      .where(eq(schema.artifactReaders.artifactId, published.artifactId));
    expect(reader?.commentVisibility).toBeNull();
  });

  it("makes an artifact public only once the token is 15 minutes old", async () => {
    const t = await team();
    const fresh = await token(t, { scopes: ["artifacts:share", "artifacts:write"] });
    const published = value(await publish(t.admin.id, t.id));
    const change = (now: number) =>
      updateAccess(db(), {
        userId: fresh.token.id,
        artifactId: published.artifactId,
        change: { mode: "public" },
        now,
      });
    expect(await change(NOW + MINUTE)).toMatchObject({
      ok: false,
      code: "account_too_new_for_public",
    });
    expect((await change(NOW + 16 * MINUTE)).ok).toBe(true);
  });
});

describe("restrictions", () => {
  it("reaches only what an `own` token created", async () => {
    const t = await team();
    const id = (await token(t, { restriction: { kind: "own" } })).token.id;
    const mine = value(await publish(id, t.id));
    const theirs = value(await publish(t.admin.id, t.id));
    const missing = await getArtifact(db(), { userId: id, artifactId: MISSING_ID });
    expect((await getArtifact(db(), { userId: id, artifactId: mine.artifactId })).ok).toBe(true);
    expect(await getArtifact(db(), { userId: id, artifactId: theirs.artifactId })).toEqual(missing);
    expect(
      await renewArtifact(db(), { userId: id, artifactId: theirs.artifactId, now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await publish(id, t.id, { artifactId: theirs.artifactId, baseVersionId: theirs.versionId }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const actor = value(await resolveOwnerScope(db().global, id, undefined));
    const page = value(await listArtifacts(db(), { actor, limit: 50, now: NOW }));
    expect(page.items.map((item) => item.id)).toEqual([mine.artifactId]);
  });

  it("publishes only keys under a `key` token's prefix and reaches only those", async () => {
    const t = await team();
    const id = (await token(t, { restriction: { kind: "key", prefix: "pr_" } })).token.id;
    expect(await publish(id, t.id)).toEqual({
      ok: false,
      code: "forbidden",
      message: 'This service token publishes only with a key starting with "pr_".',
    });
    expect(await publish(id, t.id, { key: "docs" })).toMatchObject({ code: "forbidden" });
    const preview = value(await publish(id, t.id, { key: "pr_1" }));
    expect(value(await publish(id, t.id, { key: "pr_1" })).artifactId).toBe(preview.artifactId);
    // `_` is a character, not a wildcard.
    const lookalike = value(await publish(t.admin.id, t.id, { key: "prx1" }));
    const unkeyed = value(await publish(t.admin.id, t.id));
    const actor = value(await resolveOwnerScope(db().global, id, undefined));
    const page = value(await listArtifacts(db(), { actor, limit: 50, now: NOW }));
    expect(page.items.map((item) => item.id)).toEqual([preview.artifactId]);
    for (const other of [lookalike, unkeyed]) {
      expect(await getArtifact(db(), { userId: id, artifactId: other.artifactId })).toMatchObject({
        code: "not_found",
      });
    }
  });
});

describe("publish keys", () => {
  it("creates the artifact the first time and updates the same one after", async () => {
    const t = await team();
    const first = value(await publish(t.admin.id, t.id, { key: "pr-123" }));
    const second = value(await publish(t.editor.id, t.id, { key: "pr-123", now: NOW + MINUTE }));
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.versionNumber).toBe(2);
    expect((await row(first.artifactId))?.externalKey).toBe("pr-123");
    expect((await row(first.artifactId))?.createdBy).toBe(t.admin.id);
    const actor = value(await resolveOwnerScope(db().global, t.admin.id, t.slug));
    const found = value(
      await listArtifacts(db(), { actor, limit: 50, filters: { key: "pr-123" }, now: NOW }),
    );
    expect(found.items.map((item) => item.id)).toEqual([first.artifactId]);
    const none = value(
      await listArtifacts(db(), { actor, limit: 50, filters: { key: "pr-999" }, now: NOW }),
    );
    expect(none.items).toEqual([]);
  });

  it("makes one artifact of two concurrent first publishes", async () => {
    const t = await team();
    const text = "<p>race</p>";
    const input = {
      userId: t.admin.id,
      targetOwnerId: t.id,
      type: "site" as const,
      name: "Preview",
      entrypoint: "index.html",
      baseVersionId: null,
      files: await manifest(text),
      key: "pr-7",
      now: NOW,
    };
    let competing: string | undefined;
    const raced = racing(async () => {
      competing = value(await preparePublish(db(), input)).artifactId;
    });
    const second = value(await preparePublish(raced, input));
    expect(competing).toBeDefined();
    expect(second.artifactId).toBe(competing);
    expect(second.versionNumber).toBe(2);
    const rows = await db()
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.ownerId, t.id), eq(schema.artifacts.externalKey, "pr-7")));
    expect(rows).toHaveLength(1);
  });

  it("keeps the same key apart in two owners and releases it when the artifact is deleted", async () => {
    const [a, b] = [await team(), await team()];
    const inA = value(await publish(a.admin.id, a.id, { key: "main" }));
    const inB = value(await publish(b.admin.id, b.id, { key: "main" }));
    expect(inA.artifactId).not.toBe(inB.artifactId);
    value(
      await deleteArtifact(db(), env.ARTIFACTS, {
        userId: a.admin.id,
        artifactId: inA.artifactId,
        now: NOW,
      }),
    );
    const again = value(await publish(a.admin.id, a.id, { key: "main" }));
    expect(again.artifactId).not.toBe(inA.artifactId);
    expect(again.versionNumber).toBe(1);
  });

  it("refuses moving an artifact into a space that already publishes under its key", async () => {
    const t = await team();
    const inTeam = value(await publish(t.admin.id, t.id, { key: "main" }));
    const personal = value(await publish(t.admin.id, t.admin.id, { key: "main" }));
    const move = () =>
      transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId: personal.artifactId,
        workspace: t.slug,
        now: NOW,
      });
    expect(await move()).toMatchObject({ ok: false, code: "invalid_input" });
    expect((await row(personal.artifactId))?.ownerId).toBe(t.admin.id);
    expect((await row(inTeam.artifactId))?.ownerId).toBe(t.id);
    // Once the key is free in the target, the same move goes through and keeps the key.
    value(
      await deleteArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId: inTeam.artifactId,
        now: NOW,
      }),
    );
    expect(value(await move())).toMatchObject({ ownerId: t.id, externalKey: "main" });
  });

  it("works in a personal space too, and refuses bad keys and a key with an artifact ID", async () => {
    const person = await user();
    const first = value(await publish(person.id, person.id, { key: "notes/today" }));
    expect(value(await publish(person.id, person.id, { key: "notes/today" })).artifactId).toBe(
      first.artifactId,
    );
    for (const key of ["", "-x", "a b", "x".repeat(129), "ü"]) {
      expect(await publish(person.id, person.id, { key }), key).toMatchObject({
        ok: false,
        code: "invalid_input",
      });
    }
    expect(
      await publish(person.id, person.id, {
        key: "notes/today",
        artifactId: first.artifactId,
        baseVersionId: first.versionId,
      }),
    ).toEqual({
      ok: false,
      code: "invalid_input",
      message: "Send an artifact ID or a key, not both.",
    });
  });
});

describe("lifecycle of tokens", () => {
  it("removes a revoked token that a restore brought back", async () => {
    const t = await team();
    const revoked = await token(t);
    const kept = await token(t, { label: "Docs" });
    const [restored] = await db()
      .select()
      .from(schema.serviceTokens)
      .where(eq(schema.serviceTokens.id, revoked.token.id));
    value(
      await revokeServiceToken(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        tokenId: revoked.token.id,
        now: NOW,
      }),
    );
    const markers = await exportTombstones(db());
    // The restore rewinds the tombstone and brings the row back; re-applying removes it again.
    await db().delete(schema.tombstones).where(eq(schema.tombstones.id, revoked.token.id));
    await db()
      .insert(schema.serviceTokens)
      .values(restored as typeof schema.serviceTokens.$inferInsert);
    expect((await authenticateServiceToken(db().global, revoked.secret, NOW)).ok).toBe(true);
    const applied = await applyTombstones(db(), markers, NOW);
    expect(applied.serviceTokens).toBeGreaterThanOrEqual(1);
    expect((await authenticateServiceToken(db().global, revoked.secret, NOW)).ok).toBe(false);
    expect((await authenticateServiceToken(db().global, kept.secret, NOW)).ok).toBe(true);
  });

  it("removes the tokens of a deleted workspace that a restore brought back", async () => {
    const t = await team();
    const created = await token(t);
    await db().insert(schema.tombstones).values({ kind: "workspace", id: t.id, deletedAt: NOW });
    await applyTombstones(db(), [], NOW);
    expect((await authenticateServiceToken(db().global, created.secret, NOW)).ok).toBe(false);
  });

  it("lists a workspace's tokens in its admins' export, never a secret, and keeps them after the admin leaves", async () => {
    const t = await team();
    const created = await token(t);
    const exported = value(await exportAccount(db(), { userId: t.admin.id, now: NOW }));
    expect(exported.account.serviceTokens).toEqual([{ workspace: t.slug, token: created.token }]);
    expect(JSON.stringify(exported)).not.toContain(created.secret);
    const editorExport = value(await exportAccount(db(), { userId: t.editor.id, now: NOW }));
    expect(editorExport.account.serviceTokens).toEqual([]);
    expect(await exportServiceTokens(db().global, t.editor.id, NOW)).toEqual([]);

    // Another admin, so the first can delete their account; the token stays, without a creator.
    const second = await user("Second");
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: second.id, role: "admin", updatedAt: NOW });
    value(
      await requestAccountDeletion(db(), {
        userId: t.admin.id,
        sessionId: await session(t.admin.id),
        confirmEmail: t.admin.email,
        now: NOW,
      }),
    );
    const listing = value(
      await listServiceTokens(db().global, { userId: second.id, slug: t.slug, now: NOW }),
    );
    expect(listing.items[0]?.createdBy).toBeNull();
    expect((await authenticateServiceToken(db().global, created.secret, NOW)).ok).toBe(true);
  });

  it("lets the operator find a token from a leaked secret and revoke it", async () => {
    const t = await team();
    const created = await token(t);
    expect(await findServiceToken(db().global, `${created.secret}\n`)).toEqual({
      id: created.token.id,
      workspaceId: t.id,
      label: "CI previews",
      expiresAt: NOW + 30 * DAY,
    });
    expect(await findServiceToken(db().global, "not a secret")).toBeNull();
    expect(await findServiceToken(db().global, newServiceTokenSecret())).toBeNull();
    expect(await operatorRevokeServiceToken(db().global, created.token.id, NOW)).toBe(true);
    expect(await operatorRevokeServiceToken(db().global, created.token.id, NOW)).toBe(false);
    expect((await authenticateServiceToken(db().global, created.secret, NOW)).ok).toBe(false);
    expect(await exportTombstones(db())).toContainEqual({
      kind: "service_token",
      id: created.token.id,
      deletedAt: NOW,
    });
  });
});

describe("the audit log", () => {
  const audit = (ownerId: string) =>
    db()
      .global.select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, ownerId))
      .orderBy(schema.auditEvents.at, schema.auditEvents.id);
  const log = async (t: Team) =>
    value(
      await getAuditLog(db(), {
        actor: { userId: t.admin.id, ownerId: t.id, role: "admin", region: "default" },
        filters: {},
        limit: 50,
        now: NOW + DAY,
      }),
    ).events;

  it("records creating and revoking a token once, with what it may do and nothing secret", async () => {
    const t = await team();
    const created = await token(t, {
      label: "Nightly docs",
      scopes: ["artifacts:write", "artifacts:read"],
      restriction: { kind: "key", prefix: "docs/" },
    });
    const id = created.token.id;
    const revoke = (now: number) =>
      revokeServiceToken(db().global, { userId: t.admin.id, slug: t.slug, tokenId: id, now });
    value(await revoke(NOW + 1));
    expect(await revoke(NOW + 2)).toMatchObject({ ok: false, code: "not_found" });
    const rows = await audit(t.id);
    expect(
      rows.map((row) => [row.kind, row.actorType, row.actorId, row.targetId, row.detail]),
    ).toEqual([
      [
        "service_token.created",
        "user",
        t.admin.id,
        id,
        { scopes: ["artifacts:read", "artifacts:write"], restriction: "key", days: 30 },
      ],
      ["service_token.revoked", "user", t.admin.id, id, {}],
    ]);
    const stored = JSON.stringify(rows);
    for (const secret of [created.secret, "Nightly docs", "docs/"]) {
      expect(stored).not.toContain(secret);
    }
  });

  it("records nothing for a refused create or a token of another workspace", async () => {
    const [t, other, free] = [await team(), await team(), await team(null)];
    expect((await create(t.editor.id, t.slug)).ok).toBe(false);
    expect((await create(free.admin.id, free.slug)).ok).toBe(false);
    const theirs = await token(other);
    expect(
      await revokeServiceToken(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        tokenId: theirs.token.id,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(await audit(t.id)).toEqual([]);
    expect(await audit(free.id)).toEqual([]);
    expect((await audit(other.id)).map((row) => row.kind)).toEqual(["service_token.created"]);
  });

  it("records the operator's revocation as the operator's, and nothing for a token already gone", async () => {
    const t = await team();
    const created = await token(t);
    expect(await operatorRevokeServiceToken(db().global, created.token.id, NOW + 1)).toBe(true);
    expect(await operatorRevokeServiceToken(db().global, created.token.id, NOW + 2)).toBe(false);
    expect(
      (await audit(t.id)).map((row) => [row.kind, row.actorType, row.actorId, row.targetId]),
    ).toEqual([
      ["service_token.created", "user", t.admin.id, created.token.id],
      ["service_token.revoked", "operator", null, created.token.id],
    ]);
  });

  it("shows what a token did under its label while it exists, and as a revoked token after", async () => {
    const t = await team();
    const created = await token(t);
    const id = created.token.id;
    const published = value(await publish(id, t.id));
    const [stored] = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.artifactId, published.artifactId));
    expect(stored).toMatchObject({ kind: "artifact.published", actorType: "token", actorId: id });
    const named = { type: "service_token", id, label: "CI previews" };
    const before = await log(t);
    expect(before.find((event) => event.kind === "artifact.published")?.actor).toEqual(named);
    expect(before.find((event) => event.kind === "service_token.created")).toMatchObject({
      actor: { type: "member", id: t.admin.id },
      target: { type: "service_token", id, serviceToken: named },
    });
    value(
      await revokeServiceToken(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        tokenId: id,
        now: NOW + 1,
      }),
    );
    const gone = { type: "service_token", id, label: null };
    const after = await log(t);
    expect(after.find((event) => event.kind === "artifact.published")?.actor).toEqual(gone);
    expect(after.find((event) => event.kind === "service_token.revoked")?.target).toEqual({
      type: "service_token",
      id,
      serviceToken: gone,
    });
    // Filtering by the token's ID finds what it did.
    const byToken = value(
      await getAuditLog(db(), {
        actor: { userId: t.admin.id, ownerId: t.id, role: "admin", region: "default" },
        filters: { actor: id },
        limit: 50,
        now: NOW + DAY,
      }),
    ).events;
    expect(byToken.map((event) => event.kind)).toEqual(["artifact.published"]);
  });

  it("never lets a token read the audit log", async () => {
    const t = await team();
    const created = await token(t);
    const actor = value(await resolveActor(db().global, created.token.id, t.id));
    expect(await getAuditLog(db(), { actor, filters: {}, limit: 50, now: NOW })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });
});
